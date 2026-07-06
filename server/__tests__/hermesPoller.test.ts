import { DatabaseSync } from 'node:sqlite';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __resetDirectoryStatsForTest, getDirectoryExp } from '../src/directoryStats.js';
import {
  HERMES_AGENT_DISPLAY_NAME,
  HERMES_EXP_BUCKET,
  HERMES_QUANTBOT_SESSION_ID,
} from '../src/providers/hook/hermes/constants.js';
import { hermesProvider } from '../src/providers/hook/hermes/hermes.js';
import type { MessageRow } from '../src/providers/hook/hermes/hermesPoller.js';
import { HermesPoller } from '../src/providers/hook/hermes/hermesPoller.js';

// `HermesPoller.processRow` is `protected` specifically so a test subclass can
// force a failure on an arbitrary row (the Nth row processed, regardless of
// which physical row it lands on) without needing to corrupt the DB mid-read.
// `cursorForTest` exposes the otherwise-protected cursor so the test can
// assert it never advances past a row whose processing threw.
class RowFailurePoller extends HermesPoller {
  private callCount = 0;

  constructor(
    opts: ConstructorParameters<typeof HermesPoller>[0],
    private readonly failOnCall: number,
  ) {
    super(opts);
  }

  protected override processRow(row: MessageRow): void {
    this.callCount += 1;
    if (this.callCount === this.failOnCall) {
      throw new Error('synthetic row failure (cursor-integrity test)');
    }
    super.processRow(row);
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

// epoch seconds, matches Hermes REAL format.
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

function setOutputTokens(sessionId: string, tokens: number): void {
  db.prepare('UPDATE sessions SET output_tokens = ? WHERE id = ?').run(tokens, sessionId);
}

// The poller collapses ALL Hermes DB activity into ONE synthetic "QuantBot"
// character rather than one per (source, cwd) session context. Existence is
// gated purely on `hasForeignDbHolders()` (injected below in every test --
// never the real lsof-backed default, and never `sessions.ended_at`, which
// Hermes almost never sets).
describe('HermesPoller: QuantBot bootstrap (fan-in aggregator, no per-persona enumeration)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hermes-'));
    dbPath = path.join(tmpDir, 'state.db');
    db = makeDb(dbPath);
    events = [];
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePoller(hasForeignDbHolders: () => boolean): HermesPoller {
    return new HermesPoller({
      dbPath,
      onEvent: (providerId, envelope) => events.push({ providerId, envelope }),
      hasForeignDbHolders,
    });
  }

  it('holders=true, empty-ish DB -> exactly one SessionStart for the synthetic QuantBot id', () => {
    // Pre-existing real sessions (webui + cli personas) simulate this machine's
    // actual history -- neither should get its own SessionStart.
    insertSession('s_cli', 'cli', '/proj/a');
    insertMessage('s_cli', 'user');
    insertSession('s_web', 'webui', null);
    insertMessage('s_web', 'user');

    const p = makePoller(() => true);
    p.tick();

    const starts = events.filter((e) => e.envelope.hook_event_name === 'SessionStart');
    expect(starts).toHaveLength(1);
    expect(starts[0]?.envelope).toMatchObject({
      session_id: HERMES_QUANTBOT_SESSION_ID,
      persona_key: 'quantbot',
      folder_hint: HERMES_AGENT_DISPLAY_NAME,
      exp_bucket: HERMES_EXP_BUCKET,
      confirmed: true,
      source: 'external',
    });
    p.stop();
  });

  it('holders=false -> no SessionStart at all', () => {
    insertSession('s_cli', 'cli', '/proj/a');
    insertMessage('s_cli', 'user');

    const p = makePoller(() => false);
    p.tick();

    expect(events.some((e) => e.envelope.hook_event_name === 'SessionStart')).toBe(false);
    p.stop();
  });

  it('does not replay history: first tick sets cursor to MAX(id), so a preexisting row never emits', () => {
    insertSession('s_old', 'cli', '/proj/ancient');
    insertMessage('s_old', 'assistant', { finish_reason: 'stop' });

    const p = makePoller(() => true);
    p.tick();

    expect(events.filter((e) => e.envelope.hook_event_name === 'Stop')).toHaveLength(0);
    p.stop();
  });

  it('survives a missing db file (no throw, no events)', () => {
    const p = new HermesPoller({
      dbPath: path.join(tmpDir, 'nope.db'),
      onEvent: (providerId, envelope) => events.push({ providerId, envelope }),
      hasForeignDbHolders: () => false,
    });
    expect(() => p.tick()).not.toThrow();
    expect(events).toHaveLength(0);
  });
});

describe('HermesPoller: fan-in — all real sessions animate the single QuantBot character', () => {
  let poller: HermesPoller;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hermes-fanin-'));
    dbPath = path.join(tmpDir, 'state.db');
    db = makeDb(dbPath);
    events = [];
    poller = new HermesPoller({
      dbPath,
      onEvent: (providerId, envelope) => events.push({ providerId, envelope }),
      hasForeignDbHolders: () => true,
    });
  });

  afterEach(() => {
    poller.stop();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rewrites tool/turn activity from two different real session_ids onto the synthetic id', () => {
    insertSession('s_web', 'webui', null);
    insertSession('s_cli', 'cli', '/proj/a');
    poller.tick(); // bootstrap

    insertMessage('s_web', 'assistant', {
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
    insertMessage('s_web', 'tool', { tool_call_id: 'call_1', tool_name: 'web_search' });
    insertMessage('s_cli', 'assistant', { finish_reason: 'stop' });
    poller.tick();

    const mapped = events.filter((e) =>
      ['PreToolUse', 'PostToolUse', 'Stop'].includes(e.envelope.hook_event_name as string),
    );
    expect(mapped).toHaveLength(3);
    for (const e of mapped) expect(e.envelope.session_id).toBe(HERMES_QUANTBOT_SESSION_ID);

    const pre = events.find((e) => e.envelope.hook_event_name === 'PreToolUse');
    expect(pre?.envelope.tool_name).toBe('web_search');
    expect(pre?.envelope.tool_input).toEqual({ query: 'btc' });
    expect(pre?.envelope.tool_call_id).toBe('call_1');

    const post = events.find((e) => e.envelope.hook_event_name === 'PostToolUse');
    expect(post?.envelope.tool_call_id).toBe('call_1');

    expect(events.some((e) => e.envelope.hook_event_name === 'Stop')).toBe(true);
  });

  // A throw mid-row (e.g. a WAL checkpoint race) must not advance the cursor
  // past the failed row, and rows already fully processed before the failure
  // must not be re-emitted on retry.
  it('does not advance the cursor past a row that throws, and retries it cleanly without re-emitting prior rows', () => {
    insertSession('s1');
    const failing = new RowFailurePoller(
      {
        dbPath,
        onEvent: (pid, env) => events.push({ providerId: pid, envelope: env }),
        hasForeignDbHolders: () => true,
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
});

describe('HermesPoller: liveness transitions gate QuantBot existence', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hermes-liveness-'));
    dbPath = path.join(tmpDir, 'state.db');
    db = makeDb(dbPath);
    events = [];
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('holders present->absent emits SessionEnd; absent->present re-announces (idempotent)', () => {
    let holders = true;
    const p = new HermesPoller({
      dbPath,
      onEvent: (providerId, envelope) => events.push({ providerId, envelope }),
      hasForeignDbHolders: () => holders,
    });

    p.tick(); // bootstrap: holders true -> SessionStart
    expect(events.filter((e) => e.envelope.hook_event_name === 'SessionStart')).toHaveLength(1);
    events = [];

    p.tick(); // still true -> no repeat announcement
    expect(events).toHaveLength(0);

    holders = false;
    p.tick(); // true -> false: SessionEnd
    expect(events).toHaveLength(1);
    expect(events[0]?.envelope).toMatchObject({
      hook_event_name: 'SessionEnd',
      session_id: HERMES_QUANTBOT_SESSION_ID,
    });
    events = [];

    p.tick(); // still false -> no repeat SessionEnd
    expect(events).toHaveLength(0);

    holders = true;
    p.tick(); // false -> true: re-announce. The handler treats a SessionStart
    // for an already-known session id as a no-op confirmation, so re-emitting
    // the same envelope shape on every false->true flip is safe either way --
    // here the prior SessionEnd already tore the agent down, so this creates
    // a fresh QuantBot.
    const starts = events.filter((e) => e.envelope.hook_event_name === 'SessionStart');
    expect(starts).toHaveLength(1);
    expect(starts[0]?.envelope.session_id).toBe(HERMES_QUANTBOT_SESSION_ID);

    p.stop();
  });
});

// Output-token EXP: sessions.output_tokens is CUMULATIVE per real session. The
// poller tracks the last-seen value per real session that has produced a row
// since boot, and credits positive deltas to the SINGLE hermes bucket via
// directoryStats (all real sessions pool together -- they're all QuantBot).
// HOME is redirected so the debounced stats save never touches ~/.pixel-agents.
describe('HermesPoller: output-token EXP pools into the single hermes bucket', () => {
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
      hasForeignDbHolders: () => true,
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

  it('credits a positive output_tokens delta to the hermes bucket exactly once', () => {
    insertSession('s_web', 'webui', null);
    poller.tick(); // bootstrap: cursor -> 0 (no messages yet)

    insertMessage('s_web', 'user'); // new row post-boot: starts EXP tracking for s_web
    setOutputTokens('s_web', 100);
    poller.tick(); // registers s_web, baseline 100, no credit
    expect(getDirectoryExp(HERMES_EXP_BUCKET)).toBe(0);
    expect(expEvents).toEqual([]);

    setOutputTokens('s_web', 250);
    poller.tick(); // delta 150 -> credit
    expect(getDirectoryExp(HERMES_EXP_BUCKET)).toBe(150);
    expect(expEvents).toEqual([{ directory: HERMES_EXP_BUCKET, totalExp: 150 }]);
  });

  it('does not credit unchanged counters, and never credits a backward reset', () => {
    insertSession('s_web', 'webui', null);
    poller.tick(); // bootstrap

    insertMessage('s_web', 'user');
    setOutputTokens('s_web', 100);
    poller.tick(); // baseline 100
    poller.tick(); // unchanged -> no credit
    expect(getDirectoryExp(HERMES_EXP_BUCKET)).toBe(0);
    expect(expEvents).toEqual([]);

    setOutputTokens('s_web', 40); // counter reset backward (e.g. session restart)
    poller.tick(); // no negative credit; new baseline 40
    expect(getDirectoryExp(HERMES_EXP_BUCKET)).toBe(0);
    expect(expEvents).toEqual([]);

    setOutputTokens('s_web', 60);
    poller.tick(); // growth from the new baseline credits normally
    expect(getDirectoryExp(HERMES_EXP_BUCKET)).toBe(20);
    expect(expEvents).toEqual([{ directory: HERMES_EXP_BUCKET, totalExp: 20 }]);
  });

  it("pools two different sessions' deltas into the same hermes bucket", () => {
    insertSession('s_web', 'webui', null);
    insertSession('s_cli', 'cli', '/proj/a');
    poller.tick(); // bootstrap

    insertMessage('s_web', 'user');
    insertMessage('s_cli', 'user');
    setOutputTokens('s_web', 100);
    setOutputTokens('s_cli', 50);
    poller.tick(); // both register + baseline, no credit

    setOutputTokens('s_web', 130); // +30
    setOutputTokens('s_cli', 80); // +30
    poller.tick(); // both credit -> pooled total 60
    expect(getDirectoryExp(HERMES_EXP_BUCKET)).toBe(60);
    expect(expEvents).toEqual([
      { directory: HERMES_EXP_BUCKET, totalExp: 30 },
      { directory: HERMES_EXP_BUCKET, totalExp: 60 },
    ]);
  });

  it('tolerates a sessions schema without output_tokens (older hermes): no throw, row mapping still works', () => {
    // Older hermes DBs predate the output_tokens column. Row mapping no longer
    // touches the sessions table at all, so Stop/PreToolUse/PostToolUse must
    // keep working; only EXP crediting silently no-ops.
    const oldDbPath = path.join(tmpDir, 'old-state.db');
    const oldDb = new DatabaseSync(oldDbPath);
    oldDb.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, cwd TEXT, started_at REAL NOT NULL
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

    const p = new HermesPoller({
      dbPath: oldDbPath,
      onEvent: (providerId, envelope) => events.push({ providerId, envelope }),
      hasForeignDbHolders: () => true,
      onDirectoryExp: (directory, totalExp) => expEvents.push({ directory, totalExp }),
    });

    expect(() => {
      p.tick(); // bootstrap
      oldDb
        .prepare(
          'INSERT INTO messages (session_id, role, timestamp, finish_reason) VALUES (?,?,?,?)',
        )
        .run('s_old_schema', 'assistant', NOW_S, 'stop');
      p.tick(); // processes the row (Stop fires fine); EXP query fails silently
      p.tick();
    }).not.toThrow();

    expect(events.some((e) => e.envelope.hook_event_name === 'Stop')).toBe(true);
    expect(expEvents).toEqual([]);

    p.stop();
    oldDb.close();
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
