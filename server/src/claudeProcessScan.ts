/**
 * Process-liveness scanning: enumerate running Claude Code CLI sessions and
 * resolve each to its active transcript file.
 *
 * The mtime-based scanners only adopt sessions written to recently, so an
 * alive-but-idle session (a `claude` waiting for input in tmux, hours since its
 * last write) is invisible to them. This module finds those by their running
 * process instead — exactly the sessions a user expects to see.
 *
 * macOS / Linux only (uses `ps` + `lsof`). Returns [] on Windows or any error.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';

export interface LiveClaudeSession {
  pid: number;
  cwd: string;
  /** Newest transcript in the session's project dir (the one `claude --continue` resumes). */
  jsonlFile: string;
  sessionId: string;
}

/** Every running process whose executable basename is `claude`. */
function listClaudePids(): number[] {
  const out = execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8', timeout: 4000 });
  const pids: number[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    if (path.basename(m[2].trim()) === 'claude') pids.push(parseInt(m[1], 10));
  }
  return pids;
}

/** pid → working directory, via a single batched `lsof` call. */
function cwdsForPids(pids: number[]): Map<number, string> {
  const byPid = new Map<number, string>();
  if (pids.length === 0) return byPid;
  let out = '';
  try {
    out = execFileSync('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn'], {
      encoding: 'utf8',
      timeout: 4000,
    });
  } catch (err) {
    // lsof exits non-zero when a pid vanishes mid-call but still prints the rest.
    const stdout = (err as { stdout?: string }).stdout;
    if (typeof stdout !== 'string') return byPid;
    out = stdout;
  }
  let cur = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) cur = parseInt(line.slice(1), 10);
    else if (line.startsWith('n') && cur) byPid.set(cur, line.slice(1));
  }
  return byPid;
}

/** Newest *.jsonl directly inside a project dir, or null if none. */
function newestTranscript(projectDir: string): string | null {
  let best: { file: string; mtime: number } | null = null;
  let names: string[];
  try {
    names = fs.readdirSync(projectDir);
  } catch {
    return null; // no project dir yet
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(projectDir, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      if (!best || st.mtimeMs > best.mtime) best = { file, mtime: st.mtimeMs };
    } catch {
      /* ignore unreadable entries */
    }
  }
  return best?.file ?? null;
}

export function listLiveClaudeSessions(): LiveClaudeSession[] {
  if (process.platform === 'win32') return [];
  let pids: number[];
  try {
    pids = listClaudePids();
  } catch {
    return [];
  }
  const cwds = cwdsForPids(pids);
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');

  const sessions: LiveClaudeSession[] = [];
  const seen = new Set<string>();
  for (const [pid, cwd] of cwds) {
    const jsonlFile = newestTranscript(path.join(projectsRoot, normalizeProjectPath(cwd)));
    if (!jsonlFile || seen.has(jsonlFile)) continue;
    seen.add(jsonlFile);
    sessions.push({ pid, cwd, jsonlFile, sessionId: path.basename(jsonlFile, '.jsonl') });
  }
  return sessions;
}
