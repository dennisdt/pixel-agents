/**
 * Process-liveness scanning: enumerate running Codex CLI sessions and
 * resolve each to its rollout (transcript) file.
 *
 * Mirrors ../../../claudeProcessScan.ts in spirit: mtime-based scanners only
 * adopt transcripts written to recently, so an alive-but-idle Codex session --
 * a rollout gone quiet between turns, or a session whose SessionStart hook
 * fired at a previous server instance -- is invisible to them. This module
 * finds those by their running process instead.
 *
 * Strategy (Wave 4 FIX 7): codex does NOT hold its rollout open between
 * events -- it appends and closes, so `lsof`'s open-file list shows zero
 * rollout handles for an idle process (verified live). Instead, each live
 * codex process is resolved via its WORKING DIRECTORY (`lsof -d cwd`, which
 * does return a row), then matched to the newest recent rollout whose
 * first-line session_meta `payload.cwd` equals that directory.
 *
 * macOS / Linux only (uses `ps` + `lsof`). Returns [] on Windows or any error.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CODEX_SESSION_META_READ_BYTES, CODEX_SESSIONS_SCAN_DAYS } from './constants.js';

export interface LiveCodexSession {
  sessionId: string;
  /** Codex rollout file (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). */
  rolloutFile: string;
  cwd: string;
}

/** Every running process whose executable basename is `codex`. */
function listCodexPids(): number[] {
  const out = execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8', timeout: 4000 });
  const pids: number[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    if (path.basename(m[2].trim()) === 'codex') pids.push(parseInt(m[1], 10));
  }
  return pids;
}

/** Working directories of the given pids, via a single batched `lsof` call
 *  (same approach as claudeProcessScan's cwdsForPids). */
function cwdsForPids(pids: number[]): string[] {
  if (pids.length === 0) return [];
  let out = '';
  try {
    out = execFileSync('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn'], {
      encoding: 'utf8',
      timeout: 4000,
    });
  } catch (err) {
    // lsof exits non-zero when a pid vanishes mid-call but still prints the rest.
    const stdout = (err as { stdout?: string }).stdout;
    if (typeof stdout !== 'string') return [];
    out = stdout;
  }
  const cwds: string[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('n')) cwds.push(line.slice(1));
  }
  return cwds;
}

/** Real ps+lsof enumeration of live codex processes' working directories.
 *  Windows/errors -> []. Exported so tests can bypass it via
 *  `listLiveCodexSessions`'s injected lister instead of shelling out. */
export function listCodexProcessCwds(): string[] {
  if (process.platform === 'win32') return [];
  try {
    return cwdsForPids(listCodexPids());
  } catch {
    return [];
  }
}

interface CodexSessionMeta {
  sessionId: string;
  cwd: string;
}

/**
 * Read a Codex rollout file's first line -- a `session_meta` record shaped
 * like `{"timestamp":...,"type":"session_meta","payload":{"session_id":"...",
 * "cwd":"...",...}}` -- and pull out `payload.session_id` / `payload.cwd`.
 * Malformed or unreadable -> null.
 */
export function readCodexSessionMeta(rolloutFile: string): CodexSessionMeta | null {
  let firstLine: string;
  try {
    const fd = fs.openSync(rolloutFile, 'r');
    try {
      const buf = Buffer.alloc(CODEX_SESSION_META_READ_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      const chunk = buf.toString('utf8', 0, bytesRead);
      const nl = chunk.indexOf('\n');
      firstLine = nl === -1 ? chunk : chunk.slice(0, nl);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  if (!firstLine.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.type !== 'session_meta') return null;
  const payload = rec.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.session_id !== 'string' || typeof p.cwd !== 'string') return null;
  return { sessionId: p.session_id, cwd: p.cwd };
}

function defaultSessionsRoot(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

/** Rollout files in the last CODEX_SESSIONS_SCAN_DAYS date dirs, newest mtime
 *  first. Bounded walk: see CODEX_SESSIONS_SCAN_DAYS for the tradeoff. */
function listRecentRollouts(sessionsRoot: string): string[] {
  const files: Array<{ file: string; mtimeMs: number }> = [];
  for (let daysAgo = 0; daysAgo < CODEX_SESSIONS_SCAN_DAYS; daysAgo++) {
    const d = new Date(Date.now() - daysAgo * 86_400_000);
    const dir = path.join(
      sessionsRoot,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    );
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue; // date dir doesn't exist (no sessions that day)
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (st.isFile()) files.push({ file, mtimeMs: st.mtimeMs });
      } catch {
        /* ignore unreadable entries */
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.map((f) => f.file);
}

/**
 * Enumerate live Codex sessions: running `codex` processes -> their working
 * directories -> the newest recent rollout whose session_meta cwd matches.
 * `listProcessCwds` defaults to the real ps+lsof enumeration and
 * `sessionsRoot` to ~/.codex/sessions; tests inject both so they never
 * depend on real processes or the real home directory.
 */
export function listLiveCodexSessions(
  listProcessCwds: () => string[] = listCodexProcessCwds,
  sessionsRoot: string = defaultSessionsRoot(),
): LiveCodexSession[] {
  let cwds: string[];
  try {
    cwds = listProcessCwds();
  } catch {
    return [];
  }
  if (cwds.length === 0) return [];

  const rollouts = listRecentRollouts(sessionsRoot); // newest-first
  if (rollouts.length === 0) return [];

  // Each rollout's meta is read at most once per scan, even when several
  // process cwds walk the same list.
  const metaCache = new Map<string, CodexSessionMeta | null>();
  const sessions: LiveCodexSession[] = [];
  const seenFiles = new Set<string>();

  for (const cwd of new Set(cwds)) {
    for (const file of rollouts) {
      let meta = metaCache.get(file);
      if (meta === undefined) {
        meta = readCodexSessionMeta(file);
        metaCache.set(file, meta);
      }
      if (!meta || meta.cwd !== cwd) continue;
      // Newest rollout for this cwd (list is newest-first). Two processes in
      // the same cwd resolve to the same session -- dedupe by file.
      if (!seenFiles.has(file)) {
        seenFiles.add(file);
        sessions.push({ sessionId: meta.sessionId, rolloutFile: file, cwd: meta.cwd });
      }
      break;
    }
  }
  return sessions;
}
