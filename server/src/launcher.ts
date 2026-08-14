/**
 * Launch-from-web: spawn `claude` on the host (into a tmux window) so a session
 * can be started from a phone over Tailscale, and list recent projects for the
 * picker. Ported from the Tauri Rust create_agent / list_recent_projects.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readCwdFromJsonl } from './jsonl.js';

/** Single shared tmux session; one window per launched agent. */
const TMUX_SESSION = 'work';
const MAX_RECENT_PROJECTS = 8;

function tmux(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, (err, _stdout, stderr) => {
      if (err)
        reject(new Error(`tmux ${args[0] ?? ''}: ${stderr?.toString().trim() || err.message}`));
      else resolve();
    });
  });
}

function tmuxHasSession(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('tmux', ['has-session', '-t', TMUX_SESSION], (err) => resolve(!err));
  });
}

/**
 * Spawn `claude --session-id <id>` in a new tmux window at `cwd`. The resulting
 * JSONL is adopted by the runtime (which watches the known path). Throws if tmux
 * is unavailable or a command fails.
 */
export async function launchClaudeInTmux(
  cwd: string,
  sessionId: string,
  bypass: boolean,
): Promise<void> {
  if (!(await tmuxHasSession())) {
    await tmux(['new-session', '-d', '-s', TMUX_SESSION, '-c', cwd]);
  }
  // Sanitize for tmux window names: ':' and '.' are target separators, and
  // whitespace breaks the `-t session:window` selector in send-keys.
  const base = (path.basename(cwd) || 'agent').replace(/[^a-zA-Z0-9_-]/g, '-');
  const windowName = `${base}-${sessionId.slice(0, 8)}`;
  await tmux(['new-window', '-t', TMUX_SESSION, '-c', cwd, '-n', windowName]);
  const flags = bypass ? ' --dangerously-skip-permissions' : '';
  const cmd = `claude --session-id ${sessionId}${flags}`;
  await tmux(['send-keys', '-t', `${TMUX_SESSION}:${windowName}`, cmd, 'Enter']);
}

export interface RecentProject {
  hash: string;
  displayName: string;
  fullPath: string | null;
  lastUsed: number;
}

/** Recent projects from ~/.claude/projects, newest JSONL first. */
export function listRecentProjects(max = MAX_RECENT_PROJECTS): RecentProject[] {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: Array<{ hash: string; dir: string; lastUsed: number }> = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(projectsDir, e.name);
    const newest = newestJsonl(dir);
    if (!newest) continue;
    candidates.push({ hash: e.name, dir, lastUsed: newest.mtimeSec });
  }
  candidates.sort((a, b) => b.lastUsed - a.lastUsed);

  return candidates.slice(0, max).map(({ hash, dir, lastUsed }) => {
    const cwd = readCwdFromNewestJsonl(dir);
    const fullPath = cwd && fs.existsSync(cwd) ? cwd : null;
    return {
      hash,
      displayName: fullPath ? displayNameFromPath(fullPath) : fallbackName(hash),
      fullPath,
      lastUsed,
    };
  });
}

function newestJsonl(dir: string): { file: string; mtimeSec: number } | null {
  let best: { file: string; mtimeSec: number } | null = null;
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const file = path.join(dir, f);
    try {
      const sec = Math.floor(fs.statSync(file).mtimeMs / 1000);
      if (!best || sec > best.mtimeSec) best = { file, mtimeSec: sec };
    } catch {
      /* skip */
    }
  }
  return best;
}

function readCwdFromNewestJsonl(dir: string): string | undefined {
  const newest = newestJsonl(dir);
  return newest ? readCwdFromJsonl(newest.file) : undefined;
}

/** Last two path components (e.g. "telvana/pipecat"); "~" for home. */
function displayNameFromPath(p: string): string {
  const home = os.homedir();
  if (p === home) return '~';
  const name = path.basename(p);
  const parent = path.basename(path.dirname(p));
  return parent ? `${parent}/${name}` : name;
}

/** Best-effort label when the real cwd can't be read from JSONL. */
function fallbackName(dashed: string): string {
  const parts = dashed.split('-').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : dashed;
}
