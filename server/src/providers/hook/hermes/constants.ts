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
