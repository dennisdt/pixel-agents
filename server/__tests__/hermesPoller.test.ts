import { DatabaseSync } from 'node:sqlite';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
      started_at REAL NOT NULL, ended_at REAL, end_reason TEXT
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
