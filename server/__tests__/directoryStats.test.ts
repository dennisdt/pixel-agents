import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetDirectoryStatsForTest,
  creditDirectoryTokens,
  creditHistoricalSession,
  flushDirectoryStats,
  getDirectoryExp,
  getDirectoryStatsSnapshot,
  loadDirectoryStats,
} from '../src/directoryStats.js';

let tmpHome: string;
let prevHome: string | undefined;

function statsPath(): string {
  return path.join(tmpHome, '.pixel-agents', 'directory-stats.json');
}

function writeStatsFile(contents: unknown): void {
  const dir = path.join(tmpHome, '.pixel-agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statsPath(), JSON.stringify(contents));
}

beforeEach(() => {
  prevHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-dirstats-'));
  process.env.HOME = tmpHome;
  __resetDirectoryStatsForTest();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('directoryStats', () => {
  it('loads the current { stats, credited_sessions } format', () => {
    const jsonl = path.join(tmpHome, 's.jsonl');
    writeStatsFile({ stats: { '/proj/a': 5000 }, credited_sessions: [jsonl] });
    loadDirectoryStats();
    expect(getDirectoryExp('/proj/a')).toBe(5000);
    expect(getDirectoryStatsSnapshot()).toEqual({ '/proj/a': 5000 });
    // this transcript is already credited → crediting it again is a no-op
    fs.writeFileSync(jsonl, JSON.stringify({ message: { usage: { output_tokens: 999 } } }) + '\n');
    expect(creditHistoricalSession(jsonl, '/proj/a', true)).toBe(5000);
  });

  it('loads the legacy flat-map format', () => {
    writeStatsFile({ '/proj/legacy': 1234 });
    loadDirectoryStats();
    expect(getDirectoryExp('/proj/legacy')).toBe(1234);
  });

  it('accumulates live token deltas per cwd', () => {
    loadDirectoryStats();
    expect(creditDirectoryTokens('/proj/a', 100)).toBe(100);
    expect(creditDirectoryTokens('/proj/a', 50)).toBe(150);
    expect(creditDirectoryTokens('/proj/b', 7)).toBe(7);
    expect(getDirectoryExp('/proj/a')).toBe(150);
    // non-positive / empty inputs are ignored
    expect(creditDirectoryTokens('/proj/a', 0)).toBe(150);
    expect(creditDirectoryTokens('', 100)).toBe(0);
  });

  it('credits a transcript historically exactly once (dedupe by file)', () => {
    loadDirectoryStats();
    const jsonl = path.join(tmpHome, 'hist.jsonl');
    fs.writeFileSync(
      jsonl,
      [
        JSON.stringify({ message: { usage: { output_tokens: 100 } } }),
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
        JSON.stringify({ message: { usage: { output_tokens: 200 } } }),
        '', // trailing blank line tolerated
      ].join('\n'),
    );
    expect(creditHistoricalSession(jsonl, '/proj/h', true)).toBe(300);
    // Second call for the same file does not re-add.
    expect(creditHistoricalSession(jsonl, '/proj/h', true)).toBe(300);
    expect(getDirectoryExp('/proj/h')).toBe(300);
  });

  it('does not sum the file when sumWholeFile is false (offset-0 / teammate agents)', () => {
    loadDirectoryStats();
    const jsonl = path.join(tmpHome, 'live.jsonl');
    fs.writeFileSync(jsonl, JSON.stringify({ message: { usage: { output_tokens: 500 } } }) + '\n');
    // Live pump credits the whole file, so historical must NOT sum it.
    expect(creditHistoricalSession(jsonl, '/proj/live', false)).toBe(0);
    expect(getDirectoryExp('/proj/live')).toBe(0);
    // Already credited → even a later EOF-seeded (true) call won't re-sum.
    expect(creditHistoricalSession(jsonl, '/proj/live', true)).toBe(0);
  });

  it('persists totals + credited files across a reload', () => {
    loadDirectoryStats();
    creditDirectoryTokens('/proj/a', 777);
    const jsonl = path.join(tmpHome, 'p.jsonl');
    fs.writeFileSync(jsonl, JSON.stringify({ message: { usage: { output_tokens: 10 } } }) + '\n');
    creditHistoricalSession(jsonl, '/proj/a', true); // +10 → 787, marks the file

    flushDirectoryStats();
    expect(fs.existsSync(statsPath())).toBe(true);

    __resetDirectoryStatsForTest();
    loadDirectoryStats();
    expect(getDirectoryExp('/proj/a')).toBe(787);
    // file survived as credited → no double count on relaunch
    expect(creditHistoricalSession(jsonl, '/proj/a', true)).toBe(787);
  });
});
