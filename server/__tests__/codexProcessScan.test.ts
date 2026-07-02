import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HookProvider } from '../../core/src/provider.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { codexProvider } from '../src/providers/hook/codex/codex.js';
import type { LiveCodexSession } from '../src/providers/hook/codex/codexProcessScan.js';

// The AgentRuntime-wiring tests below need to swap out the real ps/lsof-backed
// enumeration for a fake one, while the parsing tests above need the REAL
// `readCodexSessionMeta`. `vi.mock` replaces the whole module for every
// importer (including agentRuntime.ts's internal import) -- `importOriginal`
// keeps everything except `listLiveCodexSessions` real, and the hoisted mock
// fn is swapped in per-test via `mockReturnValue`.
//
// The real claude process scan is also mocked to [] here: this dev machine
// (and any CI runner) may have real `claude` processes running, and without
// this the claude branch of startProcessScan would adopt them into the test
// store, polluting store.size assertions that are only about codex wiring.
const { mockListLiveCodexSessions, mockListLiveClaudeSessions } = vi.hoisted(() => ({
  mockListLiveCodexSessions: vi.fn<() => LiveCodexSession[]>(),
  mockListLiveClaudeSessions: vi.fn(() => []),
}));
vi.mock('../src/providers/hook/codex/codexProcessScan.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/providers/hook/codex/codexProcessScan.js')>();
  return { ...actual, listLiveCodexSessions: mockListLiveCodexSessions };
});
vi.mock('../src/claudeProcessScan.js', () => ({
  listLiveClaudeSessions: mockListLiveClaudeSessions,
}));

const actualCodexProcessScan = await vi.importActual<
  typeof import('../src/providers/hook/codex/codexProcessScan.js')
>('../src/providers/hook/codex/codexProcessScan.js');
const { readCodexSessionMeta, listLiveCodexSessions: realListLiveCodexSessions } =
  actualCodexProcessScan;

const { AgentRuntime } = await import('../src/agentRuntime.js');
const { AgentStateStore } = await import('../src/agentStateStore.js');
const { PROCESS_SCAN_INTERVAL_MS } = await import('../src/constants.js');
const { __resetDirectoryStatsForTest, getDirectoryExp } = await import('../src/directoryStats.js');
const { setHookProvider } = await import('../src/fileWatcher.js');

describe('readCodexSessionMeta', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-codex-meta-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeRollout(firstLine: string, rest = ''): string {
    const file = path.join(tmpDir, 'rollout-test.jsonl');
    fs.writeFileSync(file, `${firstLine}\n${rest}`);
    return file;
  }

  it('parses session_id and cwd from a valid session_meta first line', () => {
    const file = writeRollout(
      JSON.stringify({
        timestamp: '2026-07-01T20:25:42.000Z',
        type: 'session_meta',
        payload: { session_id: 'abc-123', cwd: '/tmp/project' },
      }),
    );
    expect(readCodexSessionMeta(file)).toEqual({ sessionId: 'abc-123', cwd: '/tmp/project' });
  });

  it('returns null for malformed JSON', () => {
    const file = writeRollout('{not json');
    expect(readCodexSessionMeta(file)).toBeNull();
  });

  it('returns null when payload is missing session_id', () => {
    const file = writeRollout(
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/tmp/project' } }),
    );
    expect(readCodexSessionMeta(file)).toBeNull();
  });

  it('returns null when payload is missing cwd', () => {
    const file = writeRollout(
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'abc-123' } }),
    );
    expect(readCodexSessionMeta(file)).toBeNull();
  });

  it('returns null when the first-line type is not session_meta', () => {
    const file = writeRollout(
      JSON.stringify({
        type: 'response_item',
        payload: { session_id: 'abc-123', cwd: '/tmp/project' },
      }),
    );
    expect(readCodexSessionMeta(file)).toBeNull();
  });

  it('returns null for a nonexistent file', () => {
    expect(readCodexSessionMeta(path.join(tmpDir, 'nope.jsonl'))).toBeNull();
  });

  it('returns null for an empty file', () => {
    const file = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(file, '');
    expect(readCodexSessionMeta(file)).toBeNull();
  });
});

// FIX 7 (Wave 4): codex does NOT hold its rollout file open between events
// (verified live: `lsof -p <pid>` shows zero rollout handles for an idle
// `codex --yolo` -- it appends and closes). Liveness is therefore resolved by
// PROCESS CWD: each live codex process's working directory is matched to the
// newest recent rollout whose session_meta payload.cwd equals it. Both the
// process-cwd lister and the sessions root are injected so tests never touch
// real processes or ~/.codex.
describe('listLiveCodexSessions (cwd matching, injected process-cwd lister)', () => {
  let tmpDir: string;
  let sessionsRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-codex-live-'));
    sessionsRoot = path.join(tmpDir, 'sessions');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** sessionsRoot/YYYY/MM/DD for `daysAgo` days before now (created). */
  function dateDir(daysAgo: number): string {
    const d = new Date(Date.now() - daysAgo * 86_400_000);
    const dir = path.join(
      sessionsRoot,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeRollout(
    dir: string,
    name: string,
    sessionId: string,
    cwd: string,
    mtime?: Date,
  ): string {
    const file = path.join(dir, name);
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: 'session_meta', payload: { session_id: sessionId, cwd } })}\n`,
    );
    if (mtime) fs.utimesSync(file, mtime, mtime);
    return file;
  }

  it('resolves two live processes in different cwds to their two sessions', () => {
    const today = dateDir(0);
    const fileA = writeRollout(today, 'rollout-a.jsonl', 'sess-a', '/tmp/proj-a');
    const fileB = writeRollout(today, 'rollout-b.jsonl', 'sess-b', '/tmp/proj-b');

    const sessions = realListLiveCodexSessions(() => ['/tmp/proj-a', '/tmp/proj-b'], sessionsRoot);

    expect(sessions).toHaveLength(2);
    expect(sessions).toContainEqual({
      sessionId: 'sess-a',
      rolloutFile: fileA,
      cwd: '/tmp/proj-a',
    });
    expect(sessions).toContainEqual({
      sessionId: 'sess-b',
      rolloutFile: fileB,
      cwd: '/tmp/proj-b',
    });
  });

  it('skips a live process cwd with no matching rollout', () => {
    const today = dateDir(0);
    writeRollout(today, 'rollout-a.jsonl', 'sess-a', '/tmp/proj-a');

    const sessions = realListLiveCodexSessions(
      () => ['/tmp/proj-a', '/tmp/proj-unmatched'],
      sessionsRoot,
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.cwd).toBe('/tmp/proj-a');
  });

  it('picks the newest rollout by mtime when several share a cwd', () => {
    const today = dateDir(0);
    const yesterday = dateDir(1);
    writeRollout(
      yesterday,
      'rollout-old.jsonl',
      'sess-old',
      '/tmp/proj',
      new Date(Date.now() - 30 * 3_600_000),
    );
    const newest = writeRollout(
      today,
      'rollout-new.jsonl',
      'sess-new',
      '/tmp/proj',
      new Date(Date.now() - 60_000),
    );

    const sessions = realListLiveCodexSessions(() => ['/tmp/proj'], sessionsRoot);

    expect(sessions).toEqual([{ sessionId: 'sess-new', rolloutFile: newest, cwd: '/tmp/proj' }]);
  });

  it('ignores rollouts outside the scanned date window (today + yesterday)', () => {
    const oldDir = dateDir(5);
    writeRollout(oldDir, 'rollout-ancient.jsonl', 'sess-ancient', '/tmp/proj-old');

    const sessions = realListLiveCodexSessions(() => ['/tmp/proj-old'], sessionsRoot);

    expect(sessions).toEqual([]);
  });

  it('skips rollouts whose first line cannot be parsed as session_meta', () => {
    const today = dateDir(0);
    const bad = path.join(today, 'rollout-bad.jsonl');
    fs.writeFileSync(bad, 'not json\n');
    const good = writeRollout(
      today,
      'rollout-good.jsonl',
      'sess-good',
      '/tmp/proj',
      new Date(Date.now() - 3_600_000), // older than the malformed file
    );

    const sessions = realListLiveCodexSessions(() => ['/tmp/proj'], sessionsRoot);

    expect(sessions).toEqual([{ sessionId: 'sess-good', rolloutFile: good, cwd: '/tmp/proj' }]);
  });

  it('returns [] when the injected lister throws', () => {
    expect(
      realListLiveCodexSessions(() => {
        throw new Error('ps/lsof failed');
      }, sessionsRoot),
    ).toEqual([]);
  });

  it('returns [] when the sessions root does not exist', () => {
    expect(realListLiveCodexSessions(() => ['/tmp/proj'], path.join(tmpDir, 'nope'))).toEqual([]);
  });
});

describe('AgentRuntime.startProcessScan: codex process-liveness scanning', () => {
  let store: InstanceType<typeof AgentStateStore>;
  let runtime: InstanceType<typeof AgentRuntime>;

  beforeEach(() => {
    setHookProvider(claudeProvider as HookProvider);
    store = new AgentStateStore();
    mockListLiveCodexSessions.mockReset();
    mockListLiveCodexSessions.mockReturnValue([]);
    vi.useFakeTimers();
  });

  afterEach(() => {
    runtime.dispose();
    vi.useRealTimers();
  });

  it('adopts a live codex session not already tracked, with no transcript watcher', () => {
    runtime = new AgentRuntime(store, [claudeProvider as HookProvider, codexProvider]);
    runtime.watchAllSessions.current = true;
    mockListLiveCodexSessions.mockReturnValue([
      {
        sessionId: 'codex-live-1',
        rolloutFile: '/tmp/pxl-codex/rollout-1.jsonl',
        cwd: '/tmp/proj',
      },
    ]);

    runtime.startProcessScan();

    expect(store.size).toBe(1);
    const agent = [...store.values()][0];
    expect(agent.providerId).toBe('codex');
    expect(agent.jsonlFile).toBe('/tmp/pxl-codex/rollout-1.jsonl');
    // Non-primary provider transcripts are not Claude-shaped -- no watcher/poll timer.
    expect(runtime.fileWatchers.has(agent.id)).toBe(false);
    expect(runtime.pollingTimers.has(agent.id)).toBe(false);
  });

  it('does not duplicate an already-tracked codex session on the next tick', () => {
    runtime = new AgentRuntime(store, [claudeProvider as HookProvider, codexProvider]);
    runtime.watchAllSessions.current = true;
    mockListLiveCodexSessions.mockReturnValue([
      {
        sessionId: 'codex-live-1',
        rolloutFile: '/tmp/pxl-codex/rollout-1.jsonl',
        cwd: '/tmp/proj',
      },
    ]);

    runtime.startProcessScan(); // immediate first tick adopts
    expect(store.size).toBe(1);

    vi.advanceTimersByTime(PROCESS_SCAN_INTERVAL_MS); // second tick, same live session
    expect(store.size).toBe(1);
  });

  it('does not adopt when watchAllSessions is off', () => {
    runtime = new AgentRuntime(store, [claudeProvider as HookProvider, codexProvider]);
    mockListLiveCodexSessions.mockReturnValue([
      {
        sessionId: 'codex-live-1',
        rolloutFile: '/tmp/pxl-codex/rollout-1.jsonl',
        cwd: '/tmp/proj',
      },
    ]);

    runtime.startProcessScan();

    expect(store.size).toBe(0);
  });
});

describe('AgentRuntime.startProcessScan: codex output-token EXP', () => {
  let store: InstanceType<typeof AgentStateStore>;
  let runtime: InstanceType<typeof AgentRuntime>;
  let tmpDir: string;
  let prevHome: string | undefined;
  let broadcasts: Array<Record<string, unknown>>;

  function tokenLine(outputTokens: number): string {
    return JSON.stringify({
      timestamp: '2026-07-02T00:00:00.000Z',
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 10, output_tokens: outputTokens } },
    });
  }

  beforeEach(() => {
    setHookProvider(claudeProvider as HookProvider);
    prevHome = process.env.HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-codex-exp-'));
    process.env.HOME = tmpDir; // debounced stats save must never touch the real home
    __resetDirectoryStatsForTest();
    store = new AgentStateStore();
    broadcasts = [];
    store.on('broadcast', (msg) => broadcasts.push(msg));
    mockListLiveCodexSessions.mockReset();
    mockListLiveCodexSessions.mockReturnValue([]);
    vi.useFakeTimers();
  });

  afterEach(() => {
    runtime.dispose();
    vi.useRealTimers();
    __resetDirectoryStatsForTest();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('credits appended token_count deltas to the agent cwd and broadcasts directoryExp + agentTokenUsage', () => {
    const rolloutFile = path.join(tmpDir, 'rollout-exp.jsonl');
    const cwd = path.join(tmpDir, 'proj');
    fs.writeFileSync(
      rolloutFile,
      `${JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex-exp-1', cwd } })}\n`,
    );

    runtime = new AgentRuntime(store, [claudeProvider as HookProvider, codexProvider]);
    runtime.watchAllSessions.current = true;
    mockListLiveCodexSessions.mockReturnValue([{ sessionId: 'codex-exp-1', rolloutFile, cwd }]);

    runtime.startProcessScan(); // tick 1: adopts the agent
    expect(store.size).toBe(1);
    const agent = [...store.values()][0];
    expect(agent.cwd).toBe(cwd);

    vi.advanceTimersByTime(PROCESS_SCAN_INTERVAL_MS); // tick 2: reader baselines existing content

    fs.appendFileSync(rolloutFile, `${tokenLine(546)}\n`);
    vi.advanceTimersByTime(PROCESS_SCAN_INTERVAL_MS); // tick 3: credits the 546 delta

    expect(getDirectoryExp(cwd)).toBe(546);
    expect(agent.outputTokens).toBe(546);
    expect(broadcasts).toContainEqual({ type: 'directoryExp', directory: cwd, totalExp: 546 });
    expect(broadcasts).toContainEqual({
      type: 'agentTokenUsage',
      id: agent.id,
      inputTokens: agent.inputTokens,
      outputTokens: 546,
    });

    // Cumulative counter grows 546 -> 555: only the 9-token delta credits.
    fs.appendFileSync(rolloutFile, `${tokenLine(555)}\n`);
    vi.advanceTimersByTime(PROCESS_SCAN_INTERVAL_MS); // tick 4
    expect(getDirectoryExp(cwd)).toBe(555);
    expect(agent.outputTokens).toBe(555);
  });

  it('resumes EXP after a server restart: persisted cwd is preferred over readCwdFromJsonl', () => {
    // Regression (Wave 3 FIX 5): restoreExternalAgents resolved cwd only via
    // readCwdFromJsonl, which understands Claude's flat top-level `cwd` field
    // but not Codex rollouts -- restored codex agents came back with no cwd,
    // the already-tracked guard blocked the scan from re-adopting them, and
    // creditCodexOutputTokens's !agent.cwd guard skipped them forever.
    const rolloutFile = path.join(tmpDir, 'rollout-restore.jsonl');
    const cwd = path.join(tmpDir, 'proj-restore');
    // Deliberately NO session_meta/cwd anywhere in the file: only the
    // persisted cwd can resolve it.
    fs.writeFileSync(
      rolloutFile,
      `${JSON.stringify({ type: 'response_item', payload: { text: 'hi' } })}\n`,
    );

    const persisted = [
      {
        id: 7,
        sessionId: 'codex-restored-1',
        terminalName: '',
        isExternal: true,
        jsonlFile: rolloutFile,
        projectDir: path.dirname(rolloutFile),
        provider: 'codex',
        cwd,
      },
    ];
    store.setAdapter({
      loadAgents: () => persisted,
      saveAgents: vi.fn(),
    } as unknown as Parameters<typeof store.setAdapter>[0]);

    runtime = new AgentRuntime(store, [claudeProvider as HookProvider, codexProvider]);
    runtime.restoreExternalAgents(); // restart-simulate
    expect(store.size).toBe(1);
    const agent = store.get(7);
    expect(agent?.cwd).toBe(cwd);

    // watchAllSessions stays OFF: token crediting must not depend on the scan setting.
    runtime.startProcessScan(); // tick 1: reader baselines existing content
    fs.appendFileSync(rolloutFile, `${tokenLine(100)}\n`);
    vi.advanceTimersByTime(PROCESS_SCAN_INTERVAL_MS); // tick 2: credits

    expect(getDirectoryExp(cwd)).toBe(100);
    expect(broadcasts).toContainEqual({ type: 'directoryExp', directory: cwd, totalExp: 100 });
  });

  it('belt-and-braces: an agent persisted WITHOUT cwd (pre-fix) resolves it from the rollout session_meta', () => {
    const cwd = path.join(tmpDir, 'proj-legacy');
    const rolloutFile = path.join(tmpDir, 'rollout-legacy.jsonl');
    fs.writeFileSync(
      rolloutFile,
      `${JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex-legacy-1', cwd } })}\n`,
    );

    const persisted = [
      {
        id: 8,
        sessionId: 'codex-legacy-1',
        terminalName: '',
        isExternal: true,
        jsonlFile: rolloutFile,
        projectDir: path.dirname(rolloutFile),
        provider: 'codex',
        // no cwd: persisted by a pre-fix server
      },
    ];
    store.setAdapter({
      loadAgents: () => persisted,
      saveAgents: vi.fn(),
    } as unknown as Parameters<typeof store.setAdapter>[0]);

    runtime = new AgentRuntime(store, [claudeProvider as HookProvider, codexProvider]);
    runtime.restoreExternalAgents();
    expect(store.get(8)?.cwd).toBe(cwd); // readCwdFromJsonl's session_meta fallback

    runtime.startProcessScan(); // baseline
    fs.appendFileSync(rolloutFile, `${tokenLine(30)}\n`);
    vi.advanceTimersByTime(PROCESS_SCAN_INTERVAL_MS);
    expect(getDirectoryExp(cwd)).toBe(30);
  });

  it('round-trips cwd through agentStateStore.persist()', () => {
    const saved: Array<Array<Record<string, unknown>>> = [];
    store.setAdapter({
      loadAgents: () => [],
      saveAgents: (agents: Array<Record<string, unknown>>) => {
        saved.push(agents);
      },
    } as unknown as Parameters<typeof store.setAdapter>[0]);

    runtime = new AgentRuntime(store, [claudeProvider as HookProvider, codexProvider]);
    const rolloutFile = path.join(tmpDir, 'rollout-persist.jsonl');
    const cwd = path.join(tmpDir, 'proj-persist');
    fs.writeFileSync(
      rolloutFile,
      `${JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex-persist-1', cwd } })}\n`,
    );
    runtime.handleHookEvent('codex', {
      hook_event_name: 'SessionStart',
      session_id: 'codex-persist-1',
      source: 'startup',
      transcript_path: rolloutFile,
      cwd,
    });
    runtime.handleHookEvent('codex', { hook_event_name: 'Stop', session_id: 'codex-persist-1' });

    const last = saved.at(-1);
    expect(last).toBeDefined();
    expect(last?.[0]?.cwd).toBe(cwd);
  });

  it('accrues EXP for a hook-adopted codex agent even when watchAllSessions is off', () => {
    const rolloutFile = path.join(tmpDir, 'rollout-hook.jsonl');
    const cwd = path.join(tmpDir, 'proj-hook');
    fs.writeFileSync(
      rolloutFile,
      `${JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex-hook-1', cwd } })}\n`,
    );

    runtime = new AgentRuntime(store, [claudeProvider as HookProvider, codexProvider]);
    // watchAllSessions stays OFF: the agent arrives via hooks, not the scan.
    runtime.handleHookEvent('codex', {
      hook_event_name: 'SessionStart',
      session_id: 'codex-hook-1',
      source: 'startup',
      transcript_path: rolloutFile,
      cwd,
    });
    runtime.handleHookEvent('codex', { hook_event_name: 'Stop', session_id: 'codex-hook-1' });
    expect(store.size).toBe(1);

    runtime.startProcessScan(); // tick 1: baseline (adoption scan itself is gated off)
    fs.appendFileSync(rolloutFile, `${tokenLine(42)}\n`);
    vi.advanceTimersByTime(PROCESS_SCAN_INTERVAL_MS); // tick 2: credits

    expect(getDirectoryExp(cwd)).toBe(42);
  });
});
