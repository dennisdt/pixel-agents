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

describe('listLiveCodexSessions (injected lister)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-codex-live-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeRollout(name: string, sessionId: string, cwd: string): string {
    const file = path.join(tmpDir, name);
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: 'session_meta', payload: { session_id: sessionId, cwd } })}\n`,
    );
    return file;
  }

  it('resolves each open rollout file returned by the injected lister to a session', () => {
    const file = writeRollout('rollout-1.jsonl', 'sess-1', '/tmp/proj-1');
    const sessions = realListLiveCodexSessions(() => [file]);
    expect(sessions).toEqual([{ sessionId: 'sess-1', rolloutFile: file, cwd: '/tmp/proj-1' }]);
  });

  it('skips files whose first line cannot be parsed as session_meta', () => {
    const good = writeRollout('rollout-good.jsonl', 'sess-good', '/tmp/proj');
    const bad = path.join(tmpDir, 'rollout-bad.jsonl');
    fs.writeFileSync(bad, 'not json\n');
    const sessions = realListLiveCodexSessions(() => [good, bad]);
    expect(sessions).toEqual([{ sessionId: 'sess-good', rolloutFile: good, cwd: '/tmp/proj' }]);
  });

  it('returns [] when the injected lister throws', () => {
    expect(
      realListLiveCodexSessions(() => {
        throw new Error('ps/lsof failed');
      }),
    ).toEqual([]);
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
