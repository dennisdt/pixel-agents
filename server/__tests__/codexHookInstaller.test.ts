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

  it('preserves a foreign trust entry sharing the same hooks.json path; uninstall removes only ours', async () => {
    // A foreign group already occupies PreToolUse[0], so ours will land at
    // index 1 -- and the user (or another tool's installer) has separately
    // trusted that foreign group's hooks.json entry.
    const hooksJsonPathStr = path.join(tmpBase, '.codex', 'hooks.json');
    fs.writeFileSync(
      hooksJsonPathStr,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: '', hooks: [{ type: 'command', command: 'other-tool-hook', timeout: 3 }] },
          ],
        },
      }),
    );
    const foreignTrustSection = `[hooks.state."${hooksJsonPathStr}:pre_tool_use:0:0"]\ntrusted_hash = "sha256:foreign-deadbeef"\n`;
    fs.writeFileSync(
      path.join(tmpBase, '.codex', 'config.toml'),
      `model = "gpt-5.2-codex"\n\n${foreignTrustSection}`,
    );

    await installHooks();

    const tomlAfterInstall = fs.readFileSync(path.join(tmpBase, '.codex', 'config.toml'), 'utf-8');
    // Foreign trust entry survives untouched.
    expect(tomlAfterInstall).toContain(foreignTrustSection.trim());
    // Ours is written at index 1 (foreign kept index 0).
    expect(tomlAfterInstall).toContain(`[hooks.state."${hooksJsonPathStr}:pre_tool_use:1:0"]`);

    await uninstallHooks();

    const tomlAfterUninstall = fs.readFileSync(
      path.join(tmpBase, '.codex', 'config.toml'),
      'utf-8',
    );
    // Foreign trust entry still survives.
    expect(tomlAfterUninstall).toContain(foreignTrustSection.trim());
    // Ours is gone.
    expect(tomlAfterUninstall).not.toContain(`pre_tool_use:1:0`);
    const hooksAfterUninstall = JSON.parse(fs.readFileSync(hooksJsonPathStr, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(hooksAfterUninstall.hooks.PreToolUse).toHaveLength(1); // only the foreign group
    expect(hooksAfterUninstall.hooks.PreToolUse[0].hooks[0].command).toBe('other-tool-hook');
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

  it('escapes backslashes in trust-state TOML keys and round-trips through uninstall', async () => {
    // Windows-style paths contain backslashes, which start escape sequences
    // in TOML basic strings. Backslash is a legal POSIX filename character,
    // so we can reproduce the shape on this machine without mocking path.
    const root = tmpBase;
    const winHome = path.join(root, 'win\\style');
    try {
      fs.mkdirSync(path.join(winHome, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(winHome, '.codex', 'config.toml'), 'model = "gpt-5.2-codex"\n');
      tmpBase = winHome; // os.homedir() mock now resolves here

      await installHooks();
      const tomlPath = path.join(winHome, '.codex', 'config.toml');
      const rawHooksJsonPath = path.join(winHome, '.codex', 'hooks.json');
      const escapedPrefix = rawHooksJsonPath.replace(/\\/g, '\\\\');
      const toml = fs.readFileSync(tomlPath, 'utf-8');
      expect(toml).toContain(`[hooks.state."${escapedPrefix}:pre_tool_use:0:0"]`);

      await uninstallHooks();
      const tomlAfter = fs.readFileSync(tomlPath, 'utf-8');
      expect(tomlAfter).not.toContain('[hooks.state."'); // strip matched what we wrote, exactly
      expect(tomlAfter).toContain('model = "gpt-5.2-codex"'); // foreign content untouched
    } finally {
      tmpBase = root;
    }
  });

  it('escapes double-quotes in trust-state TOML keys and round-trips through uninstall', async () => {
    // Double-quotes are escape sequences in TOML basic strings.
    // Double-quote is a legal POSIX filename character, so we can
    // reproduce the shape on this machine without mocking path.
    const root = tmpBase;
    const quoteHome = path.join(root, 'quo"te');
    try {
      fs.mkdirSync(path.join(quoteHome, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(quoteHome, '.codex', 'config.toml'), 'model = "gpt-5.2-codex"\n');
      tmpBase = quoteHome; // os.homedir() mock now resolves here

      await installHooks();
      const tomlPath = path.join(quoteHome, '.codex', 'config.toml');
      const rawHooksJsonPath = path.join(quoteHome, '.codex', 'hooks.json');
      const escapedPrefix = rawHooksJsonPath.replace(/"/g, '\\"');
      const toml = fs.readFileSync(tomlPath, 'utf-8');
      expect(toml).toContain(`[hooks.state."${escapedPrefix}:pre_tool_use:0:0"]`);
      expect(toml).not.toContain(`quo"te:`); // raw unescaped quote does not appear in the key

      await uninstallHooks();
      const tomlAfter = fs.readFileSync(tomlPath, 'utf-8');
      expect(tomlAfter).not.toContain('[hooks.state."'); // strip matched what we wrote, exactly
      expect(tomlAfter).toContain('model = "gpt-5.2-codex"'); // foreign content untouched
    } finally {
      tmpBase = root;
    }
  });

  it('rolls back hooks.json when the config.toml write fails (hooks.json existed before, foreign content)', async () => {
    const foreignHooks =
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              { matcher: '', hooks: [{ type: 'command', command: 'foreign-hook', timeout: 3 }] },
            ],
          },
        },
        null,
        2,
      ) + '\n';
    fs.writeFileSync(path.join(tmpBase, '.codex', 'hooks.json'), foreignHooks);
    // Block atomicWrite's tmp file for config.toml (no fs mocking needed).
    fs.mkdirSync(path.join(tmpBase, '.codex', 'config.toml.pixel-agents-tmp'));

    await expect(installHooks()).rejects.toThrow(/Codex trust update failed/);

    expect(fs.readFileSync(path.join(tmpBase, '.codex', 'hooks.json'), 'utf-8')).toBe(foreignHooks);
  });

  it('removes hooks.json when the config.toml write fails and hooks.json did not exist before', async () => {
    expect(fs.existsSync(path.join(tmpBase, '.codex', 'hooks.json'))).toBe(false);
    fs.mkdirSync(path.join(tmpBase, '.codex', 'config.toml.pixel-agents-tmp'));

    await expect(installHooks()).rejects.toThrow(/Codex trust update failed/);

    expect(fs.existsSync(path.join(tmpBase, '.codex', 'hooks.json'))).toBe(false);
  });

  it('rolls back hooks.json when the config.toml write fails during uninstall', async () => {
    await installHooks();
    const hooksBefore = fs.readFileSync(path.join(tmpBase, '.codex', 'hooks.json'), 'utf-8');
    fs.mkdirSync(path.join(tmpBase, '.codex', 'config.toml.pixel-agents-tmp'));

    await expect(uninstallHooks()).rejects.toThrow(/Codex trust cleanup failed/);

    expect(fs.readFileSync(path.join(tmpBase, '.codex', 'hooks.json'), 'utf-8')).toBe(hooksBefore);
  });

  it('rejects and leaves hooks.json untouched when it exists but is malformed JSON', async () => {
    const garbage = '{ this is not valid json';
    fs.writeFileSync(path.join(tmpBase, '.codex', 'hooks.json'), garbage);

    await expect(installHooks()).rejects.toThrow(/hooks\.json/);

    expect(fs.readFileSync(path.join(tmpBase, '.codex', 'hooks.json'), 'utf-8')).toBe(garbage);
  });
});
