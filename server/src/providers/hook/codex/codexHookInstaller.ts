import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import { CLAUDE_HOOK_SCRIPT_NAME } from '../claude/constants.js';
import {
  CODEX_HOOK_EVENTS,
  CODEX_HOOK_TIMEOUT_SEC,
  CODEX_MATCHERLESS_EVENTS,
  CODEX_SNAKE_LABELS,
} from './constants.js';

type CodexEvent = (typeof CODEX_HOOK_EVENTS)[number];

interface CodexHookHandler {
  type: string;
  command: string;
  timeout?: number;
}
interface CodexMatcherGroup {
  matcher?: string;
  hooks: CodexHookHandler[];
}
interface CodexHooksFile {
  hooks?: Record<string, CodexMatcherGroup[]>;
  [key: string]: unknown;
}

function codexDir(): string {
  return path.join(os.homedir(), '.codex');
}
function hooksJsonPath(): string {
  return path.join(codexDir(), 'hooks.json');
}
function configTomlPath(): string {
  return path.join(codexDir(), 'config.toml');
}
function hookScriptPath(): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, CLAUDE_HOOK_SCRIPT_NAME);
}
function makeCommand(): string {
  // Same physical script as Claude's; argv selects the /api/hooks/codex route.
  return `node "${hookScriptPath()}" codex`;
}
/** Any entry running our hook script — INCLUDING the legacy no-argv form that
 *  posted Codex events to /api/hooks/claude. Removal must catch both so
 *  install migrates old entries instead of leaving them impersonating Claude. */
function isOurs(h: CodexHookHandler): boolean {
  return h.command.includes(CLAUDE_HOOK_SCRIPT_NAME);
}
/** Only the current (codex-argv) form counts as correctly installed. */
function isOursCurrent(h: CodexHookHandler): boolean {
  return isOurs(h) && / codex$/.test(h.command);
}

// ── Trust hash: replicates Codex's command_hook_hash (verified 2026-07-01
// against openai/codex@129ea2a and this machine's live config.toml).
// Preimage: compact JSON, keys sorted recursively, of
// { event_name, matcher?, hooks: [{async:false, command, timeout, type:'command'}] }
// Stop/UserPromptSubmit omit the matcher key entirely.
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function trustHash(
  event: CodexEvent,
  matcher: string | null,
  command: string,
  timeoutSec: number,
): string {
  const identity: Record<string, unknown> = {
    event_name: CODEX_SNAKE_LABELS[event],
    hooks: [{ async: false, command, timeout: Math.max(timeoutSec, 1), type: 'command' }],
  };
  if (matcher !== null) identity.matcher = matcher;
  const json = JSON.stringify(sortKeys(identity));
  return `sha256:${createHash('sha256').update(json).digest('hex')}`;
}

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.pixel-agents-tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** Read ~/.codex/hooks.json. A missing file is the normal fresh-install case
 *  and yields an empty file object. A file that EXISTS but fails to parse is
 *  a different situation entirely: silently treating it as empty would
 *  clobber whatever foreign/hand-edited content lives there on the next
 *  write, so that case throws instead and leaves the file untouched. */
function readHooksFile(): CodexHooksFile {
  if (!fs.existsSync(hooksJsonPath())) return {};
  const raw = fs.readFileSync(hooksJsonPath(), 'utf-8');
  try {
    return JSON.parse(raw) as CodexHooksFile;
  } catch (e) {
    throw new Error(
      `[Pixel Agents] ~/.codex/hooks.json (${hooksJsonPath()}) is not valid JSON (${e}); ` +
        `left untouched. Fix or remove the file by hand, then retry.`,
    );
  }
}

/** Escape a string for embedding in a TOML basic (double-quoted) string.
 *  Trust-state keys embed the raw hooks.json path — on Windows that path
 *  contains backslashes, which start escape sequences in TOML basic
 *  strings, so it must be escaped both where we WRITE `[hooks.state."..."]`
 *  sections and where stripOurTrustEntries matches them back out. */
function escapeTomlKey(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Strip trust-state sections whose key belongs to our hooks.json entries.
 *  Relies on every section we write containing exactly one single-line
 *  `trusted_hash = "..."` key before the next `[` — if that shape ever
 *  grows (multi-line values, extra keys), revisit this next-`[`-line
 *  termination heuristic. */
function stripOurTrustEntries(toml: string): string {
  const keyPrefix = `[hooks.state."${escapeTomlKey(hooksJsonPath())}:`;
  const lines = toml.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith('[')) skipping = line.startsWith(keyPrefix);
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

/**
 * Install Pixel Agents hooks into ~/.codex/hooks.json and trust them in
 * ~/.codex/config.toml. No-ops if Codex isn't installed. Rejects if
 * hooks.json exists but is malformed JSON (left untouched), or if the
 * config.toml trust update fails — in which case hooks.json is rolled back
 * to its pre-call content (write-both-or-neither).
 */
export async function installHooks(): Promise<void> {
  if (!fs.existsSync(codexDir())) return; // Codex not installed

  const file = readHooksFile();
  const hooks: Record<string, CodexMatcherGroup[]> = file.hooks ?? {};
  const command = makeCommand();
  const trustEntries: Array<{ key: string; hash: string }> = [];

  for (const event of CODEX_HOOK_EVENTS) {
    const groups = (hooks[event] ?? []).filter((g) => !g.hooks.some(isOurs));
    const matcherless = CODEX_MATCHERLESS_EVENTS.has(event);
    const group: CodexMatcherGroup = {
      ...(matcherless ? {} : { matcher: '' }),
      hooks: [{ type: 'command', command, timeout: CODEX_HOOK_TIMEOUT_SEC }],
    };
    groups.push(group);
    hooks[event] = groups;
    const groupIndex = groups.length - 1;
    trustEntries.push({
      key: `${hooksJsonPath()}:${CODEX_SNAKE_LABELS[event]}:${groupIndex}:0`,
      hash: trustHash(event, matcherless ? null : '', command, CODEX_HOOK_TIMEOUT_SEC),
    });
  }

  // Write-both-or-neither: keep a backup of hooks.json until config.toml succeeds.
  const prevHooks = fs.existsSync(hooksJsonPath())
    ? fs.readFileSync(hooksJsonPath(), 'utf-8')
    : null;
  atomicWrite(hooksJsonPath(), JSON.stringify({ ...file, hooks }, null, 2) + '\n');
  try {
    const toml = fs.existsSync(configTomlPath()) ? fs.readFileSync(configTomlPath(), 'utf-8') : '';
    let next = stripOurTrustEntries(toml).trimEnd();
    for (const { key, hash } of trustEntries) {
      next += `\n\n[hooks.state."${escapeTomlKey(key)}"]\ntrusted_hash = "${hash}"`;
    }
    atomicWrite(configTomlPath(), next + '\n');
  } catch (e) {
    if (prevHooks !== null) atomicWrite(hooksJsonPath(), prevHooks);
    else fs.rmSync(hooksJsonPath(), { force: true });
    throw new Error(
      `[Pixel Agents] Codex trust update failed (${e}); hooks.json rolled back. ` +
        `Re-run, or trust the hooks manually in the Codex TUI.`,
    );
  }
}

/**
 * Remove Pixel Agents hooks from ~/.codex/hooks.json and their trust
 * entries from ~/.codex/config.toml. No-ops if hooks.json doesn't exist.
 * Rejects if hooks.json exists but is malformed JSON (left untouched), or
 * if the config.toml cleanup fails — in which case hooks.json is rolled
 * back to its pre-call content (same write-both-or-neither guarantee as
 * installHooks).
 */
export async function uninstallHooks(): Promise<void> {
  if (!fs.existsSync(hooksJsonPath())) return;
  const file = readHooksFile();
  const hooks: Record<string, CodexMatcherGroup[]> = {};
  for (const [event, groups] of Object.entries(file.hooks ?? {})) {
    const kept = groups.filter((g) => !g.hooks.some(isOurs));
    if (kept.length > 0) hooks[event] = kept;
  }

  // Write-both-or-neither, mirroring installHooks: keep a backup of
  // hooks.json until config.toml cleanup succeeds.
  const prevHooks = fs.readFileSync(hooksJsonPath(), 'utf-8');
  atomicWrite(hooksJsonPath(), JSON.stringify({ ...file, hooks }, null, 2) + '\n');
  if (fs.existsSync(configTomlPath())) {
    try {
      const toml = fs.readFileSync(configTomlPath(), 'utf-8');
      atomicWrite(configTomlPath(), stripOurTrustEntries(toml));
    } catch (e) {
      atomicWrite(hooksJsonPath(), prevHooks);
      throw new Error(
        `[Pixel Agents] Codex trust cleanup failed (${e}); hooks.json rolled back. ` +
          `Re-run, or remove the stale [hooks.state] entries manually from ~/.codex/config.toml.`,
      );
    }
  }
}

export async function areHooksInstalled(): Promise<boolean> {
  const file = readHooksFile();
  return Object.values(file.hooks ?? {}).some((groups) =>
    groups.some((g) => g.hooks.some(isOursCurrent)),
  );
}
