import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HookProvider } from '../../core/src/provider.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  EXTERNAL_ACTIVE_THRESHOLD_MS,
  EXTERNAL_STALE_CHECK_INTERVAL_MS,
} from '../src/constants.js';
import { DismissalTracker } from '../src/dismissalTracker.js';
import {
  adoptExternalSessionFromHook,
  setAgentRemovalCallback,
  setDismissalTracker,
  setHookProvider,
  startStaleExternalAgentCheck,
} from '../src/fileWatcher.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { codexProvider } from '../src/providers/hook/codex/codex.js';
import { SessionRouter } from '../src/sessionRouter.js';
import type { AgentState, PersistedAgent } from '../src/types.js';

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

  it('persists and restores providerId', () => {
    const saved: unknown[] = [];
    store.setAdapter({
      saveAgents: (a: unknown[]) => saved.push(...a),
      loadAgents: () => [],
      getSetting: (_k: string, d: unknown) => d,
      setSetting: () => {},
      saveSeats: () => {},
      loadSeats: () => ({}),
    } as never);
    store.set(1, createTestAgent({ id: 1, providerId: 'codex' }));
    store.persist();
    expect((saved[0] as { provider?: string }).provider).toBe('codex');
  });

  it('getProvider/getProviders expose the registry', () => {
    const alpha = fakeProvider('alpha');
    const runtime = new AgentRuntime(store, [alpha, fakeProvider('beta')]);
    expect(runtime.getProviders()).toHaveLength(2);
    expect(runtime.getProvider('alpha')).toBe(alpha);
    expect(runtime.getProvider('nope')).toBeUndefined();
  });

  it('reattachSession re-points an agent to a new session id (persona continuity)', () => {
    const saved: unknown[] = [];
    store.setAdapter({
      saveAgents: (a: unknown[]) => {
        saved.length = 0;
        saved.push(...a);
      },
      loadAgents: () => [],
      getSetting: (_k: string, d: unknown) => d,
      setSetting: () => {},
      saveSeats: () => {},
      loadSeats: () => ({}),
    } as never);

    const runtime = new AgentRuntime(store, [fakeProvider('hermes')]);
    store.set(7, createTestAgent({ id: 7, sessionId: 'old-sess', personaKey: 'cli:/proj/a' }));
    runtime.registerAgent('old-sess', 7);

    runtime.reattachSession(7, 'new-sess');

    // Old session id no longer routes.
    runtime.handleHookEvent('hermes', { hook_event_name: 'Stop', session_id: 'old-sess' });
    expect(messages.filter((m) => m.type === 'agentStatus')).toHaveLength(0);

    // New session id routes to the same agent.
    runtime.handleHookEvent('hermes', { hook_event_name: 'Stop', session_id: 'new-sess' });
    const statuses = messages.filter((m) => m.type === 'agentStatus');
    expect(statuses.some((m) => m.id === 7)).toBe(true);

    // Agent's sessionId updated, and the reattach persisted the store.
    expect(store.get(7)?.sessionId).toBe('new-sess');
    expect((saved[0] as { sessionId?: string }).sessionId).toBe('new-sess');
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

  it('claude + codex providers coexist without cross-talk', () => {
    const runtime = new AgentRuntime(store, [claudeProvider, codexProvider]);
    store.set(1, createTestAgent({ id: 1, providerId: 'claude' }));
    store.set(2, createTestAgent({ id: 2, providerId: 'codex' }));
    runtime.registerAgent('claude-sess', 1);
    runtime.registerAgent('codex-sess', 2);

    runtime.handleHookEvent('codex', { hook_event_name: 'Stop', session_id: 'codex-sess' });
    const statuses = messages.filter((m) => m.type === 'agentStatus');
    expect(statuses.every((m) => m.id === 2)).toBe(true);
  });
});

describe('adoptExternalSessionFromHook: transcript watching gated to primary provider', () => {
  // AgentRuntime's constructor is what normally calls setHookProvider(primary) on
  // fileWatcher.ts's module-level singleton; these tests call adoptExternalSessionFromHook
  // directly, so seed the same module state by hand.
  let localStore: AgentStateStore;
  let knownJsonlFiles: Set<string>;
  let nextAgentIdRef: { current: number };
  let fileWatchers: Map<number, fs.FSWatcher>;
  let pollingTimers: Map<number, ReturnType<typeof setInterval>>;
  let waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  let permissionTimers: Map<number, ReturnType<typeof setTimeout>>;

  beforeEach(() => {
    setDismissalTracker(new DismissalTracker());
    // claude is the primary (index 0) provider in every real runtime wiring
    // (cli.ts, PixelAgentsViewProvider.ts): [claudeProvider, codexProvider].
    setHookProvider(claudeProvider);

    localStore = new AgentStateStore();
    knownJsonlFiles = new Set();
    nextAgentIdRef = { current: 1 };
    fileWatchers = new Map();
    pollingTimers = new Map();
    waitingTimers = new Map();
    permissionTimers = new Map();
  });

  afterEach(() => {
    for (const t of pollingTimers.values()) clearInterval(t);
    for (const t of waitingTimers.values()) clearTimeout(t);
    for (const t of permissionTimers.values()) clearTimeout(t);
  });

  it('adopts a non-primary (codex) session with jsonlFile set but no watcher/poll timer', () => {
    adoptExternalSessionFromHook(
      'codex-sess',
      '/tmp/pxl-test/codex-session.jsonl',
      '/tmp/pxl-test',
      'codex',
      knownJsonlFiles,
      nextAgentIdRef,
      localStore,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      () => {},
    );

    expect(localStore.size).toBe(1);
    const agent = [...localStore.values()][0];
    expect(agent.providerId).toBe('codex');
    expect(agent.jsonlFile).toBe('/tmp/pxl-test/codex-session.jsonl');
    // No watcher/poll timer registered for a non-parseable provider's transcript.
    expect(pollingTimers.size).toBe(0);
    expect(fileWatchers.size).toBe(0);
  });

  it('adopts a primary (claude) session and starts the watcher/poll timer', () => {
    adoptExternalSessionFromHook(
      'claude-sess',
      '/tmp/pxl-test/claude-session.jsonl',
      '/tmp/pxl-test',
      'claude',
      knownJsonlFiles,
      nextAgentIdRef,
      localStore,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      () => {},
    );

    expect(localStore.size).toBe(1);
    const agent = [...localStore.values()][0];
    expect(agent.providerId).toBe('claude');
    expect(agent.jsonlFile).toBe('/tmp/pxl-test/claude-session.jsonl');
    // The primary provider's transcript is parseable -> watcher/poll timer starts.
    expect(pollingTimers.size).toBe(1);
    expect(pollingTimers.has(agent.id)).toBe(true);
  });
});

describe('AgentRuntime.onExternalSessionDetected: provider-aware tracked-dir gate', () => {
  // Tracked dirs are seeded only by ensureProjectScan (Claude workspace roots),
  // so a Codex sessions dir (~/.codex/sessions/YYYY/MM/DD) or a Hermes raw cwd
  // is never tracked. These tests use paths no other test in this suite tracks.
  let store: AgentStateStore;

  beforeEach(() => {
    store = new AgentStateStore();
  });

  it('adopts a hook-confirmed codex session with an untracked projectDir, watchAllSessions=false', () => {
    const runtime = new AgentRuntime(store, [claudeProvider, codexProvider]);
    const transcriptPath = '/tmp/pxl-finding1-test/codex/sessions/2026/07/01/codex-sess.jsonl';

    // SessionStart only stores a pending session -- not yet adopted.
    runtime.handleHookEvent('codex', {
      hook_event_name: 'SessionStart',
      session_id: 'codex-gate-sess',
      source: 'startup',
      transcript_path: transcriptPath,
      cwd: '/Users/test/some-project',
    });
    expect(store.size).toBe(0);

    // Stop confirms the pending session -> onExternalSessionDetected fires.
    runtime.handleHookEvent('codex', {
      hook_event_name: 'Stop',
      session_id: 'codex-gate-sess',
    });

    expect(store.size).toBe(1);
    const agent = [...store.values()][0];
    expect(agent.providerId).toBe('codex');
    expect(agent.jsonlFile).toBe(transcriptPath);
  });

  it('does NOT adopt a hook-confirmed claude session with an untracked projectDir, watchAllSessions=false', () => {
    const runtime = new AgentRuntime(store, [claudeProvider, codexProvider]);
    const transcriptPath = '/tmp/pxl-finding1-test/claude/untracked-project/claude-sess.jsonl';

    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'claude-gate-sess',
      source: 'startup',
      transcript_path: transcriptPath,
      cwd: '/Users/test/some-project',
    });
    expect(store.size).toBe(0);

    runtime.handleHookEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'claude-gate-sess',
    });

    // The tracked-dir gate still applies to the primary provider (filters
    // transient Claude Extension sessions) -> not adopted.
    expect(store.size).toBe(0);
  });
});

describe('startStaleExternalAgentCheck: hooks-mode reaping gated by provider', () => {
  let store: AgentStateStore;
  let knownJsonlFiles: Set<string>;
  let removedIds: number[];
  let tmpDir: string;

  beforeEach(() => {
    // claude is the primary (index 0) provider in every real runtime wiring.
    setHookProvider(claudeProvider);
    removedIds = [];
    setAgentRemovalCallback((id) => {
      removedIds.push(id);
      store.delete(id);
    });
    store = new AgentStateStore();
    knownJsonlFiles = new Set();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-stale-test-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    setAgentRemovalCallback(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reaps a stale codex agent but keeps a stale claude agent alive, with hooks enabled', () => {
    const codexFile = path.join(tmpDir, 'codex-sess.jsonl');
    const claudeFile = path.join(tmpDir, 'claude-sess.jsonl');
    fs.writeFileSync(codexFile, '');
    fs.writeFileSync(claudeFile, '');
    const staleMtime = new Date(Date.now() - EXTERNAL_ACTIVE_THRESHOLD_MS - 60_000);
    fs.utimesSync(codexFile, staleMtime, staleMtime);
    fs.utimesSync(claudeFile, staleMtime, staleMtime);

    store.set(
      10,
      createTestAgent({ id: 10, isExternal: true, providerId: 'codex', jsonlFile: codexFile }),
    );
    store.set(
      11,
      createTestAgent({ id: 11, isExternal: true, providerId: 'claude', jsonlFile: claudeFile }),
    );

    startStaleExternalAgentCheck(store, knownJsonlFiles, { current: true });
    vi.advanceTimersByTime(EXTERNAL_STALE_CHECK_INTERVAL_MS);

    // Codex has no SessionEnd hook -- mtime staleness reaps it even though
    // hooks are enabled.
    expect(removedIds).toEqual([10]);
    expect(store.has(10)).toBe(false);
    // Claude keeps the hooks-mode skip -- SessionEnd is its cleanup path.
    expect(store.has(11)).toBe(true);
  });
});

describe('AgentRuntime.restoreExternalAgents: transcript watching gated to primary provider', () => {
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let tmpDir: string;

  function persistedAgent(overrides: Partial<PersistedAgent>): PersistedAgent {
    return {
      id: 1,
      sessionId: 'sess',
      terminalName: '',
      isExternal: true,
      jsonlFile: '/nonexistent',
      projectDir: '/nonexistent',
      ...overrides,
    };
  }

  beforeEach(() => {
    setHookProvider(claudeProvider); // primary = claude, mirrors real wiring
    store = new AgentStateStore();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-restore-test-'));
  });

  afterEach(() => {
    runtime.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not start a watcher for a restored codex agent, but does for claude/legacy', () => {
    const codexFile = path.join(tmpDir, 'codex-sess.jsonl');
    const claudeFile = path.join(tmpDir, 'claude-sess.jsonl');
    const legacyFile = path.join(tmpDir, 'legacy-sess.jsonl');
    fs.writeFileSync(codexFile, '');
    fs.writeFileSync(claudeFile, '');
    fs.writeFileSync(legacyFile, '');

    const persisted: PersistedAgent[] = [
      persistedAgent({ id: 1, sessionId: 'codex-sess', jsonlFile: codexFile, provider: 'codex' }),
      persistedAgent({
        id: 2,
        sessionId: 'claude-sess',
        jsonlFile: claudeFile,
        provider: 'claude',
      }),
      // No `provider` field: predates multi-provider support, was always Claude.
      persistedAgent({ id: 3, sessionId: 'legacy-sess', jsonlFile: legacyFile }),
    ];

    store.setAdapter({
      saveAgents: () => {},
      loadAgents: () => persisted,
      getSetting: (_k: string, d: unknown) => d,
      setSetting: () => {},
      saveSeats: () => {},
      loadSeats: () => ({}),
    } as never);

    runtime = new AgentRuntime(store, [claudeProvider, codexProvider]);
    runtime.restoreExternalAgents();

    // All three are restored (character appears, jsonlFile kept for staleness).
    expect(store.size).toBe(3);
    expect(store.get(1)?.providerId).toBe('codex');

    // Only the primary provider's transcripts get a watcher/poll timer.
    expect(runtime.pollingTimers.has(1)).toBe(false); // codex: no watcher
    expect(runtime.pollingTimers.has(2)).toBe(true); // claude: watcher started
    expect(runtime.pollingTimers.has(3)).toBe(true); // legacy (no provider): watcher started
  });
});
