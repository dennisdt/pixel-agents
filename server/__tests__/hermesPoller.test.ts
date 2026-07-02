import { DatabaseSync } from 'node:sqlite';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetDirectoryStatsForTest, getDirectoryExp } from '../src/directoryStats.js';
import { HERMES_INACTIVITY_TIMEOUT_MS } from '../src/providers/hook/hermes/constants.js';
import { hermesProvider } from '../src/providers/hook/hermes/hermes.js';
import type { MessageRow } from '../src/providers/hook/hermes/hermesPoller.js';
import { HermesPoller } from '../src/providers/hook/hermes/hermesPoller.js';

// Finding 1 test seam: `HermesPoller.processRow` is `protected` specifically so a
// test subclass can force a failure on an arbitrary row (the Nth row processed,
// regardless of which physical row it lands on) without needing to corrupt the
// DB mid-read. `cursorForTest` exposes the otherwise-protected cursor so the test
// can assert it never advances past a row whose processing threw.
class RowFailurePoller extends HermesPoller {
  private callCount = 0;
  private readonly failOnCall: number;

  constructor(opts: ConstructorParameters<typeof HermesPoller>[0], failOnCall: number) {
    super(opts);
    this.failOnCall = failOnCall;
  }

  protected override processRow(db: DatabaseSync, row: MessageRow): void {
    this.callCount += 1;
    if (this.callCount === this.failOnCall) {
      throw new Error('synthetic row failure (Finding 1 test)');
    }
    super.processRow(db, row);
  }

  get cursorForTest(): number {
    return this.cursor;
  }
}

let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;
let events: Array<{ providerId: string; envelope: Record<string, unknown> }>;

function makeDb(p: string): DatabaseSync {
  const d = new DatabaseSync(p);
  d.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, cwd TEXT,
      started_at REAL NOT NULL, ended_at REAL, end_reason TEXT,
      output_tokens INTEGER
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT,
      tool_name TEXT, timestamp REAL NOT NULL, finish_reason TEXT
    );
  `);
  return d;
}

// epoch seconds, matches Hermes REAL format. Computed from Date.now() (rather
// than a hardcoded literal) so the "recent activity" bootstrap check stays
// within HERMES_ACTIVE_THRESHOLD_MS regardless of when the suite runs.
const NOW_S = Math.floor(Date.now() / 1000);

function insertSession(id: string, source = 'cli', cwd: string | null = '/proj/a'): void {
  db.prepare('INSERT INTO sessions (id, source, cwd, started_at) VALUES (?,?,?,?)').run(
    id,
    source,
    cwd,
    NOW_S,
  );
}
function insertMessage(
  sessionId: string,
  role: string,
  extra: Partial<{
    tool_calls: string;
    tool_call_id: string;
    tool_name: string;
    finish_reason: string;
  }> = {},
): void {
  db.prepare(
    'INSERT INTO messages (session_id, role, timestamp, tool_calls, tool_call_id, tool_name, finish_reason) VALUES (?,?,?,?,?,?,?)',
  ).run(
    sessionId,
    role,
    NOW_S,
    extra.tool_calls ?? null,
    extra.tool_call_id ?? null,
    extra.tool_name ?? null,
    extra.finish_reason ?? null,
  );
}

describe('HermesPoller', () => {
  let poller: HermesPoller;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hermes-'));
    dbPath = path.join(tmpDir, 'state.db');
    db = makeDb(dbPath);
    events = [];
    poller = new HermesPoller({
      dbPath,
      onEvent: (providerId, envelope) => events.push({ providerId, envelope }),
      resolvePersonaAgent: () => undefined, // Task 10 wires the real lookup
      reattachSession: () => {},
    });
  });

  afterEach(() => {
    poller.stop();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits SessionStart for a live session with recent activity on first tick', () => {
    insertSession('s1');
    insertMessage('s1', 'user');
    poller.tick();
    const start = events.find((e) => e.envelope.hook_event_name === 'SessionStart');
    expect(start?.providerId).toBe('hermes');
    expect(start?.envelope.session_id).toBe('s1');
    expect(start?.envelope.cwd).toBe('/proj/a');
  });

  it('maps assistant tool_calls -> PreToolUse and tool rows -> PostToolUse', () => {
    insertSession('s1');
    poller.tick(); // establish cursor
    insertMessage('s1', 'assistant', {
      tool_calls: JSON.stringify([
        {
          id: 'call_1',
          call_id: 'call_1',
          type: 'function',
          function: { name: 'web_search', arguments: '{"query":"btc"}' },
        },
      ]),
      finish_reason: 'tool_calls',
    });
    insertMessage('s1', 'tool', { tool_call_id: 'call_1', tool_name: 'web_search' });
    poller.tick();
    const names = events.map((e) => e.envelope.hook_event_name);
    expect(names).toContain('PreToolUse');
    expect(names).toContain('PostToolUse');
    const pre = events.find((e) => e.envelope.hook_event_name === 'PreToolUse');
    expect(pre?.envelope.tool_name).toBe('web_search');
    expect(pre?.envelope.tool_input).toEqual({ query: 'btc' });
  });

  it("finish_reason='stop' -> Stop; ended_at -> SessionEnd", () => {
    insertSession('s1');
    poller.tick();
    insertMessage('s1', 'assistant', { finish_reason: 'stop' });
    poller.tick();
    expect(events.some((e) => e.envelope.hook_event_name === 'Stop')).toBe(true);

    db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?').run(
      NOW_S + 10,
      'user_exit',
      's1',
    );
    poller.tick();
    const end = events.find((e) => e.envelope.hook_event_name === 'SessionEnd');
    expect(end?.envelope.session_id).toBe('s1');
  });

  it('does not replay history: first tick sets cursor to MAX(id)', () => {
    insertSession('s1');
    insertMessage('s1', 'assistant', { finish_reason: 'stop' });
    poller.tick();
    expect(events.filter((e) => e.envelope.hook_event_name === 'Stop')).toHaveLength(0);
  });

  it('survives a missing db file (no throw, no events)', () => {
    const p2 = new HermesPoller({
      dbPath: path.join(tmpDir, 'nope.db'),
      onEvent: (pid, env) => events.push({ providerId: pid, envelope: env }),
      resolvePersonaAgent: () => undefined,
      reattachSession: () => {},
    });
    expect(() => p2.tick()).not.toThrow();
    expect(events).toHaveLength(0);
  });

  // Finding 1: a throw mid-row (e.g. a WAL checkpoint race) must not advance the
  // cursor past the failed row, and rows already fully processed before the
  // failure must not be re-emitted on retry.
  it('does not advance the cursor past a row that throws, and retries it cleanly without re-emitting prior rows', () => {
    insertSession('s1');
    const failing = new RowFailurePoller(
      {
        dbPath,
        onEvent: (pid, env) => events.push({ providerId: pid, envelope: env }),
        resolvePersonaAgent: () => undefined,
        reattachSession: () => {},
      },
      2, // fail on the 2nd row processed
    );
    failing.tick(); // bootstrap: no messages yet, cursor -> 0

    insertMessage('s1', 'assistant', { finish_reason: 'stop' }); // row 1 (succeeds)
    insertMessage('s1', 'assistant', { finish_reason: 'stop' }); // row 2 (forced failure)
    insertMessage('s1', 'assistant', { finish_reason: 'stop' }); // row 3 (not yet reached)

    failing.tick(); // processes row 1, throws on row 2, drops the connection

    expect(failing.cursorForTest).toBe(1); // advanced past row 1 only
    expect(events.filter((e) => e.envelope.hook_event_name === 'Stop')).toHaveLength(1);

    failing.tick(); // reconnects, re-reads rows > 1 (i.e. rows 2 and 3)

    expect(failing.cursorForTest).toBe(3);
    // Row 1's Stop was not re-emitted; rows 2 and 3 were each emitted exactly once.
    expect(events.filter((e) => e.envelope.hook_event_name === 'Stop')).toHaveLength(3);

    failing.stop(); // close the extra connection this test opened
  });

  // Finding 2: a session that has already ended (ended_at set) must not be
  // re-announced when a trailing message row for it is processed later (e.g.
  // once it finally surfaces past HERMES_MAX_ROWS_PER_TICK backpressure). No
  // SessionStart, and consequently no immediate SessionEnd flash either, since
  // the session is never added to `known`.
  it('does not announce SessionStart for a trailing row whose session already ended', () => {
    poller.tick(); // bootstrap: no messages yet, cursor -> 0

    db.prepare(
      'INSERT INTO sessions (id, source, cwd, started_at, ended_at, end_reason) VALUES (?,?,?,?,?,?)',
    ).run('s_done', 'cli', '/proj/b', NOW_S - 100, NOW_S - 10, 'user_exit');
    insertMessage('s_done', 'assistant', { finish_reason: 'stop' });

    poller.tick();

    expect(events.some((e) => e.envelope.hook_event_name === 'SessionStart')).toBe(false);
    expect(events.some((e) => e.envelope.hook_event_name === 'SessionEnd')).toBe(false);
  });

  // Task 10 (persona continuity): a persona (source+cwd) that already has an
  // agent must reattach the new session id to it instead of spawning a fresh
  // character. This is a characterization test — announceSession's reattach
  // branch landed in Task 9; the new pieces this task adds are personaKey
  // persistence and runtime.reattachSession (covered elsewhere).
  it('reattaches a new session id to an existing persona instead of spawning', () => {
    const reattached: Array<{ agentId: number; sessionId: string }> = [];
    const p = new HermesPoller({
      dbPath,
      onEvent: (pid, env) => events.push({ providerId: pid, envelope: env }),
      resolvePersonaAgent: (key) => (key === 'cli:/proj/a' ? 7 : undefined),
      reattachSession: (agentId, sessionId) => reattached.push({ agentId, sessionId }),
    });
    insertSession('s2', 'cli', '/proj/a');
    insertMessage('s2', 'user');
    p.tick();
    expect(reattached).toEqual([{ agentId: 7, sessionId: 's2' }]);
    expect(events.filter((e) => e.envelope.hook_event_name === 'SessionStart')).toHaveLength(0);
    p.stop();
  });

  // persona_key must be included on genuine (non-reattach) SessionStart envelopes
  // too, so the hookEventHandler can stamp it on the newly-created agent and a
  // later restart of the same persona can find and reattach to it.
  it('includes persona_key on SessionStart envelopes', () => {
    insertSession('s1', 'cli', '/proj/a');
    insertMessage('s1', 'user');
    poller.tick();
    const start = events.find((e) => e.envelope.hook_event_name === 'SessionStart');
    expect(start?.envelope.persona_key).toBe('cli:/proj/a');
  });

  // A cwd-less session (the Hermes webui runs with cwd NULL) has no directory
  // basename to name the character after -- the SessionStart envelope must carry
  // a folder_hint ('hermes-<source>') so adoption can fall back to it.
  it('sets folder_hint hermes-<source> on SessionStart for a cwd-less session', () => {
    insertSession('s_web', 'webui', null);
    insertMessage('s_web', 'user');
    poller.tick();
    const start = events.find((e) => e.envelope.hook_event_name === 'SessionStart');
    expect(start?.envelope.session_id).toBe('s_web');
    expect(start?.envelope.cwd).toBeUndefined();
    expect(start?.envelope.folder_hint).toBe('hermes-webui');
  });

  it('omits folder_hint when the session has a real cwd', () => {
    insertSession('s1', 'cli', '/proj/a');
    insertMessage('s1', 'user');
    poller.tick();
    const start = events.find((e) => e.envelope.hook_event_name === 'SessionStart');
    expect(start?.envelope.folder_hint).toBeUndefined();
  });

  // Wave 4 FIX 8: idle sessions never produce a follow-up event, so the
  // handler's pending->confirmation filter (built for transient Claude
  // Extension sessions) would park them as "pending" forever. The poller has
  // already verified liveness (DB holders / fresh rows), so it vouches for
  // the session inline and the handler adopts immediately.
  it('marks SessionStart envelopes confirmed (poller-vouched liveness)', () => {
    insertSession('s1', 'cli', '/proj/a');
    insertMessage('s1', 'user');
    poller.tick();
    const start = events.find((e) => e.envelope.hook_event_name === 'SessionStart');
    expect(start?.envelope.confirmed).toBe(true);
  });

  // exp_bucket keys directory-scoped EXP for hermes agents: always the stable
  // persona bucket ('hermes-<source>'), never the raw cwd, so leveling survives
  // session-id rotation and cwd churn.
  it('includes exp_bucket hermes-<source> on every SessionStart envelope', () => {
    insertSession('s_web', 'webui', null);
    insertMessage('s_web', 'user');
    insertSession('s_cli', 'cli', '/proj/a');
    insertMessage('s_cli', 'user');
    poller.tick();
    const starts = events.filter((e) => e.envelope.hook_event_name === 'SessionStart');
    const web = starts.find((e) => e.envelope.session_id === 's_web');
    const cli = starts.find((e) => e.envelope.session_id === 's_cli');
    expect(web?.envelope.exp_bucket).toBe('hermes-webui');
    expect(cli?.envelope.exp_bucket).toBe('hermes-cli');
  });
});

// Output-token EXP: sessions.output_tokens is CUMULATIVE per session. The
// poller tracks the last-seen value per known session (piggybacking reapEnded's
// per-session query) and credits positive deltas to the stable persona bucket
// via directoryStats. HOME is redirected so the debounced stats save never
// touches the real ~/.pixel-agents.
describe('HermesPoller: output-token EXP (persona buckets)', () => {
  let prevHome: string | undefined;
  let expEvents: Array<{ directory: string; totalExp: number }>;
  let poller: HermesPoller;

  beforeEach(() => {
    prevHome = process.env.HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hermes-exp-'));
    process.env.HOME = tmpDir;
    __resetDirectoryStatsForTest();
    dbPath = path.join(tmpDir, 'state.db');
    db = makeDb(dbPath);
    events = [];
    expEvents = [];
    poller = new HermesPoller({
      dbPath,
      onEvent: (providerId, envelope) => events.push({ providerId, envelope }),
      resolvePersonaAgent: () => undefined,
      reattachSession: () => {},
      onDirectoryExp: (directory, totalExp) => expEvents.push({ directory, totalExp }),
    });
  });

  afterEach(() => {
    poller.stop();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    __resetDirectoryStatsForTest();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setOutputTokens(sessionId: string, tokens: number): void {
    db.prepare('UPDATE sessions SET output_tokens = ? WHERE id = ?').run(tokens, sessionId);
  }

  it('credits a positive output_tokens delta to the persona bucket exactly once', () => {
    insertSession('s_web', 'webui', null);
    insertMessage('s_web', 'user');
    setOutputTokens('s_web', 100);

    poller.tick(); // bootstrap: announce s_web
    poller.tick(); // first reapEnded pass: baseline 100, no credit
    expect(getDirectoryExp('hermes-webui')).toBe(0);
    expect(expEvents).toEqual([]);

    setOutputTokens('s_web', 250);
    poller.tick(); // delta 150 -> credit
    expect(getDirectoryExp('hermes-webui')).toBe(150);
    expect(expEvents).toEqual([{ directory: 'hermes-webui', totalExp: 150 }]);
  });

  it('does not credit unchanged counters, and never credits a backward reset', () => {
    insertSession('s_web', 'webui', null);
    insertMessage('s_web', 'user');
    setOutputTokens('s_web', 100);

    poller.tick(); // bootstrap
    poller.tick(); // baseline 100
    poller.tick(); // unchanged -> no credit
    expect(getDirectoryExp('hermes-webui')).toBe(0);
    expect(expEvents).toEqual([]);

    setOutputTokens('s_web', 40); // counter reset backward (e.g. session restart)
    poller.tick(); // no negative credit; new baseline 40
    expect(getDirectoryExp('hermes-webui')).toBe(0);
    expect(expEvents).toEqual([]);

    setOutputTokens('s_web', 60);
    poller.tick(); // growth from the new baseline credits normally
    expect(getDirectoryExp('hermes-webui')).toBe(20);
    expect(expEvents).toEqual([{ directory: 'hermes-webui', totalExp: 20 }]);
  });

  it('tolerates a sessions schema without output_tokens (older hermes): no throw, reaping still works', () => {
    // Older hermes DBs predate the output_tokens column. The extended query
    // must fall back instead of throwing out of the tick forever.
    const oldDbPath = path.join(tmpDir, 'old-state.db');
    const oldDb = new DatabaseSync(oldDbPath);
    oldDb.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, cwd TEXT,
        started_at REAL NOT NULL, ended_at REAL, end_reason TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT,
        tool_name TEXT, timestamp REAL NOT NULL, finish_reason TEXT
      );
    `);
    oldDb
      .prepare('INSERT INTO sessions (id, source, cwd, started_at) VALUES (?,?,?,?)')
      .run('s_old_schema', 'cli', '/proj/a', NOW_S);
    oldDb
      .prepare('INSERT INTO messages (session_id, role, timestamp) VALUES (?,?,?)')
      .run('s_old_schema', 'user', NOW_S);

    const p = new HermesPoller({
      dbPath: oldDbPath,
      onEvent: (providerId, envelope) => events.push({ providerId, envelope }),
      resolvePersonaAgent: () => undefined,
      reattachSession: () => {},
      onDirectoryExp: (directory, totalExp) => expEvents.push({ directory, totalExp }),
    });

    expect(() => {
      p.tick(); // bootstrap
      p.tick(); // reapEnded: extended query fails once, falls back
      p.tick();
    }).not.toThrow();
    expect(expEvents).toEqual([]);

    // ended_at reaping still functions on the fallback query
    oldDb
      .prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?')
      .run(NOW_S + 10, 'user_exit', 's_old_schema');
    p.tick();
    expect(
      events.some(
        (e) =>
          e.envelope.hook_event_name === 'SessionEnd' && e.envelope.session_id === 's_old_schema',
      ),
    ).toBe(true);

    p.stop();
    oldDb.close();
  });
});

// Process-backed bootstrap: a live-flagged Hermes session with no recent
// message rows is still alive if a foreign process (e.g. QuantBot/Hermes's own
// agent) holds the DB open. `hasForeignDbHolders` is injected here (never the
// real lsof-backed default) so these tests don't depend on real processes.
describe('HermesPoller: process-backed bootstrap (foreign DB holders)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hermes-holders-'));
    dbPath = path.join(tmpDir, 'state.db');
    db = makeDb(dbPath);
    events = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePoller(hasForeignDbHolders: () => boolean): HermesPoller {
    return new HermesPoller({
      dbPath,
      onEvent: (providerId, envelope) => events.push({ providerId, envelope }),
      resolvePersonaAgent: () => undefined,
      reattachSession: () => {},
      hasForeignDbHolders,
    });
  }

  it('holders=false does not adopt an idle live session at bootstrap (existing behavior preserved)', () => {
    const t0 = NOW_S - 3600; // well past HERMES_ACTIVE_THRESHOLD_MS, no messages at all
    db.prepare('INSERT INTO sessions (id, source, cwd, started_at) VALUES (?,?,?,?)').run(
      's_idle',
      'cli',
      '/proj/a',
      t0,
    );
    const p = makePoller(() => false);
    p.tick();
    expect(events.some((e) => e.envelope.hook_event_name === 'SessionStart')).toBe(false);
    p.stop();
  });

  it('holders=true adopts only the newest idle live session per persona at bootstrap', () => {
    const t0 = NOW_S - 3600;
    db.prepare('INSERT INTO sessions (id, source, cwd, started_at) VALUES (?,?,?,?)').run(
      's_old',
      'cli',
      '/proj/a',
      t0,
    );
    db.prepare('INSERT INTO sessions (id, source, cwd, started_at) VALUES (?,?,?,?)').run(
      's_new',
      'cli',
      '/proj/a',
      t0 + 100,
    );
    const p = makePoller(() => true);
    p.tick();
    const starts = events.filter((e) => e.envelope.hook_event_name === 'SessionStart');
    expect(starts).toHaveLength(1);
    expect(starts[0]?.envelope.session_id).toBe('s_new');
    p.stop();
  });

  it('a processBacked session survives inactivity reap while holders=true, and is reaped once holders flips false', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_S * 1000);

    const t0 = NOW_S - 3600;
    db.prepare('INSERT INTO sessions (id, source, cwd, started_at) VALUES (?,?,?,?)').run(
      's_live',
      'cli',
      '/proj/a',
      t0,
    );

    let holders = true;
    const p = makePoller(() => holders);
    p.tick(); // bootstrap: adopts s_live via the process-backed path
    expect(
      events.some(
        (e) => e.envelope.hook_event_name === 'SessionStart' && e.envelope.session_id === 's_live',
      ),
    ).toBe(true);
    events = [];

    vi.advanceTimersByTime(HERMES_INACTIVITY_TIMEOUT_MS + 60_000); // well past inactivity timeout
    p.tick(); // reapEnded runs; holders still true -> must NOT reap
    expect(events.some((e) => e.envelope.hook_event_name === 'SessionEnd')).toBe(false);

    holders = false; // process exits
    p.tick(); // reapEnded runs again; holders now false -> normal inactivity rules apply
    const end = events.find((e) => e.envelope.hook_event_name === 'SessionEnd');
    expect(end?.envelope.session_id).toBe('s_live');

    p.stop();
  });
});

describe('hermesProvider.normalizeHookEvent (Finding 3)', () => {
  it('PostToolUse uses the real tool_call_id when present', () => {
    const n = hermesProvider.normalizeHookEvent({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_call_id: 'call_9',
    });
    expect(n?.event).toEqual({ kind: 'toolEnd', toolId: 'call_9' });
  });

  it("PostToolUse falls back to 'current' when tool_call_id is missing", () => {
    const n = hermesProvider.normalizeHookEvent({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
    });
    expect(n?.event).toEqual({ kind: 'toolEnd', toolId: 'current' });
  });
});
