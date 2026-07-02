import { DatabaseSync } from 'node:sqlite';

import { execFileSync } from 'child_process';

import {
  HERMES_ACTIVE_THRESHOLD_MS,
  HERMES_HOLDERS_CACHE_MS,
  HERMES_INACTIVITY_TIMEOUT_MS,
  HERMES_MAX_ROWS_PER_TICK,
  HERMES_PERSONA_BUCKET_PREFIX,
  HERMES_POLL_INTERVAL_MS,
} from './constants.js';

export interface HermesPollerOptions {
  dbPath: string;
  /** Feed a synthesized Claude-shaped envelope into runtime.handleHookEvent. */
  onEvent: (providerId: 'hermes', envelope: Record<string, unknown>) => void;
  /** Task 10: find an existing agent id for a persona key, or undefined. */
  resolvePersonaAgent: (personaKey: string) => number | undefined;
  /** Task 10: re-point an existing agent to a new session id. */
  reattachSession: (agentId: number, newSessionId: string) => void;
  /**
   * True when a process OTHER than this server holds the Hermes db open (e.g.
   * QuantBot/Hermes's own agent process) -- evidence that a live-flagged
   * session is genuinely still running even with no recent message rows.
   * When present, `bootstrap()` additionally adopts the newest live session
   * per persona regardless of message age, and `reapEnded()` protects those
   * sessions from inactivity-based reaping while a holder still exists.
   * Defaults to `createDefaultHasForeignDbHolders(dbPath)` (a real
   * `lsof -t <dbPath>` check) when omitted.
   */
  hasForeignDbHolders?: () => boolean;
}

/**
 * Real `lsof -t <dbPath>` implementation of `hasForeignDbHolders`, used
 * automatically by HermesPoller when the option is omitted. Exported so
 * callers can wire it explicitly too. Caches its result for
 * HERMES_HOLDERS_CACHE_MS since the poller may call it every tick
 * (HERMES_POLL_INTERVAL_MS = 1s) while any session is process-backed.
 */
export function createDefaultHasForeignDbHolders(dbPath: string): () => boolean {
  let cache: { result: boolean; expiresAt: number } | null = null;
  return () => {
    const now = Date.now();
    if (cache && cache.expiresAt > now) return cache.result;
    let result = false;
    try {
      const out = execFileSync('lsof', ['-t', dbPath], { encoding: 'utf8', timeout: 4000 });
      result = out
        .split('\n')
        .map((line) => parseInt(line.trim(), 10))
        .filter((pid) => !Number.isNaN(pid))
        .some((pid) => pid !== process.pid);
    } catch {
      result = false; // lsof missing / no holders / db path gone — treat as none
    }
    cache = { result, expiresAt: now + HERMES_HOLDERS_CACHE_MS };
    return result;
  };
}

interface SessionRow {
  id: string;
  source: string;
  cwd: string | null;
  ended_at: number | null;
}
// Exported so a test subclass can type-check a `processRow` override (see
// hermesPoller.test.ts's row-failure seam).
export interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  finish_reason: string | null;
  timestamp: number;
}

export function personaKey(source: string, cwd: string | null): string {
  return `${source}:${cwd ?? ''}`;
}

/** True when the sessions row has a persisted end (checked via `!== null &&
 *  !== undefined` rather than `!=` for eqeqeq compliance). Shared by
 *  `ensureSession` (skip announcing already-ended sessions) and `reapEnded`
 *  (detect newly-ended sessions). */
function isSessionEnded(row: { ended_at: number | null } | undefined): boolean {
  return row?.ended_at !== null && row?.ended_at !== undefined;
}

export class HermesPoller {
  private db: DatabaseSync | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  // `protected` (not `private`) so a test subclass can assert cursor position
  // around a simulated row-processing failure (see hermesPoller.test.ts).
  protected cursor = -1; // -1 = first tick pending
  /** Sessions we've announced, with last-activity for inactivity reaping. */
  private readonly known = new Map<string, { lastActivityMs: number }>();
  /** Session ids confirmed alive by a foreign DB holder process at bootstrap
   *  (see `bootstrap()`). `reapEnded()` skips inactivity-reaping these while
   *  `hasForeignDbHolders()` still returns true. */
  private readonly processBacked = new Set<string>();
  private readonly hasForeignDbHolders: () => boolean;

  constructor(private readonly opts: HermesPollerOptions) {
    this.hasForeignDbHolders =
      opts.hasForeignDbHolders ?? createDefaultHasForeignDbHolders(opts.dbPath);
  }

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), HERMES_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.db?.close();
    this.db = null;
  }

  private open(): DatabaseSync | null {
    if (this.db) return this.db;
    try {
      this.db = new DatabaseSync(this.opts.dbPath, { readOnly: true });
      return this.db;
    } catch {
      return null; // hermes not installed / db locked — retry next tick
    }
  }

  tick(): void {
    let db: DatabaseSync | null;
    try {
      db = this.open();
      if (!db) return;

      if (this.cursor === -1) {
        this.bootstrap(db);
        return;
      }

      const rows = db
        .prepare(
          `SELECT id, session_id, role, tool_calls, tool_call_id, tool_name, finish_reason, timestamp
           FROM messages WHERE id > ? ORDER BY id LIMIT ?`,
        )
        .all(this.cursor, HERMES_MAX_ROWS_PER_TICK) as unknown as MessageRow[];

      for (const row of rows) {
        // Process fully BEFORE advancing the cursor. If processRow throws (e.g. a
        // WAL checkpoint race), the loop unwinds into the outer catch below without
        // recording this row's id, so a retried tick re-reads and reprocesses it
        // instead of permanently skipping it. Rows already advanced past are not
        // re-emitted since the query is `id > cursor`.
        this.processRow(db, row);
        this.cursor = row.id;
      }

      this.reapEnded(db);
    } catch {
      // Read failure (WAL checkpoint race, etc.) — drop the connection and retry.
      this.db?.close();
      this.db = null;
    }
  }

  /** First tick: cursor to MAX(id) (never replay history), adopt live+recent sessions. */
  private bootstrap(db: DatabaseSync): void {
    const max = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages').get() as
      { m: number } | undefined;
    this.cursor = max?.m ?? 0;
    // ORDER BY started_at DESC: the process-backed pass below relies on this
    // ordering to pick "newest per persona" via first-seen dedupe.
    const live = db
      .prepare(
        'SELECT id, source, cwd, ended_at FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC',
      )
      .all() as unknown as SessionRow[];
    const cutoffS = (Date.now() - HERMES_ACTIVE_THRESHOLD_MS) / 1000;
    for (const s of live) {
      const recent = db
        .prepare('SELECT 1 AS x FROM messages WHERE session_id = ? AND timestamp > ? LIMIT 1')
        .get(s.id, cutoffS);
      if (recent) this.announceSession(s);
    }

    // Process-backed bootstrap: a live-flagged session with no recent message
    // rows can still be genuinely alive (e.g. between turns, or waiting on a
    // long tool call) when a foreign process holds the db open. Adopt the
    // newest session per persona (source+cwd) regardless of message age, and
    // mark it processBacked so reapEnded() protects it from inactivity-reaping
    // while the holder still exists.
    let holders = false;
    try {
      holders = this.hasForeignDbHolders();
    } catch {
      holders = false;
    }
    if (holders) {
      const seenPersonas = new Set<string>();
      for (const s of live) {
        const key = personaKey(s.source, s.cwd);
        if (seenPersonas.has(key)) continue;
        seenPersonas.add(key);
        if (!this.known.has(s.id)) this.announceSession(s);
        this.processBacked.add(s.id);
      }
    }
  }

  /**
   * Process one message row: announce its session if unseen, emit the row's
   * synthesized event(s), and refresh the session's last-activity timestamp.
   * `protected` (not `private`) so a test subclass can override it to force a
   * failure on a specific row and verify `tick()`'s cursor-integrity behavior
   * without needing to corrupt the DB mid-read (see hermesPoller.test.ts).
   */
  protected processRow(db: DatabaseSync, row: MessageRow): void {
    this.ensureSession(db, row.session_id);
    this.emitForRow(row);
    const s = this.known.get(row.session_id);
    if (s) s.lastActivityMs = Date.now();
  }

  private ensureSession(db: DatabaseSync, sessionId: string): void {
    if (this.known.has(sessionId)) return;
    const s = db
      .prepare('SELECT id, source, cwd, ended_at FROM sessions WHERE id = ?')
      .get(sessionId) as unknown as SessionRow | undefined;
    if (!s) return;
    // Finding 2: trailing message rows can be processed after their session has
    // already ended (e.g. under HERMES_MAX_ROWS_PER_TICK backpressure, so the
    // row lags behind the session's ended_at). Announcing here would emit a
    // spurious SessionStart that reapEnded immediately follows with SessionEnd
    // in the same tick. Skip entirely: don't add to `known`, don't emit.
    if (isSessionEnded(s)) return;
    this.announceSession(s);
  }

  private announceSession(s: SessionRow): void {
    this.known.set(s.id, { lastActivityMs: Date.now() });
    // Persona continuity (Task 10): reattach to an existing character when the
    // persona (source+cwd) already has one; otherwise a fresh SessionStart.
    const existing = this.opts.resolvePersonaAgent(personaKey(s.source, s.cwd));
    if (existing !== undefined) {
      this.opts.reattachSession(existing, s.id);
      return;
    }
    this.opts.onEvent('hermes', {
      hook_event_name: 'SessionStart',
      session_id: s.id,
      source: 'external',
      cwd: s.cwd ?? undefined,
      persona_key: personaKey(s.source, s.cwd),
      // Display-name fallback for cwd-less sessions (the webui runs with cwd
      // NULL): there is no directory basename to name the character after, so
      // adoption falls back to the stable persona identifier instead.
      folder_hint: s.cwd ? undefined : HERMES_PERSONA_BUCKET_PREFIX + s.source,
    });
  }

  private emitForRow(row: MessageRow): void {
    if (row.role === 'assistant' && row.tool_calls) {
      let calls: Array<{ id?: string; function?: { name?: string; arguments?: string } }> = [];
      try {
        calls = JSON.parse(row.tool_calls) as typeof calls;
      } catch {
        /* malformed — skip */
      }
      for (const call of calls) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.function?.arguments ?? '{}');
        } catch {
          /* arguments not JSON — keep {} */
        }
        this.opts.onEvent('hermes', {
          hook_event_name: 'PreToolUse',
          session_id: row.session_id,
          tool_name: call.function?.name ?? '',
          tool_input: input,
          tool_call_id: call.id,
        });
      }
    }
    if (row.role === 'tool') {
      this.opts.onEvent('hermes', {
        hook_event_name: 'PostToolUse',
        session_id: row.session_id,
        tool_call_id: row.tool_call_id ?? undefined,
      });
    }
    if (row.role === 'assistant' && row.finish_reason === 'stop') {
      this.opts.onEvent('hermes', { hook_event_name: 'Stop', session_id: row.session_id });
    }
  }

  /** SessionEnd for rows with ended_at set, plus inactivity timeout. */
  private reapEnded(db: DatabaseSync): void {
    if (this.known.size === 0) return;
    const now = Date.now();
    // Only consult hasForeignDbHolders when it could actually matter (some
    // session is processBacked) -- the default implementation shells out to
    // lsof, and the injected fakes in tests don't need to be called every
    // tick otherwise.
    let holders = false;
    if (this.processBacked.size > 0) {
      try {
        holders = this.hasForeignDbHolders();
      } catch {
        holders = false;
      }
    }
    for (const [sessionId, meta] of this.known) {
      const s = db
        .prepare('SELECT ended_at, end_reason FROM sessions WHERE id = ?')
        .get(sessionId) as unknown as
        { ended_at: number | null; end_reason: string | null } | undefined;
      const endedInDb = isSessionEnded(s);
      // Skip INACTIVITY-reap (not ended_at-reap -- an explicit ended_at still
      // ends it) for processBacked sessions while a foreign holder still
      // exists. Once the holder disappears, normal inactivity rules resume.
      const protectedByHolder = this.processBacked.has(sessionId) && holders;
      const inactive =
        !protectedByHolder && now - meta.lastActivityMs > HERMES_INACTIVITY_TIMEOUT_MS;
      if (endedInDb || inactive) {
        this.known.delete(sessionId);
        this.processBacked.delete(sessionId);
        this.opts.onEvent('hermes', {
          hook_event_name: 'SessionEnd',
          session_id: sessionId,
          reason: endedInDb ? (s?.end_reason ?? 'ended') : 'stale',
        });
      }
    }
  }
}
