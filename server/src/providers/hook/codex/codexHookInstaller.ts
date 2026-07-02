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

function readHooksFile(): CodexHooksFile {
  try {
    return JSON.parse(fs.readFileSync(hooksJsonPath(), 'utf-8')) as CodexHooksFile;
  } catch {
    return {};
  }
}

/** Strip trust-state sections whose key belongs to our hooks.json entries. */
function stripOurTrustEntries(toml: string): string {
  const keyPrefix = `[hooks.state."${hooksJsonPath()}:`;
  const lines = toml.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith('[')) skipping = line.startsWith(keyPrefix);
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

export function installHooks(): Promise<void> {
  if (!fs.existsSync(codexDir())) return Promise.resolve(); // Codex not installed

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
      next += `\n\n[hooks.state."${key}"]\ntrusted_hash = "${hash}"`;
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
  return Promise.resolve();
}

export function uninstallHooks(): Promise<void> {
  if (!fs.existsSync(hooksJsonPath())) return Promise.resolve();
  const file = readHooksFile();
  const hooks: Record<string, CodexMatcherGroup[]> = {};
  for (const [event, groups] of Object.entries(file.hooks ?? {})) {
    const kept = groups.filter((g) => !g.hooks.some(isOurs));
    if (kept.length > 0) hooks[event] = kept;
  }
  atomicWrite(hooksJsonPath(), JSON.stringify({ ...file, hooks }, null, 2) + '\n');
  if (fs.existsSync(configTomlPath())) {
    const toml = fs.readFileSync(configTomlPath(), 'utf-8');
    atomicWrite(configTomlPath(), stripOurTrustEntries(toml));
  }
  return Promise.resolve();
}

export function areHooksInstalled(): Promise<boolean> {
  const file = readHooksFile();
  const installed = Object.values(file.hooks ?? {}).some((groups) =>
    groups.some((g) => g.hooks.some(isOursCurrent)),
  );
  return Promise.resolve(installed);
}
