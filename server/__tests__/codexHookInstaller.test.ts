import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { installHooks, uninstallHooks, areHooksInstalled, trustHash } =
  await import('../src/providers/hook/codex/codexHookInstaller.js');

const REAL_COMMAND = 'node "/Users/dennistran/.pixel-agents/hooks/claude-hook.js"';

describe('trustHash (verified against live ~/.codex/config.toml)', () => {
  it('pre_tool_use with empty matcher', () => {
    expect(trustHash('PreToolUse', '', REAL_COMMAND, 5)).toBe(
      'sha256:c387de645b8f0cc87fd88c461a13d8109d94b29ea3b5101e4e4ff884f8dbfd48',
    );
  });
  it('stop with matcher omitted', () => {
    expect(trustHash('Stop', null, REAL_COMMAND, 5)).toBe(
      'sha256:2db559bb220b945bdc1ca53cf699654b3cd1acbeebac6795cf0db4828c21369c',
    );
  });
});

describe('codexHookInstaller', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-codex-test-'));
    fs.mkdirSync(path.join(tmpBase, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(tmpBase, '.codex', 'config.toml'), 'model = "gpt-5.2-codex"\n');
  });
  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('writes hooks.json entries for all six events with codex argv', async () => {
    await installHooks();
    const hooks = JSON.parse(
      fs.readFileSync(path.join(tmpBase, '.codex', 'hooks.json'), 'utf-8'),
    ) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> };
    expect(Object.keys(hooks.hooks).sort()).toEqual(
      [
        'PermissionRequest',
        'PostToolUse',
        'PreToolUse',
        'SessionStart',
        'Stop',
        'UserPromptSubmit',
      ].sort(),
    );
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toMatch(/claude-hook\.js" codex$/);
    expect(hooks.hooks.PreToolUse[0].matcher).toBe('');
    expect(hooks.hooks.Stop[0].matcher).toBeUndefined();
  });

  it('upserts matching trusted_hash entries into config.toml', async () => {
    await installHooks();
    const toml = fs.readFileSync(path.join(tmpBase, '.codex', 'config.toml'), 'utf-8');
    const hooksJsonPath = path.join(tmpBase, '.codex', 'hooks.json');
    expect(toml).toContain(`[hooks.state."${hooksJsonPath}:pre_tool_use:0:0"]`);
    expect(toml).toContain('model = "gpt-5.2-codex"'); // untouched existing content
    // hash in file matches recomputation for the written command
    const hooks = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const cmd = hooks.hooks.PreToolUse[0].hooks[0].command;
    expect(toml).toContain(trustHash('PreToolUse', '', cmd, 5));
  });

  it('is idempotent and preserves foreign hook groups', async () => {
    fs.writeFileSync(
      path.join(tmpBase, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: '', hooks: [{ type: 'command', command: 'other-tool-hook', timeout: 3 }] },
          ],
        },
      }),
    );
    await installHooks();
    await installHooks();
    const hooks = JSON.parse(
      fs.readFileSync(path.join(tmpBase, '.codex', 'hooks.json'), 'utf-8'),
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(hooks.hooks.PreToolUse).toHaveLength(2); // foreign + ours, once
    // ours is at index 1 -> trust key uses group index 1
    const toml = fs.readFileSync(path.join(tmpBase, '.codex', 'config.toml'), 'utf-8');
    const hooksJsonPath = path.join(tmpBase, '.codex', 'hooks.json');
    expect(toml).toContain(`[hooks.state."${hooksJsonPath}:pre_tool_use:1:0"]`);
    expect(await areHooksInstalled()).toBe(true);
  });

  it('migrates a legacy no-argv install (the current live state)', async () => {
    // Old install: same script, no argv -> posted Codex events to /claude.
    fs.writeFileSync(
      path.join(tmpBase, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: 'node "/x/.pixel-agents/hooks/claude-hook.js"',
                  timeout: 5,
                },
              ],
            },
          ],
        },
      }),
    );
    expect(await areHooksInstalled()).toBe(false); // legacy form != correctly installed
    await installHooks();
    const hooks = JSON.parse(
      fs.readFileSync(path.join(tmpBase, '.codex', 'hooks.json'), 'utf-8'),
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(hooks.hooks.PreToolUse).toHaveLength(1); // legacy entry replaced, not kept
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toMatch(/ codex$/);
    expect(await areHooksInstalled()).toBe(true);
  });

  it('uninstall removes our groups and trust entries', async () => {
    await installHooks();
    await uninstallHooks();
    expect(fs.existsSync(path.join(tmpBase, '.codex', 'hooks.json'))).toBe(true);
    const hooks = JSON.parse(
      fs.readFileSync(path.join(tmpBase, '.codex', 'hooks.json'), 'utf-8'),
    ) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(hooks.hooks)).toHaveLength(0);
    const toml = fs.readFileSync(path.join(tmpBase, '.codex', 'config.toml'), 'utf-8');
    expect(toml).not.toContain('[hooks.state."');
    expect(await areHooksInstalled()).toBe(false);
  });

  it('no-ops when ~/.codex does not exist', async () => {
    fs.rmSync(path.join(tmpBase, '.codex'), { recursive: true, force: true });
    await expect(installHooks()).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(tmpBase, '.codex'))).toBe(false);
  });
});
