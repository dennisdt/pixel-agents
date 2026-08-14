/**
 * Hermes-agent provider (LOCAL-ONLY — not for upstream PRs; see
 * docs/superpowers/specs/2026-07-01-multi-provider-agents-design.md).
 * Hermes has no transcript files and no hooks API. A read-only poller over
 * ~/.hermes/state.db (SQLite WAL) synthesizes Claude-shaped hook envelopes.
 * NEVER open the DB writable: FTS triggers + app-maintained counters.
 *
 * Hermes on this machine is single-user, single-agent: the webui, cli, and
 * a2a/bridge/gateway plumbing are all front-ends onto the SAME agent and
 * memory. The poller fans ALL of it into ONE synthetic "QuantBot" character
 * (see HERMES_QUANTBOT_SESSION_ID) rather than minting one office character
 * per (source, cwd) session context.
 */
export const HERMES_DB_RELATIVE_PATH = '.hermes/state.db';
export const HERMES_POLL_INTERVAL_MS = 1000;
/** Max message rows consumed per tick (backpressure). */
export const HERMES_MAX_ROWS_PER_TICK = 500;
/** How long to cache the default `hasForeignDbHolders` check's result (an
 *  `lsof -t <dbPath>` shellout). HermesPoller calls it every tick
 *  (HERMES_POLL_INTERVAL_MS = 1s), so an uncached check would shell out once a
 *  second for as long as the Hermes stack is up. */
export const HERMES_HOLDERS_CACHE_MS = 30_000; // 30 seconds

/** Fixed synthetic session id for the single collapsed QuantBot character.
 *  Stable across Hermes restarts (unlike real session ids, which rotate), so
 *  the poller re-announces the SAME id when the Hermes stack comes back up
 *  instead of minting a new character. */
export const HERMES_QUANTBOT_SESSION_ID = 'hermes-quantbot';
/** Display name / folder_hint for the collapsed character. One line to change
 *  later if QuantBot gets renamed. */
export const HERMES_AGENT_DISPLAY_NAME = 'QuantBot';
/** Single directory-EXP bucket: every real Hermes session's output-token
 *  delta (webui, cli, a2a plumbing) pools here, since they're all the same
 *  agent. */
export const HERMES_EXP_BUCKET = 'hermes';
