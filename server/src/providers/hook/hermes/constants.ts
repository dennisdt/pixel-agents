/**
 * Hermes-agent provider (LOCAL-ONLY — not for upstream PRs; see
 * docs/superpowers/specs/2026-07-01-multi-provider-agents-design.md).
 * Hermes has no transcript files and no hooks API. A read-only poller over
 * ~/.hermes/state.db (SQLite WAL) synthesizes Claude-shaped hook envelopes.
 * NEVER open the DB writable: FTS triggers + app-maintained counters.
 */
export const HERMES_DB_RELATIVE_PATH = '.hermes/state.db';
export const HERMES_POLL_INTERVAL_MS = 1000;
/** At startup, only adopt live sessions with a message newer than this. */
export const HERMES_ACTIVE_THRESHOLD_MS = 600_000; // 10 minutes
/** Sessions with no new rows for this long get a synthesized SessionEnd. */
export const HERMES_INACTIVITY_TIMEOUT_MS = 1_800_000; // 30 minutes
/** Max message rows consumed per tick (backpressure). */
export const HERMES_MAX_ROWS_PER_TICK = 500;
/** Prefix for stable per-persona identifiers derived from a session's `source`
 *  column (`hermes-webui`, `hermes-cli`, ...). Two uses: the display-name
 *  fallback (`folder_hint`) for cwd-less sessions (the Hermes webui runs with
 *  cwd NULL, so there is no directory basename to name the character after),
 *  and the directory-EXP bucket (`exp_bucket`) every hermes session's output
 *  tokens accrue to — stable across session-id rotation and cwd churn, and
 *  stamped on the agent as its cwd so the webview levels by it unchanged. */
export const HERMES_PERSONA_BUCKET_PREFIX = 'hermes-';
/** How long to cache the default `hasForeignDbHolders` check's result (an
 *  `lsof -t <dbPath>` shellout). HermesPoller may call it every tick
 *  (HERMES_POLL_INTERVAL_MS = 1s) while any session is process-backed, so an
 *  uncached check would shell out once a second for as long as the session
 *  lives. */
export const HERMES_HOLDERS_CACHE_MS = 30_000; // 30 seconds
