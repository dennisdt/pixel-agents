/**
 * Incremental output-token reader for Codex rollout files (directory EXP).
 *
 * Rollouts contain JSONL records `{"type":"token_count","info":{"total_token_usage":
 * {"output_tokens":N,...}}}` where N is CUMULATIVE for the session. This reader
 * keeps a per-file byte offset + partial-line remainder (same carry pattern as
 * fileWatcher's readNewLines) and reports the positive output-token delta since
 * the previous poll, so the caller can credit EXP without re-counting.
 *
 * First sight of a file is a BASELINE pass: existing content sets the last-seen
 * cumulative without crediting. This makes restarts safe (a rollout whose
 * history was already credited in a previous server run is never re-credited)
 * at the cost of not crediting pre-adoption history — codex records are not
 * Claude-transcript-shaped, so the historical crediting path (sumOutputTokens)
 * can't count them anyway.
 */

import * as fs from 'fs';

import { CODEX_TOKEN_COUNT_TYPE } from './constants.js';

interface FileState {
  /** Byte offset of the next unread byte. */
  offset: number;
  /** Unterminated trailing line carried to the next poll. */
  remainder: string;
  /** Last cumulative output_tokens seen (baseline for delta crediting). */
  lastCumulative: number;
}

/** Extract the cumulative output_tokens from one JSONL line, or null. */
function parseTokenCountLine(line: string): number | null {
  // Cheap pre-filter before JSON.parse: most rollout lines are not token counts.
  if (!line.includes(`"${CODEX_TOKEN_COUNT_TYPE}"`)) return null;
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return null; // malformed — skip
  }
  if (typeof rec !== 'object' || rec === null) return null;
  const r = rec as { type?: unknown; info?: { total_token_usage?: { output_tokens?: unknown } } };
  if (r.type !== CODEX_TOKEN_COUNT_TYPE) return null;
  const out = r.info?.total_token_usage?.output_tokens;
  if (typeof out !== 'number' || !Number.isFinite(out)) return null;
  return out;
}

export class CodexTokenReader {
  private readonly states = new Map<string, FileState>();

  /**
   * Read any new bytes of `rolloutFile` and return the positive output-token
   * delta since the previous poll (0 on baseline pass / no growth / errors).
   * Never throws — callers run this inside timer ticks.
   */
  poll(rolloutFile: string): number {
    try {
      return this.pollInner(rolloutFile);
    } catch {
      return 0;
    }
  }

  /** Drop per-file state (agent removed). A later poll re-baselines. */
  forget(rolloutFile: string): void {
    this.states.delete(rolloutFile);
  }

  private pollInner(rolloutFile: string): number {
    let size: number;
    try {
      size = fs.statSync(rolloutFile).size;
    } catch {
      return 0; // file missing — keep state in case it reappears
    }

    let state = this.states.get(rolloutFile);
    const baseline = state === undefined;
    if (state === undefined) {
      state = { offset: 0, remainder: '', lastCumulative: 0 };
      this.states.set(rolloutFile, state);
    } else if (size < state.offset) {
      // Truncated/replaced (rollouts are append-only, so this means a new
      // file). Re-baseline over the replacement instead of crediting it whole.
      state.offset = 0;
      state.remainder = '';
      state.lastCumulative = 0;
      return this.consume(rolloutFile, state, size, /* credit */ false);
    }

    return this.consume(rolloutFile, state, size, /* credit */ !baseline);
  }

  /** Read [state.offset, size), advance line state, return the credited delta. */
  private consume(rolloutFile: string, state: FileState, size: number, credit: boolean): number {
    if (size <= state.offset) return 0;

    const length = size - state.offset;
    const buf = Buffer.alloc(length);
    const fd = fs.openSync(rolloutFile, 'r');
    let bytesRead: number;
    try {
      bytesRead = fs.readSync(fd, buf, 0, length, state.offset);
    } finally {
      fs.closeSync(fd);
    }
    state.offset += bytesRead;

    const text = state.remainder + buf.toString('utf8', 0, bytesRead);
    const lines = text.split('\n');
    state.remainder = lines.pop() ?? '';

    let delta = 0;
    for (const line of lines) {
      const cumulative = parseTokenCountLine(line);
      if (cumulative === null) continue;
      if (cumulative > state.lastCumulative) {
        if (credit) delta += cumulative - state.lastCumulative;
        state.lastCumulative = cumulative;
      } else if (cumulative < state.lastCumulative) {
        // Counter reset backward (compaction/rollover): re-baseline, never
        // credit a negative delta.
        state.lastCumulative = cumulative;
      }
    }
    return delta;
  }
}
