import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { BASH_COMMAND_DISPLAY_MAX_LENGTH } from '../../../constants.js';

// The poller synthesizes Claude-shaped envelopes, so normalization mirrors the
// Claude provider for the five envelope kinds the poller emits.
function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string') return null;

  switch (eventName) {
    case 'PreToolUse': {
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : '';
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: typeof raw.tool_call_id === 'string' ? raw.tool_call_id : `hook-${Date.now()}`,
          toolName,
          input: raw.tool_input,
        },
      };
    }
    case 'PostToolUse':
      // The poller attaches the real tool_call_id (see hermesPoller.ts's emitForRow);
      // preserve it here rather than discarding it into the 'current' sentinel.
      // NOTE: as of writing, hookEventHandler's dispatch for 'toolEnd' calls
      // handlePostToolUse(agent, agentId) WITHOUT the normalized event, so it
      // still correlates via its own single-slot `agent.currentHookToolId` state
      // (Claude-parity, see claude.ts's normalizeHookEvent comment) rather than
      // event.toolId. This preserves the data at the normalization boundary
      // without changing rendered behavior for parallel calls today.
      return {
        sessionId,
        event: {
          kind: 'toolEnd',
          toolId: typeof raw.tool_call_id === 'string' ? raw.tool_call_id : 'current',
        },
      };
    case 'Stop':
      return { sessionId, event: { kind: 'turnEnd' } };
    case 'SessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.source === 'string' ? raw.source : undefined,
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        },
      };
    case 'SessionEnd':
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason: typeof raw.reason === 'string' ? raw.reason : undefined,
        },
      };
    default:
      return null;
  }
}

function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  if (typeof inp.command === 'string')
    return `Running ${inp.command.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH)}`;
  return toolName;
}

export const hermesProvider: HookProvider = {
  kind: 'hook',
  id: 'hermes',
  displayName: 'Hermes',
  protocolVersion: 1,
  usesTranscriptFile: false, // hooks(poller)-only; cwd-only adoption path

  normalizeHookEvent,

  // Poller-based: nothing to install.
  installHooks: () => Promise.resolve(),
  uninstallHooks: () => Promise.resolve(),
  areHooksInstalled: () => Promise.resolve(true),

  formatToolStatus,
  permissionExemptTools: new Set(),
  subagentToolNames: new Set(),
  readingTools: new Set(['web_search', 'read_file', 'memory']),
};
