import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CodexTokenReader } from '../src/providers/hook/codex/codexTokenReader.js';

let tmpDir: string;
let file: string;
let reader: CodexTokenReader;

function tokenLine(outputTokens: number): string {
  return JSON.stringify({
    timestamp: '2026-07-02T00:00:00.000Z',
    type: 'token_count',
    info: { total_token_usage: { input_tokens: 10, output_tokens: outputTokens } },
  });
}

function append(text: string): void {
  fs.appendFileSync(file, text);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-codex-tokens-'));
  file = path.join(tmpDir, 'rollout-test.jsonl');
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: 'session_meta', payload: { session_id: 's1', cwd: '/proj' } })}\n`,
  );
  reader = new CodexTokenReader();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CodexTokenReader', () => {
  it('credits cumulative deltas for token_count lines appended after the first poll', () => {
    expect(reader.poll(file)).toBe(0); // baseline pass over existing content

    append(`${tokenLine(546)}\n`);
    expect(reader.poll(file)).toBe(546);

    append(`${tokenLine(555)}\n`);
    expect(reader.poll(file)).toBe(9);
  });

  it('persists offsets across reads: an already-read line is never re-credited', () => {
    reader.poll(file); // baseline
    append(`${tokenLine(5)}\n`);
    expect(reader.poll(file)).toBe(5);
    expect(reader.poll(file)).toBe(0); // nothing new
    expect(reader.poll(file)).toBe(0);
  });

  it('baselines existing token_count content on first sight without crediting (restart safety)', () => {
    // A server restart re-polls a rollout whose history was already credited in
    // a previous run. First sight must set the baseline, not re-credit ~22k.
    append(`${tokenLine(22_000)}\n`);
    expect(reader.poll(file)).toBe(0);

    append(`${tokenLine(22_100)}\n`);
    expect(reader.poll(file)).toBe(100);
  });

  it('carries a partial trailing line across polls', () => {
    reader.poll(file); // baseline
    const line = tokenLine(546);
    append(line.slice(0, 25)); // mid-record, no newline
    expect(reader.poll(file)).toBe(0);
    append(`${line.slice(25)}\n`);
    expect(reader.poll(file)).toBe(546);
  });

  it('skips malformed lines', () => {
    reader.poll(file); // baseline
    append('{"type":"token_count","info":{broken\n');
    append(`${tokenLine(10)}\n`);
    expect(reader.poll(file)).toBe(10);
  });

  it('never credits a negative delta when the cumulative counter resets backward', () => {
    reader.poll(file); // baseline
    append(`${tokenLine(100)}\n`);
    expect(reader.poll(file)).toBe(100);

    append(`${tokenLine(40)}\n`); // counter reset (e.g. compaction/rollover)
    expect(reader.poll(file)).toBe(0);

    append(`${tokenLine(50)}\n`); // growth from the new baseline
    expect(reader.poll(file)).toBe(10);
  });

  it('ignores non-token_count lines', () => {
    reader.poll(file); // baseline
    append(`${JSON.stringify({ type: 'response_item', payload: { text: 'hi' } })}\n`);
    append(`${tokenLine(7)}\n`);
    expect(reader.poll(file)).toBe(7);
  });

  it('returns 0 for a missing file', () => {
    expect(reader.poll(path.join(tmpDir, 'nope.jsonl'))).toBe(0);
  });

  it('re-baselines after truncation instead of crediting the whole replacement file', () => {
    reader.poll(file); // baseline
    append(`${tokenLine(100)}\n`);
    expect(reader.poll(file)).toBe(100);

    // File replaced with shorter content containing a token_count line.
    fs.writeFileSync(file, `${tokenLine(80)}\n`);
    expect(reader.poll(file)).toBe(0); // re-baseline, no credit

    append(`${tokenLine(90)}\n`);
    expect(reader.poll(file)).toBe(10);
  });

  it('forget() drops per-file state so a later poll re-baselines', () => {
    reader.poll(file); // baseline
    append(`${tokenLine(100)}\n`);
    expect(reader.poll(file)).toBe(100);

    reader.forget(file);
    expect(reader.poll(file)).toBe(0); // fresh baseline over the whole file
  });
});
