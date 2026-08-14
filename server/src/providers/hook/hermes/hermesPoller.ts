import { DatabaseSync } from 'node:sqlite';

import { execFileSync } from 'child_process';

import { creditDirectoryTokens } from '../../../directoryStats.js';
import {
  HERMES_AGENT_DISPLAY_NAME,
  HERMES_EXP_BUCKET,
  HERMES_HOLDERS_CACHE_MS,
  HERMES_MAX_ROWS_PER_TICK,
  HERMES_POLL_INTERVAL_MS,
  HERMES_QUANTBOT_SESSION_ID,
} from './constants.js';

export interface HermesPollerOptions {
  dbPath: string;
  /** Feed a synthesized Claude-shaped envelope into runtime.handleHookEvent. */
  onEvent: (providerId: 'hermes', envelope: Record<string, unknown>) => void;
  /**
   * True when a process OTHER than this server holds the Hermes db open (e.g.
   * QuantBot/Hermes's own agent process). This is the SOLE liveness signal
   * for the single synthetic QuantBot character (see the class doc comment)
   * -- never `sessions.ended_at`, which Hermes almost never sets.
   */
  hasForeignDbHolders: () => boolean;
  /** Called after an output-token delta is credited to HERMES_EXP_BUCKET via
   *  directoryStats. Wire to a `directoryExp` broadcast so the webview levels
   *  QuantBot live. (No `agentTokenUsage` counterpart: that message is keyed
   *  by agent id, which the poller doesn't know — directoryExp is what drives
   *  leveling.) */
  onDirectoryExp?: (directory: string, totalExp: number) => void;
}

/**
 * Real `lsof -t <dbPath>` implementation of `hasForeignDbHolders`. Exported so
 * callers (cli.ts) can wire it explicitly. Caches its result for
 * HERMES_HOLDERS_CACHE_MS since the poller calls it every tick
 * (HERMES_POLL_INTERVAL_MS = 1s) for as long as the Hermes stack is up.
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

/**
 * Fan-in aggregator over ~/.hermes/state.db. Hermes on this machine is
 * single-user, single-agent: the webui, cli, and a2a/bridge/gateway plumbing
 * are all front-ends onto the SAME agent and memory. Rather than minting one
 * office character per (source, cwd) session context, this poller presents
 * ALL of it as ONE synthetic "QuantBot" character (HERMES_QUANTBOT_SESSION_ID).
 *
 * Existence is gated purely on `hasForeignDbHolders()`. Every envelope emitted
 * for a real message row has its `session_id` rewritten to the synthetic id,
 * so tool/turn activity from any real session animates the single character.
 * Real session ids are still tracked internally (see `sessionOutputTokens`)
 * purely for output-token EXP crediting, which pools into one bucket.
 */
export class HermesPoller {
  private db: DatabaseSync | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  // `protected` (not `private`) so a test subclass can assert cursor position
  // around a simulated row-processing failure (see hermesPoller.test.ts).
  protected cursor = -1; // -1 = first tick pending
  /** Per real Hermes session that has produced a row since boot: last-seen
   *  CUMULATIVE sessions.output_tokens (null = baseline pending; the first
   *  observation never credits). All sessions pool into the single
   *  HERMES_EXP_BUCKET, since they're all the same QuantBot agent. */
  private readonly sessionOutputTokens = new Map<string, number | null>();
  /** False once an output_tokens query fails: older hermes DBs predate the
   *  column, and retrying the failing prepare every tick would be wasted work. */
  private hasOutputTokensColumn = true;
  /** Mirrors the last-seen `hasForeignDbHolders()` result, so tick() can
   *  detect a present<->absent transition and emit SessionStart/SessionEnd
   *  exactly once per flip. */
  private holdersPresent = false;

  constructor(private readonly opts: HermesPollerOptions) {}

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
    try {
      const db = this.open();
      if (!db) return;

      if (this.cursor === -1) {
        this.bootstrap(db);
        return;
      }

      this.updateLiveness();

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
        this.processRow(row);
        this.cursor = row.id;
      }

      this.creditExp(db);
    } catch {
      // Read failure (WAL checkpoint race, etc.) — drop the connection and retry.
      this.db?.close();
      this.db = null;
    }
  }

  /** First tick: cursor to MAX(id) (never replay history), then announce
   *  QuantBot once if the Hermes stack is already up. */
  private bootstrap(db: DatabaseSync): void {
    const max = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages').get() as
      { m: number } | undefined;
    this.cursor = max?.m ?? 0;

    this.holdersPresent = this.safeHasForeignDbHolders();
    if (this.holdersPresent) this.announceQuantBot();
  }

  private safeHasForeignDbHolders(): boolean {
    try {
      return this.opts.hasForeignDbHolders();
    } catch {
      return false;
    }
  }

  /** Detect a present<->absent flip in `hasForeignDbHolders()` since the last
   *  tick. QuantBot despawns (SessionEnd) when the Hermes stack stops, and
   *  re-announces (SessionStart) when it comes back -- idempotent, since the
   *  handler no-ops a SessionStart for an already-known session id. */
  private updateLiveness(): void {
    const holders = this.safeHasForeignDbHolders();
    if (holders === this.holdersPresent) return;
    this.holdersPresent = holders;
    if (holders) {
      this.announceQuantBot();
    } else {
      this.opts.onEvent('hermes', {
        hook_event_name: 'SessionEnd',
        session_id: HERMES_QUANTBOT_SESSION_ID,
      });
    }
  }

  private announceQuantBot(): void {
    this.opts.onEvent('hermes', {
      hook_event_name: 'SessionStart',
      session_id: HERMES_QUANTBOT_SESSION_ID,
      source: 'external',
      confirmed: true,
      persona_key: 'quantbot',
      folder_hint: HERMES_AGENT_DISPLAY_NAME,
      exp_bucket: HERMES_EXP_BUCKET,
    });
  }

  /**
   * Process one message row: register its real session for output-token EXP
   * tracking (if unseen since boot) and emit the row's synthesized event(s),
   * fanned into the single QuantBot session id. `protected` (not `private`)
   * so a test subclass can override it to force a failure on a specific row
   * and verify `tick()`'s cursor-integrity behavior without needing to
   * corrupt the DB mid-read (see hermesPoller.test.ts).
   */
  protected processRow(row: MessageRow): void {
    if (!this.sessionOutputTokens.has(row.session_id)) {
      this.sessionOutputTokens.set(row.session_id, null);
    }
    this.emitForRow(row);
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
          session_id: HERMES_QUANTBOT_SESSION_ID,
          tool_name: call.function?.name ?? '',
          tool_input: input,
          tool_call_id: call.id,
        });
      }
    }
    if (row.role === 'tool') {
      this.opts.onEvent('hermes', {
        hook_event_name: 'PostToolUse',
        session_id: HERMES_QUANTBOT_SESSION_ID,
        tool_call_id: row.tool_call_id ?? undefined,
      });
    }
    if (row.role === 'assistant' && row.finish_reason === 'stop') {
      this.opts.onEvent('hermes', {
        hook_event_name: 'Stop',
        session_id: HERMES_QUANTBOT_SESSION_ID,
      });
    }
  }

  /** Defensive read of a real session's CUMULATIVE output_tokens counter.
   *  Returns null once the column is confirmed absent (older hermes DBs) so a
   *  permanently-failing prepare isn't retried every tick. */
  private readOutputTokens(db: DatabaseSync, sessionId: string): number | null {
    if (!this.hasOutputTokensColumn) return null;
    try {
      const row = db.prepare('SELECT output_tokens FROM sessions WHERE id = ?').get(sessionId) as
        { output_tokens: number | null } | undefined;
      const tokens = row?.output_tokens;
      return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : null;
    } catch {
      this.hasOutputTokensColumn = false;
      return null;
    }
  }

  /**
   * Output-token EXP: sessions.output_tokens is CUMULATIVE per real session.
   * First observation of a session is a baseline (never credited); growth
   * credits the delta to the single HERMES_EXP_BUCKET (all real sessions pool
   * together -- they're all QuantBot); a backward reset (e.g. session
   * restart) re-baselines without a negative credit.
   */
  private creditExp(db: DatabaseSync): void {
    for (const [sessionId, lastTokens] of this.sessionOutputTokens) {
      const tokens = this.readOutputTokens(db, sessionId);
      if (tokens === null) continue;
      if (lastTokens === null || tokens < lastTokens) {
        this.sessionOutputTokens.set(sessionId, tokens);
        continue;
      }
      if (tokens > lastTokens) {
        const delta = tokens - lastTokens;
        this.sessionOutputTokens.set(sessionId, tokens);
        const totalExp = creditDirectoryTokens(HERMES_EXP_BUCKET, delta);
        this.opts.onDirectoryExp?.(HERMES_EXP_BUCKET, totalExp);
      }
    }
  }
}
