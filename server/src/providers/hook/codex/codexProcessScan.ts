/**
 * Process-liveness scanning: enumerate running Codex CLI sessions and
 * resolve each to its rollout (transcript) file.
 *
 * Mirrors ../../../claudeProcessScan.ts: mtime-based scanners only adopt
 * transcripts written to recently, so an alive-but-idle Codex session -- a
 * rollout file gone quiet between turns, or a session whose SessionStart hook
 * fired at a previous server instance -- is invisible to them. This module
 * finds those by their running process instead.
 *
 * macOS / Linux only (uses `ps` + `lsof`). Returns [] on Windows or any error.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CODEX_SESSION_META_READ_BYTES } from './constants.js';

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

/** Open-file paths across all given pids (single batched `lsof` call),
 *  filtered to Codex rollout files. */
function openRolloutFiles(pids: number[]): string[] {
  if (pids.length === 0) return [];
  const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions') + path.sep;
  let out = '';
  try {
    out = execFileSync('lsof', ['-a', '-p', pids.join(','), '-Fn'], {
      encoding: 'utf8',
      timeout: 4000,
    });
  } catch (err) {
    // lsof exits non-zero when a pid vanishes mid-call but still prints the rest.
    const stdout = (err as { stdout?: string }).stdout;
    if (typeof stdout !== 'string') return [];
    out = stdout;
  }
  const files = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.startsWith('n')) continue;
    const file = line.slice(1);
    if (file.startsWith(sessionsRoot) && file.endsWith('.jsonl')) files.add(file);
  }
  return [...files];
}

/** Real ps+lsof enumeration of open Codex rollout files. Windows/errors -> [].
 *  Exported so tests can bypass it via `listLiveCodexSessions`'s injected
 *  lister instead of shelling out to real processes. */
export function listOpenCodexRolloutFiles(): string[] {
  if (process.platform === 'win32') return [];
  try {
    return openRolloutFiles(listCodexPids());
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

/**
 * Enumerate live Codex sessions: running `codex` processes -> their open
 * rollout files -> each file's session_meta. `listRolloutFiles` defaults to
 * the real ps+lsof enumeration; tests inject a fake to avoid depending on
 * real processes.
 */
export function listLiveCodexSessions(
  listRolloutFiles: () => string[] = listOpenCodexRolloutFiles,
): LiveCodexSession[] {
  let files: string[];
  try {
    files = listRolloutFiles();
  } catch {
    return [];
  }
  const sessions: LiveCodexSession[] = [];
  for (const file of files) {
    const meta = readCodexSessionMeta(file);
    if (!meta) continue;
    sessions.push({ sessionId: meta.sessionId, rolloutFile: file, cwd: meta.cwd });
  }
  return sessions;
}
