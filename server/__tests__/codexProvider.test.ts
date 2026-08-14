import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { codexProvider } from '../src/providers/hook/codex/codex.js';

const fixtures = fs
  .readFileSync(path.join(__dirname, 'fixtures', 'codex-hook-events.jsonl'), 'utf-8')
  .split('\n')
  .filter((l) => l.trim() && !l.includes('_comment'))
  .map((l) => JSON.parse(l) as Record<string, unknown>);

function byEvent(name: string): Record<string, unknown> {
  const e = fixtures.find((f) => f.hook_event_name === name);
  if (!e) throw new Error(`no fixture for ${name}`);
  return e;
}

describe('codexProvider.normalizeHookEvent', () => {
  it('PreToolUse -> toolStart with tool name + input, toolId from tool_use_id', () => {
    const n = codexProvider.normalizeHookEvent(byEvent('PreToolUse'));
    expect(n?.event.kind).toBe('toolStart');
    expect(n?.event).toMatchObject({
      kind: 'toolStart',
      toolId: 'call_y4zBplOH96NyoNyr7gx4rFQf',
      toolName: 'Bash',
      input: { command: 'echo pixel-probe' },
    });
  });

  it('PreToolUse falls back to synthetic toolId when tool_use_id is missing', () => {
    const raw = byEvent('PreToolUse');
    const { tool_use_id: _drop, ...withoutId } = raw;
    const n = codexProvider.normalizeHookEvent(withoutId);
    expect(n?.event.kind).toBe('toolStart');
    if (n?.event.kind === 'toolStart') {
      expect(n.event.toolId.startsWith('hook-')).toBe(true);
    }
  });

  it('PostToolUse -> toolEnd(current)', () => {
    const n = codexProvider.normalizeHookEvent(byEvent('PostToolUse'));
    expect(n?.event).toEqual({ kind: 'toolEnd', toolId: 'current' });
  });

  it('Stop -> turnEnd', () => {
    expect(codexProvider.normalizeHookEvent(byEvent('Stop'))?.event.kind).toBe('turnEnd');
  });

  it('SessionStart -> sessionStart with cwd + transcriptPath', () => {
    const n = codexProvider.normalizeHookEvent(byEvent('SessionStart'));
    expect(n?.event.kind).toBe('sessionStart');
    expect(n?.event).toMatchObject({
      kind: 'sessionStart',
      source: 'startup',
      cwd: '/tmp/codex-probe',
      transcriptPath:
        '/Users/user/.codex/sessions/2026/07/01/rollout-2026-07-01T20-25-42-019f20dc-6405-7851-a8bd-91d02a565e50.jsonl',
    });
  });

  it('PermissionRequest -> permissionRequest (synthetic event; fixture has none — probe ran in bypass mode)', () => {
    const n = codexProvider.normalizeHookEvent({
      hook_event_name: 'PermissionRequest',
      session_id: 'x',
    });
    expect(n?.event).toEqual({ kind: 'permissionRequest' });
  });

  it('unknown events -> null', () => {
    expect(
      codexProvider.normalizeHookEvent({ hook_event_name: 'PreCompact', session_id: 'x' }),
    ).toBeNull();
  });

  it('UserPromptSubmit -> null (mirrors Claude provider, no normalized kind)', () => {
    expect(codexProvider.normalizeHookEvent(byEvent('UserPromptSubmit'))).toBeNull();
  });

  it('has no team extension and no subagent tools', () => {
    expect(codexProvider.team).toBeUndefined();
    expect(codexProvider.subagentToolNames.size).toBe(0);
  });

  it('reuses Claude tool taxonomy: readingTools and empty permissionExemptTools', () => {
    expect([...codexProvider.readingTools].sort()).toEqual(
      ['Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch'].sort(),
    );
    expect(codexProvider.permissionExemptTools.size).toBe(0);
  });

  it('formatToolStatus reuses Claude formatting', () => {
    expect(codexProvider.formatToolStatus('Bash', { command: 'echo pixel-probe' })).toBe(
      'Running: echo pixel-probe',
    );
  });
});
