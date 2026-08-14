/**
 * Directory-scoped EXP store (leveling).
 *
 * Mirrors the Tauri Rust `directory_stats.rs`: cumulative `output_tokens` per
 * cwd is the user-facing EXP value, persisted to ~/.pixel-agents/directory-stats.json
 * (same format + atomic tmp+rename) so levels carry across restarts AND across
 * the Tauri→web migration. `credited_sessions` dedupes a session's historical
 * tokens so a relaunch doesn't recount records already baked into the totals.
 *
 * Singleton module state: one stats table per server process.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { sumOutputTokens } from './jsonl.js';

const SAVE_DEBOUNCE_MS = 1000;

// Lazily resolved so tests can override $HOME before first use.
function statsDir(): string {
  return path.join(os.homedir(), '.pixel-agents');
}
function statsFile(): string {
  return path.join(statsDir(), 'directory-stats.json');
}

interface PersistedStats {
  stats: Record<string, number>;
  credited_sessions: string[];
}

const stats = new Map<string, number>();
const creditedSessions = new Set<string>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Load persisted stats from disk into module state. Tolerates the legacy flat-map format. */
export function loadDirectoryStats(): void {
  stats.clear();
  creditedSessions.clear();
  let raw: string;
  try {
    raw = fs.readFileSync(statsFile(), 'utf8');
  } catch {
    return; // no file yet
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  const obj = parsed as Record<string, unknown>;
  if (obj.stats && typeof obj.stats === 'object') {
    // Current format: { stats, credited_sessions }
    for (const [k, v] of Object.entries(obj.stats as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) stats.set(k, v);
    }
    if (Array.isArray(obj.credited_sessions)) {
      for (const s of obj.credited_sessions) if (typeof s === 'string') creditedSessions.add(s);
    }
  } else {
    // Legacy: file was a flat { cwd: tokens } map. Re-credit happens once, then settles.
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && Number.isFinite(v)) stats.set(k, v);
    }
  }
}

/** Snapshot of all cwd→EXP totals (for the directoryExpAll boot message). */
export function getDirectoryStatsSnapshot(): Record<string, number> {
  return Object.fromEntries(stats);
}

export function getDirectoryExp(cwd: string): number {
  return stats.get(cwd) ?? 0;
}

/** Add a live token delta to a cwd's running total. Returns the new total. */
export function creditDirectoryTokens(cwd: string, tokens: number): number {
  if (!cwd || !Number.isFinite(tokens) || tokens <= 0) return stats.get(cwd) ?? 0;
  const next = (stats.get(cwd) ?? 0) + tokens;
  stats.set(cwd, next);
  scheduleSave();
  return next;
}

/**
 * Credit a transcript's historical output_tokens to its cwd, exactly once.
 * Deduped by the JSONL file path (unique per transcript — lead and teammate
 * agents can share a sessionId but never a file).
 *
 * `sumWholeFile` must be true ONLY when the agent was seeded at EOF (its live
 * JSONL pump will NOT replay existing lines). For agents seeded at offset 0
 * (e.g. teammates), pass false: the live pump credits the whole file, so we
 * just mark it credited here to prevent a later EOF-seeded restore from
 * re-summing on top of the already-credited live total.
 */
export function creditHistoricalSession(
  jsonlFile: string,
  cwd: string,
  sumWholeFile: boolean,
): number {
  if (!cwd || !jsonlFile) return cwd ? (stats.get(cwd) ?? 0) : 0;
  if (creditedSessions.has(jsonlFile)) return stats.get(cwd) ?? 0;
  creditedSessions.add(jsonlFile);
  if (!sumWholeFile) {
    scheduleSave();
    return stats.get(cwd) ?? 0;
  }
  const next = (stats.get(cwd) ?? 0) + sumOutputTokens(jsonlFile);
  stats.set(cwd, next);
  scheduleSave();
  return next;
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, SAVE_DEBOUNCE_MS);
  // Don't keep the event loop alive solely for a pending flush.
  saveTimer.unref?.();
}

/** Force an immediate synchronous write (e.g. on shutdown). */
export function flushDirectoryStats(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveNow();
}

function saveNow(): void {
  try {
    const dir = statsDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data: PersistedStats = {
      stats: Object.fromEntries(stats),
      credited_sessions: [...creditedSessions],
    };
    const file = statsFile();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[Pixel Agents] Failed to save directory-stats.json:', err);
  }
}

/** Test-only: reset in-memory state + cancel any pending save. */
export function __resetDirectoryStatsForTest(): void {
  stats.clear();
  creditedSessions.clear();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}
