import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { formatToolStatus } from '../claude/claude.js';
import { CODEX_TERMINAL_NAME_PREFIX } from './constants.js';

// NOTE: installer wired in Task 7 — this task uses inline no-ops so the module
// compiles and the normalize/format tests run before the installer exists.

// ── formatToolStatus: Codex (0.142+) sends Claude-compatible tool names in its
// hook payloads (tool_name: "Bash", not "exec_command" — confirmed by the Task 5
// probe against fixtures/codex-hook-events.jsonl). Reuse Claude's formatter
// verbatim rather than re-deriving a parallel exec_command/apply_patch taxonomy
// that doesn't match what Codex actually emits.
export { formatToolStatus };

// ── normalizeHookEvent: Codex sends Claude-shaped hook payloads ──
//
// Per the Task 5 probe: PreToolUse/PostToolUse carry a real `tool_use_id`, so
// toolStart uses it directly as the toolId (falling back to a synthetic id only
// if it's ever missing). toolEnd keeps the 'current' sentinel — the handler
// correlates PostToolUse via its own currentHookToolId state, same as Claude.
function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string') return null;

  switch (eventName) {
    case 'PreToolUse': {
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : '';
      const toolInput =
        typeof raw.tool_input === 'object' && raw.tool_input !== null
          ? (raw.tool_input as Record<string, unknown>)
          : {};
      const toolId = typeof raw.tool_use_id === 'string' ? raw.tool_use_id : `hook-${Date.now()}`;
      return {
        sessionId,
        event: { kind: 'toolStart', toolId, toolName, input: toolInput },
      };
    }
    case 'PostToolUse':
      return { sessionId, event: { kind: 'toolEnd', toolId: 'current' } };
    case 'Stop':
      return { sessionId, event: { kind: 'turnEnd' } };
    case 'PermissionRequest':
      return { sessionId, event: { kind: 'permissionRequest' } };
    case 'SessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.source === 'string' ? raw.source : undefined,
          transcriptPath: typeof raw.transcript_path === 'string' ? raw.transcript_path : undefined,
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        },
      };
    // UserPromptSubmit: no normalized kind (mirrors Claude provider). PreCompact/
    // PostCompact/SubagentStart/SubagentStop: not installed by Codex; drop defensively.
    default:
      return null;
  }
}

export const codexProvider: HookProvider = {
  kind: 'hook',
  id: 'codex',
  displayName: 'Codex',
  protocolVersion: 1,
  // SessionStart carries transcript_path + cwd (confirmed by the Task 5 probe),
  // so file-based adoption/reaping works the same as Claude.
  usesTranscriptFile: true,

  normalizeHookEvent,

  // Replaced with the real installer in Task 7.
  installHooks: () => Promise.resolve(),
  uninstallHooks: () => Promise.resolve(),
  areHooksInstalled: () => Promise.resolve(false),

  formatToolStatus,
  // Empty: the fixtures show no Task/Agent/AskUserQuestion-equivalent tool in
  // Codex's hook payloads. Revisit if Codex ever ships a sub-agent tool.
  permissionExemptTools: new Set(),
  subagentToolNames: new Set(),
  readingTools: new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']),
  terminalNamePrefix: CODEX_TERMINAL_NAME_PREFIX,
};
