/**
 * Small shared helpers for scanning Claude JSONL transcripts. Used by the
 * watcher (cwd resolution), the launcher (recent-project cwd), and the EXP
 * store (historical output_tokens) instead of re-implementing the read+parse
 * loop in each.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Read a JSONL file and visit each parsed record. Stops early (and returns the
 *  value) the first time `visit` returns a non-undefined value. */
function forEachJsonlRecord<T>(
  jsonlFile: string,
  visit: (rec: unknown) => T | undefined,
): T | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonlFile, 'utf8');
  } catch {
    return undefined; // missing/unreadable
  }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const got = visit(JSON.parse(line));
      if (got !== undefined) return got;
    } catch {
      /* skip malformed line */
    }
  }
  return undefined;
}

/** The first `cwd` field in a transcript (Claude records carry it).
 *
 *  Streams the file in chunks with an early exit instead of slurping it whole:
 *  this runs synchronously inside scan ticks and adoption, and transcripts can
 *  be very large — but the cwd is virtually always within the first records
 *  (not necessarily line 1: summary records can precede it). */
export function readCwdFromJsonl(jsonlFile: string): string | undefined {
  const CHUNK = 64 * 1024;
  let fd: number;
  try {
    fd = fs.openSync(jsonlFile, 'r');
  } catch {
    return undefined; // missing/unreadable
  }
  try {
    const buf = Buffer.alloc(CHUNK);
    let carry = '';
    const cwdOf = (line: string): string | undefined => {
      if (!line) return undefined;
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
        return typeof cwd === 'string' && cwd ? cwd : undefined;
      } catch {
        return undefined; // malformed line
      }
    };
    for (;;) {
      const bytesRead = fs.readSync(fd, buf, 0, CHUNK, null);
      if (bytesRead <= 0) return cwdOf(carry); // EOF: final line may lack '\n'
      const lines = (carry + buf.toString('utf8', 0, bytesRead)).split('\n');
      carry = lines.pop() ?? ''; // unterminated tail rides into the next chunk
      for (const line of lines) {
        const cwd = cwdOf(line);
        if (cwd) return cwd;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** The session's display label: the working-directory basename recorded in the
 *  transcript. The Claude project-dir hash is lossy — literal dashes in a folder
 *  name are indistinguishable from the path separators it also encodes as `-`, so
 *  deriving from it can only recover the last segment (e.g. the folder
 *  "prediction-market-trader" collapses to "trader"). The transcript's real `cwd`
 *  preserves the full name. Falls back to `fallback` when no cwd is recorded. */
export function folderNameFromCwd(cwd: string | undefined, fallback?: string): string | undefined {
  return cwd ? path.basename(cwd) : fallback;
}

/** Total assistant `output_tokens` across a transcript. */
export function sumOutputTokens(jsonlFile: string): number {
  let sum = 0;
  forEachJsonlRecord(jsonlFile, (rec) => {
    const out = (rec as { message?: { usage?: { output_tokens?: unknown } } }).message?.usage
      ?.output_tokens;
    if (typeof out === 'number' && Number.isFinite(out)) sum += out;
    return undefined; // never short-circuit; scan the whole file
  });
  return sum;
}
