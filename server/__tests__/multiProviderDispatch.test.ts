import { beforeEach, describe, expect, it } from 'vitest';

import type { HookProvider } from '../../core/src/provider.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import { SessionRouter } from '../src/sessionRouter.js';
import type { AgentState } from '../src/types.js';

/** Minimal AgentState for testing (copied from hookEventHandler.test.ts — keep the cast). */
function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: '',
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    ...overrides,
  } as AgentState;
}

function fakeProvider(id: string, overrides: Partial<HookProvider> = {}): HookProvider {
  return {
    kind: 'hook',
    id,
    displayName: id,
    protocolVersion: 1,
    usesTranscriptFile: false,
    normalizeHookEvent: (raw) => {
      if (typeof raw.session_id !== 'string') return null;
      if (raw.hook_event_name === 'Stop')
        return { sessionId: raw.session_id, event: { kind: 'turnEnd' } };
      if (raw.hook_event_name === 'PreToolUse')
        return {
          sessionId: raw.session_id,
          event: {
            kind: 'toolStart',
            toolId: `hook-test`,
            toolName: typeof raw.tool_name === 'string' ? raw.tool_name : '',
            input: {},
          },
        };
      return null;
    },
    installHooks: () => Promise.resolve(),
    uninstallHooks: () => Promise.resolve(),
    areHooksInstalled: () => Promise.resolve(false),
    formatToolStatus: (t) => t,
    permissionExemptTools: new Set<string>(),
    subagentToolNames: new Set<string>(),
    readingTools: new Set<string>(),
    ...overrides,
  };
}

describe('multi-provider dispatch', () => {
  let store: AgentStateStore;
  let messages: Array<Record<string, unknown>>;

  beforeEach(() => {
    store = new AgentStateStore();
    messages = [];
    store.on('broadcast', (msg) => messages.push(msg));
  });

  it('routes events to the handler matching providerId', () => {
    const runtime = new AgentRuntime(store, [fakeProvider('alpha'), fakeProvider('beta')]);
    store.set(1, createTestAgent({ id: 1 }));
    store.set(2, createTestAgent({ id: 2 }));
    runtime.registerAgent('sess-a', 1);
    runtime.registerAgent('sess-b', 2);

    runtime.handleHookEvent('alpha', { hook_event_name: 'Stop', session_id: 'sess-a' });
    // agentStatus waiting for agent 1 only
    const statuses = messages.filter((m) => m.type === 'agentStatus');
    expect(statuses.some((m) => m.id === 1)).toBe(true);
    expect(statuses.some((m) => m.id === 2)).toBe(false);
  });

  it('drops events for unregistered provider ids', () => {
    const runtime = new AgentRuntime(store, [fakeProvider('alpha')]);
    store.set(1, createTestAgent({ id: 1 }));
    runtime.registerAgent('sess-a', 1);

    runtime.handleHookEvent('nope', { hook_event_name: 'Stop', session_id: 'sess-a' });
    expect(messages.filter((m) => m.type === 'agentStatus')).toHaveLength(0);
  });

  it('getProvider/getProviders expose the registry', () => {
    const alpha = fakeProvider('alpha');
    const runtime = new AgentRuntime(store, [alpha, fakeProvider('beta')]);
    expect(runtime.getProviders()).toHaveLength(2);
    expect(runtime.getProvider('alpha')).toBe(alpha);
    expect(runtime.getProvider('nope')).toBeUndefined();
  });

  it('subagent-tool suppression uses provider.subagentToolNames, not literals', () => {
    // Provider where 'Task' is NOT a subagent tool -> agentToolStart must broadcast.
    const provider = fakeProvider('gamma');
    const handler = new HookEventHandler(
      store,
      new Map(),
      new Map(),
      provider,
      new SessionRouter(),
    );
    store.set(3, createTestAgent({ id: 3 }));
    handler.registerAgent('sess-c', 3);
    handler.handleEvent('gamma', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-c',
      tool_name: 'Task',
    });
    expect(messages.some((m) => m.type === 'agentToolStart' && m.id === 3)).toBe(true);
  });

  it('suppresses agentToolStart for tools in provider.subagentToolNames', () => {
    const provider = fakeProvider('delta', { subagentToolNames: new Set(['Task']) });
    const handler = new HookEventHandler(
      store,
      new Map(),
      new Map(),
      provider,
      new SessionRouter(),
    );
    store.set(4, createTestAgent({ id: 4 }));
    handler.registerAgent('sess-d', 4);
    handler.handleEvent('delta', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-d',
      tool_name: 'Task',
    });
    expect(messages.some((m) => m.type === 'agentToolStart' && m.id === 4)).toBe(false);
    // active status still broadcast
    expect(
      messages.some((m) => m.type === 'agentStatus' && m.id === 4 && m.status === 'active'),
    ).toBe(true);
  });
});
