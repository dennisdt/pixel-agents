import { DatabaseSync } from 'node:sqlite';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HermesPoller } from '../src/providers/hook/hermes/hermesPoller.js';

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
});
