/**
 * Codex-specific constants. Codex (0.142+) speaks the Claude Code hooks JSON
 * shape but supports a different event set: no SessionEnd, no Notification,
 * no PostToolUseFailure. Session lifecycle end is handled by transcript-mtime
 * staleness instead (see spec 2026-07-01-multi-provider-agents-design.md).
 *
 * NOTE: these exports are consumed by Task 7's installer (~/.codex/hooks.json
 * writer + config.toml trust hashing), not by this task's normalize/format
 * logic. Kept here (and kept exactly as specified) so Task 7 can import them
 * without touching this file.
 */

/** Events we install in ~/.codex/hooks.json (the Claude-compatible subset). */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
] as const;

/** Codex's snake_case labels used in config.toml [hooks.state] trust keys. */
export const CODEX_SNAKE_LABELS: Record<(typeof CODEX_HOOK_EVENTS)[number], string> = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  PermissionRequest: 'permission_request',
  Stop: 'stop',
};

/** Events whose matcher is forced to None by Codex before trust-hashing —
 *  the `matcher` key must be OMITTED from both hooks.json and the hash preimage. */
export const CODEX_MATCHERLESS_EVENTS = new Set(['Stop', 'UserPromptSubmit']);

export const CODEX_TERMINAL_NAME_PREFIX = 'Codex';
export const CODEX_HOOK_TIMEOUT_SEC = 5;
