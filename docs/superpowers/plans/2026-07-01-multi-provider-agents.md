# Multi-Provider Pixel Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render externally started Codex CLI and hermes-agent sessions as office characters (render-only adoption; Claude unchanged).

**Architecture:** One `HookEventHandler` per registered `HookProvider`, routed by the providerId already in `/api/hooks/:providerId`. Codex = near-clone of the Claude provider (Codex speaks the Claude hooks schema) with a trust-hash-aware installer. Hermes = in-server poller over `~/.hermes/state.db` that synthesizes Claude-shaped hook envelopes into the same pipeline.

**Tech Stack:** TypeScript (ESM, NodeNext), Fastify, Vitest, `node:sqlite` (Node 22 stdlib — verified v22.23.1 on this machine), React webview.

**Spec:** `docs/superpowers/specs/2026-07-01-multi-provider-agents-design.md`

## Global Constraints

- No `enum` (erasableSyntaxOnly) — use `as const` objects; string-literal unions for discriminants.
- `import type` required for type-only imports (verbatimModuleSyntax).
- All relative imports carry explicit `.js` extensions even in `.ts` files.
- `noUnusedLocals` / `noUnusedParameters` are on.
- No inline magic numbers/strings — constants live in `server/src/constants.ts` (server), `core/src/constants.ts` (shared), `webview-ui/src/constants.ts` (webview), or a provider's own `constants.ts`.
- `core/src/messages.ts` is AUTO-GENERATED — edit `core/asyncapi.yaml` then run `npm run asyncapi:generate`. Never edit messages.ts by hand.
- Upstream policy: core dispatch + Codex provider must stay clean/self-contained (upstreamable). Hermes code is local-only — keep it isolated in `server/src/providers/hook/hermes/` + minimal wiring, like `claudeProcessScan.ts`.
- Existing Claude tests must stay green after every task: `cd server && npm test`.
- Commit after every task. Commit messages end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and the Claude-Session line used by prior commits on this branch.
- Full check before finishing a phase: `npm run build` (type-check → lint → esbuild → vite) from repo root.

## Verified environment facts (do not re-derive)

- Codex 0.142.4 installed; hook events: PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart, UserPromptSubmit, SubagentStart, SubagentStop, Stop. **No SessionEnd, no Notification, no PostToolUseFailure.**
- The pixel-agents hook script is ALREADY installed in `~/.codex/hooks.json` posting to `/api/hooks/claude` (6 events). Codex trust state lives in `~/.codex/config.toml` under `[hooks.state."<abs hooks.json path>:<snake_event>:<groupIdx>:<handlerIdx>"]` with `trusted_hash`.
- Trust hash algorithm (verified against all 6 live entries): `"sha256:" + hex(sha256(compactJson(sortKeysRecursively(identity))))` where identity = `{ event_name: <snake_label>, matcher?: <string>, hooks: [{ async: false, command: <raw command>, timeout: <sec, default 600, min 1>, type: "command" }] }`. For **Stop** and **UserPromptSubmit** the `matcher` key is OMITTED entirely; for the other events an empty-string matcher IS included as `"matcher":""`. `commandWindows`/`statusMessage` omitted when null.
- Real test vectors (command `node "/Users/dennistran/.pixel-agents/hooks/claude-hook.js"`, timeout 5):
  - `pre_tool_use`, matcher `""` → `sha256:c387de645b8f0cc87fd88c461a13d8109d94b29ea3b5101e4e4ff884f8dbfd48`
  - `stop`, matcher omitted → `sha256:2db559bb220b945bdc1ca53cf699654b3cd1acbeebac6795cf0db4828c21369c`
- Hermes `~/.hermes/state.db` (SQLite WAL): `messages.id` is AUTOINCREMENT (safe cursor: `WHERE id > ?`), timestamps are epoch **seconds** as REAL, `messages.timestamp` (NOT created_at), roles user/assistant/tool, `finish_reason='stop'` on completed assistant turns, `tool_calls` = JSON array `[{id, call_id, function: {name, arguments: <JSON-encoded string — double parse>}}]`, tool results = rows with `role='tool'`, `tool_call_id`, `tool_name`. `sessions`: `id` (short hex TEXT), `source` ('cli'|'webui'), `cwd` (nullable!), `started_at`, `ended_at` (NULL = live), `end_reason`. Open read-only; NEVER write (FTS triggers).
- `AgentState` already has `providerId?: string` and `hooksOnly?: boolean` (server/src/types.ts:38). Hooks-only agents use the empty-string `jsonlFile` convention (NOT optional fields) — process-scan/stale-check already skip `!agent.jsonlFile`.
- Webview `existingAgents` arrives via two orderings (standalone: layout first; VS Code: agents first) — new per-agent fields must flow through BOTH `addExistingAgent` and the `pendingAgents` buffer in `useExtensionMessages.ts`.

---

# Phase 1 — Core multi-provider dispatch

### Task 1: Route hook events per provider in AgentRuntime

**Files:**

- Modify: `server/src/agentRuntime.ts` (constructor ~56-105, handleHookEvent ~195-210, all `this.hookEventHandler` uses)
- Modify: `server/src/hookEventHandler.ts:429-447` (subagentToolNames fix)
- Modify: `server/src/cli.ts:117`
- Modify: `adapters/vscode/PixelAgentsViewProvider.ts:111`
- Test: `server/__tests__/multiProviderDispatch.test.ts` (new)

**Interfaces:**

- Consumes: `HookProvider` from `core/src/provider.ts`, existing `HookEventHandler` constructor.
- Produces: `new AgentRuntime(store, providers: HookProvider[])` — providers[0] is the **primary** (file-watching/transcript singletons bind to it); `runtime.getProviders(): HookProvider[]`; `runtime.getProvider(id: string): HookProvider | undefined`. Later tasks rely on these exact names.

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/multiProviderDispatch.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import { SessionRouter } from '../src/sessionRouter.js';
import type { HookProvider } from '../../core/src/provider.js';
import type { AgentState } from '../src/types.js';

/** Minimal AgentState for testing (copied from hookEventHandler.test.ts — keep the cast). */
function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: '',
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    ...overrides,
  } as AgentState;
}

function fakeProvider(id: string, overrides: Partial<HookProvider> = {}): HookProvider {
  return {
    kind: 'hook',
    id,
    displayName: id,
    protocolVersion: 1,
    usesTranscriptFile: false,
    normalizeHookEvent: (raw) => {
      if (typeof raw.session_id !== 'string') return null;
      if (raw.hook_event_name === 'Stop')
        return { sessionId: raw.session_id, event: { kind: 'turnEnd' } };
      if (raw.hook_event_name === 'PreToolUse')
        return {
          sessionId: raw.session_id,
          event: {
            kind: 'toolStart',
            toolId: `hook-test`,
            toolName: typeof raw.tool_name === 'string' ? raw.tool_name : '',
            input: {},
          },
        };
      return null;
    },
    installHooks: () => Promise.resolve(),
    uninstallHooks: () => Promise.resolve(),
    areHooksInstalled: () => Promise.resolve(false),
    formatToolStatus: (t) => t,
    permissionExemptTools: new Set<string>(),
    subagentToolNames: new Set<string>(),
    readingTools: new Set<string>(),
    ...overrides,
  };
}

describe('multi-provider dispatch', () => {
  let store: AgentStateStore;
  let messages: Array<Record<string, unknown>>;

  beforeEach(() => {
    store = new AgentStateStore();
    messages = [];
    store.on('broadcast', (msg) => messages.push(msg));
  });

  it('routes events to the handler matching providerId', () => {
    const runtime = new AgentRuntime(store, [fakeProvider('alpha'), fakeProvider('beta')]);
    store.set(1, createTestAgent({ id: 1 }));
    store.set(2, createTestAgent({ id: 2 }));
    runtime.registerAgent('sess-a', 1);
    runtime.registerAgent('sess-b', 2);

    runtime.handleHookEvent('alpha', { hook_event_name: 'Stop', session_id: 'sess-a' });
    // agentStatus waiting for agent 1 only
    const statuses = messages.filter((m) => m.type === 'agentStatus');
    expect(statuses.some((m) => m.id === 1)).toBe(true);
    expect(statuses.some((m) => m.id === 2)).toBe(false);
  });

  it('drops events for unregistered provider ids', () => {
    const runtime = new AgentRuntime(store, [fakeProvider('alpha')]);
    store.set(1, createTestAgent({ id: 1 }));
    runtime.registerAgent('sess-a', 1);

    runtime.handleHookEvent('nope', { hook_event_name: 'Stop', session_id: 'sess-a' });
    expect(messages.filter((m) => m.type === 'agentStatus')).toHaveLength(0);
  });

  it('getProvider/getProviders expose the registry', () => {
    const alpha = fakeProvider('alpha');
    const runtime = new AgentRuntime(store, [alpha, fakeProvider('beta')]);
    expect(runtime.getProviders()).toHaveLength(2);
    expect(runtime.getProvider('alpha')).toBe(alpha);
    expect(runtime.getProvider('nope')).toBeUndefined();
  });

  it('subagent-tool suppression uses provider.subagentToolNames, not literals', () => {
    // Provider where 'Task' is NOT a subagent tool -> agentToolStart must broadcast.
    const provider = fakeProvider('gamma');
    const handler = new HookEventHandler(
      store,
      new Map(),
      new Map(),
      provider,
      new SessionRouter(),
    );
    store.set(3, createTestAgent({ id: 3 }));
    handler.registerAgent('sess-c', 3);
    handler.handleEvent('gamma', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-c',
      tool_name: 'Task',
    });
    expect(messages.some((m) => m.type === 'agentToolStart' && m.id === 3)).toBe(true);
  });

  it('suppresses agentToolStart for tools in provider.subagentToolNames', () => {
    const provider = fakeProvider('delta', { subagentToolNames: new Set(['Task']) });
    const handler = new HookEventHandler(
      store,
      new Map(),
      new Map(),
      provider,
      new SessionRouter(),
    );
    store.set(4, createTestAgent({ id: 4 }));
    handler.registerAgent('sess-d', 4);
    handler.handleEvent('delta', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-d',
      tool_name: 'Task',
    });
    expect(messages.some((m) => m.type === 'agentToolStart' && m.id === 4)).toBe(false);
    // active status still broadcast
    expect(
      messages.some((m) => m.type === 'agentStatus' && m.id === 4 && m.status === 'active'),
    ).toBe(true);
  });
});
```

Note: if `AgentRuntime`'s constructor has side effects that break under vitest (module-level setters are fine — they're plain assignments), check the failure message before changing the test.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run __tests__/multiProviderDispatch.test.ts`
Expected: FAIL — `AgentRuntime` constructor rejects an array (type error at build; at runtime `providers.team`/`provider.id` undefined) and the last test fails because the `'Task'`/`'Agent'` literals suppress the broadcast.

- [ ] **Step 3: Convert AgentRuntime to a provider registry**

In `server/src/agentRuntime.ts`, replace the constructor and single-handler field:

```ts
  // Dependencies
  readonly dismissalTracker = new DismissalTracker();
  private readonly hookEventHandlers = new Map<string, HookEventHandler>();
  private readonly providers: HookProvider[];
  private lifecycleCallbacks: RuntimeLifecycleCallbacks = {};

  constructor(
    private readonly store: AgentStateStore,
    providers: HookProvider[],
  ) {
    this.providers = providers;
    // The primary provider (index 0) owns the file-watching/transcript-parsing
    // singletons — those modules are single-provider by design (Claude today).
    const primary = providers[0];
    setDismissalTracker(this.dismissalTracker);
    setHookProvider(primary);
    setFileWatcherHookProvider(primary);
    if (primary.team) {
      setTeamProvider(primary.team);
    }
    setAgentRemovalCallback((id) => this.removeAgent(id));
    setTeammateRemovalCallback((id) => this.removeTeammate(id, 'team-config'));

    for (const provider of providers) {
      this.hookEventHandlers.set(
        provider.id,
        new HookEventHandler(
          store,
          this.waitingTimers,
          this.permissionTimers,
          provider,
          new SessionRouter(),
          this.watchAllSessions,
        ),
      );
    }
```

Add the registry accessors near `handleHookEvent`:

```ts
  /** All registered providers (index 0 = primary). */
  getProviders(): HookProvider[] {
    return this.providers;
  }

  /** Look up a registered provider by id. */
  getProvider(id: string): HookProvider | undefined {
    return this.providers.find((p) => p.id === id);
  }

  /** Route an incoming hook event to the handler for its provider. */
  handleHookEvent(providerId: string, event: Record<string, unknown>): void {
    const handler = this.hookEventHandlers.get(providerId);
    if (!handler) {
      if (debug) console.log(`[Pixel Agents] Dropping event for unknown provider "${providerId}"`);
      return;
    }
    handler.handleEvent(providerId, event as HookEvent);
  }
```

(`debug` — reuse the module's existing debug flag if present; otherwise add `const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';` at module top, matching hookEventHandler.ts.)

Then update EVERY remaining `this.hookEventHandler` reference (grep `this.hookEventHandler\b` in the file):

- `registerAgent(sessionId, agentId)` / `unregisterAgent(sessionId)` → loop `for (const h of this.hookEventHandlers.values()) h.registerAgent(...)`. Cross-registering a session in every router is safe: each router only buffers events that arrived at its own handler, so flushes stay provider-correct.
- Any lifecycle-callback registration (e.g. `setLifecycleCallbacks(...)`) → apply to all handlers in the same loop style.
- `import type { HookProvider }` stays; add `import type { HookEvent }` if not already imported.

- [ ] **Step 4: Fix the Task/Agent hardcode**

In `server/src/hookEventHandler.ts` (~line 452 in `handlePreToolUse`), replace:

```ts
    if (toolName !== 'Task' && toolName !== 'Agent') {
```

with:

```ts
    if (!this.provider.subagentToolNames.has(toolName)) {
```

Keep the existing comment above it (it explains the _why_; the set-based check is the _how_).

- [ ] **Step 5: Update both construction sites**

`server/src/cli.ts:117`:

```ts
const runtime = new AgentRuntime(store, [claudeProvider]);
```

`adapters/vscode/PixelAgentsViewProvider.ts:111`:

```ts
this.runtime = new AgentRuntime(this.store, [claudeProvider]);
```

- [ ] **Step 6: Run tests**

Run: `cd server && npx vitest run __tests__/multiProviderDispatch.test.ts && npm test`
Expected: new file PASS; full suite PASS (existing hookEventHandler tests construct `HookEventHandler` directly — unaffected).

- [ ] **Step 7: Type-check + commit**

```bash
npm run build
git add -A server/src adapters/vscode server/__tests__
git commit -m "feat(server): multi-provider hook dispatch — one handler per registered provider"
```

---

### Task 2: Provider identity on the wire and in persistence

**Files:**

- Modify: `core/asyncapi.yaml` (AgentCreated, ProviderCapabilities, ExistingAgents) then `npm run asyncapi:generate`
- Modify: `core/src/schemas.ts:6-22` (PersistedAgent), `server/src/types.ts:65-83` (PersistedAgent)
- Modify: `server/src/agentStateStore.ts` (persist/restore), `server/src/httpServer.ts:214-225` (onAgentAdded)
- Modify: `server/src/fileWatcher.ts:800+` (`adoptExternalSessionFromHook` — providerId param)
- Modify: `server/src/hookEventHandler.ts` + `server/src/agentRuntime.ts` (plumb `this.provider.id` into adoption)
- Modify: `server/src/clientMessageHandler.ts` (per-provider capabilities, drop `claudeProvider` import, `existingAgents` providers map)
- Test: `server/__tests__/multiProviderDispatch.test.ts` (extend)

**Interfaces:**

- Consumes: `runtime.getProviders()` / `runtime.getProvider(id)` from Task 1.
- Produces (wire): `AgentCreated.provider?: string`; `ProviderCapabilities.providerId: string`; `ExistingAgents.providers?: Record<string, string>` (agentId → providerId). `PersistedAgent.provider?: string`. Task 3 (webview) consumes these exact field names.

- [ ] **Step 1: asyncapi.yaml + regenerate**

In `core/asyncapi.yaml`, mirror the adjacent property style exactly:

- `AgentCreated` properties: add `provider: { type: string }` (optional — absent means `'claude'` for back-compat with older servers).
- `ProviderCapabilities`: add `providerId: { type: string }` and add it to `required`.
- `ExistingAgents` properties: add `providers` shaped exactly like the existing `folderNames` map (`type: object` with string `additionalProperties`).

Run: `npm run asyncapi:generate && npm run asyncapi:validate`
Expected: `core/src/messages.ts` regenerates with the three new fields; validate passes.

- [ ] **Step 2: PersistedAgent + persist/restore**

Add `provider?: string;` to BOTH `PersistedAgent` interfaces (`core/src/schemas.ts` after `folderName`, `server/src/types.ts` after `folderName` — they are duplicated on purpose; keep them in sync).

In `server/src/agentStateStore.ts` `persist()` add to the pushed literal:

```ts
        provider: agent.providerId,
```

Find the restore path (grep `loadPersistedAgents(` callers — the standalone restore in cli.ts/agentRuntime and the vscode adapter's `restoreAgents`). Where each `PersistedAgent` becomes an `AgentState`, add:

```ts
      providerId: p.provider,
```

- [ ] **Step 3: Stamp providerId at adoption**

`server/src/fileWatcher.ts` — `adoptExternalSessionFromHook`: add a `providerId: string` parameter directly after `cwd`. In BOTH branches (transcript-backed and cwd-only/hooks-only), set `providerId` on the created `AgentState` literal. Grep the three call sites in `agentRuntime.ts` (~113, ~305, ~400):

- The two called from hook-driven lifecycle callbacks: the callback chain starts in `HookEventHandler` — extend the relevant `SessionLifecycleCallbacks` member(s) to pass `this.provider.id`, and thread it through `agentRuntime`'s callback into the `adoptExternalSessionFromHook` call.
- The process-scan site (~400, Claude-only by construction — `listLiveClaudeSessions`): pass `'claude'`.

- [ ] **Step 4: Broadcast provider on agentCreated + existingAgents**

`server/src/httpServer.ts` `onAgentAdded` literal — add:

```ts
        provider: agent.providerId,
```

Grep `'existingAgents'` in `server/src/` and `adapters/vscode/` — at each send site, alongside the existing `folderNames` map construction, add:

```ts
      providers: Object.fromEntries(
        [...agents].map(([id, a]) => [id, a.providerId ?? 'claude']),
      ),
```

(adapt the iteration shape to whatever the surrounding folderNames code uses — same loop, one more map).

- [ ] **Step 5: Generalize clientMessageHandler**

In `server/src/clientMessageHandler.ts`:

- Delete `import { claudeProvider } from './providers/index.js';`.
- `launchAgent` case: `const provider = runtime.getProvider('claude'); const projectDir = provider?.getSessionDirs?.(folderPath)?.[0];` (launch stays Claude-only in v1).
- `handleWebviewReady` step 1 becomes per-provider:

```ts
// 1. Provider capabilities (must arrive before any agent messages)
for (const provider of runtime?.getProviders() ?? []) {
  send({
    type: 'providerCapabilities',
    providerId: provider.id,
    readingTools: [...provider.readingTools],
    subagentToolNames: [...provider.subagentToolNames],
  });
}
```

(If `runtime` can be undefined here in embedded mode, the loop simply sends nothing — the webview's Claude-seeded defaults cover it.)

- [ ] **Step 6: Test persist round-trip + capabilities fan-out**

Extend `multiProviderDispatch.test.ts`:

```ts
it('persists and restores providerId', () => {
  const saved: unknown[] = [];
  store.setAdapter({
    saveAgents: (a: unknown[]) => saved.push(...a),
    loadAgents: () => [],
    getSetting: (_k: string, d: unknown) => d,
    setSetting: () => {},
    saveSeats: () => {},
    loadSeats: () => ({}),
  } as never);
  store.set(1, createTestAgent({ id: 1, providerId: 'codex' }));
  store.persist();
  expect((saved[0] as { provider?: string }).provider).toBe('codex');
});
```

(Match the real `StateAdapter` surface — check `core/src/adapter.ts` and stub every required member; the `as never` cast keeps the stub honest-ish without implementing unused methods.)

- [ ] **Step 7: Run, build, commit**

```bash
cd server && npm test && cd .. && npm run build
git add -A core server adapters
git commit -m "feat: provider identity on agentCreated/existingAgents/capabilities + persistence"
```

---

### Task 3: Webview — per-provider capabilities, Character.provider, badge

**Files:**

- Modify: `webview-ui/src/office/toolUtils.ts:105-135`
- Modify: `webview-ui/src/office/types.ts` (Character, ~line 200)
- Modify: `webview-ui/src/hooks/useExtensionMessages.ts` (providerCapabilities, agentCreated, existingAgents, pendingAgents buffer, addExistingAgent)
- Modify: `webview-ui/src/office/components/ToolOverlay.tsx` (badge + hasExtraLines)
- Modify: `webview-ui/src/constants.ts` (badge colors/labels)

**Interfaces:**

- Consumes: `msg.provider` (agentCreated), `msg.providers` (existingAgents), `msg.providerId` (providerCapabilities) from Task 2.
- Produces: `Character.provider?: string`; `setProviderCapabilities({providerId?, readingTools, subagentToolNames})` (back-compat: missing providerId = 'claude').

- [ ] **Step 1: Per-provider capabilities store (union for classification)**

Replace the singleton in `toolUtils.ts`:

```ts
// ── Provider capabilities (tool taxonomy for rendering decisions) ────────────
// Populated per provider by `providerCapabilities` messages after `webviewReady`.
// Classification uses the union across providers: tool-name collisions across
// providers are semantically compatible (a "read" tool reads), so a per-agent
// lookup isn't needed. Seeded with Claude defaults so classification works
// before — or entirely without — a message (e.g. older servers).
const providerCapsById = new Map<
  string,
  { readingTools: Set<string>; subagentToolNames: Set<string> }
>([
  [
    'claude',
    {
      readingTools: new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']),
      subagentToolNames: new Set(['Task', 'Agent']),
    },
  ],
]);

export function setProviderCapabilities(caps: {
  providerId?: string;
  readingTools: string[];
  subagentToolNames: string[];
}): void {
  providerCapsById.set(caps.providerId ?? 'claude', {
    readingTools: new Set(caps.readingTools),
    subagentToolNames: new Set(caps.subagentToolNames),
  });
}

export function isReadingToolName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false;
  for (const caps of providerCapsById.values()) if (caps.readingTools.has(name)) return true;
  return false;
}

export function isSubagentToolName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false;
  for (const caps of providerCapsById.values()) if (caps.subagentToolNames.has(name)) return true;
  return false;
}
```

- [ ] **Step 2: providerCapabilities handler passes providerId**

In `useExtensionMessages.ts`:

```ts
if (msg.type === 'providerCapabilities') {
  setProviderCapabilities({
    providerId: msg.providerId,
    readingTools: msg.readingTools,
    subagentToolNames: msg.subagentToolNames,
  });
  return;
}
```

- [ ] **Step 3: Character.provider + both agent-arrival paths**

`types.ts` Character (after `folderName?: string;`):

```ts
  /** Provider that owns this agent ('claude' | 'codex' | 'hermes'). Absent = claude. */
  provider?: string;
```

`useExtensionMessages.ts`:

- `pendingAgents` element type and `addExistingAgent` param: add `provider?: string` to both inline shapes.
- In `addExistingAgent`, after `os.addAgent(...)`:

```ts
if (p.provider) {
  const ch = os.characters.get(p.id);
  if (ch) ch.provider = p.provider;
}
```

- `agentCreated` handler: read `const provider = msg.provider as string | undefined;` and set post-hoc (same pattern as team fields) after the `os.addAgent(...)` calls:

```ts
if (provider) {
  const ch = os.characters.get(id);
  if (ch) ch.provider = provider;
}
```

- `existingAgents` handler: `const providers = (msg.providers || {}) as Record<number, string>;` and add `provider: providers[id],` to the `p` literal.

- [ ] **Step 4: Badge in ToolOverlay + constants**

`webview-ui/src/constants.ts`:

```ts
// ── Provider badges (ToolOverlay) ────────────────────────────
/** Short label per non-default provider shown under the activity text. */
export const PROVIDER_BADGE_LABELS: Record<string, string> = {
  codex: 'CODEX',
  hermes: 'HERMES',
};
export const PROVIDER_BADGE_COLORS: Record<string, string> = {
  codex: '#7dd3fc',
  hermes: '#fbbf24',
};
export const PROVIDER_BADGE_FALLBACK_COLOR = '#a1a1aa';
```

`ToolOverlay.tsx` — derive once next to `teamRoleLabel`:

```ts
// Claude is the default/majority — badge only non-default providers (restrained).
const providerBadge = ch.provider && ch.provider !== 'claude' ? ch.provider : null;
```

Include it in `hasExtraLines`:

```ts
const hasExtraLines = !!(ch.folderName || teamRoleLabel || titleMeta || providerBadge);
```

Render after the `ch.folderName` span (inside the same flex-col):

```tsx
{
  providerBadge && (
    <span
      className="text-2xs leading-none overflow-hidden text-ellipsis block"
      style={{
        color: PROVIDER_BADGE_COLORS[providerBadge] ?? PROVIDER_BADGE_FALLBACK_COLOR,
        fontWeight: 'bold',
      }}
    >
      {PROVIDER_BADGE_LABELS[providerBadge] ?? providerBadge.toUpperCase()}
    </span>
  );
}
```

Import the three constants from `../../constants.js`.

- [ ] **Step 5: Build + commit**

```bash
npm run build
git add -A webview-ui
git commit -m "feat(web): per-provider capabilities + provider badge on the agent overlay"
```

Phase 1 done — Claude behavior identical, plumbing ready.

---

# Phase 2 — Codex provider

### Task 4: Parameterize the hook script's provider route

**Files:**

- Modify: `server/src/providers/hook/claude/hooks/claude-hook.ts`
- Test: `server/__tests__/claude-hook.test.ts` (extend, follow its existing spawn pattern)

**Interfaces:**

- Produces: the installed script accepts an optional argv `providerId` — `node claude-hook.js codex` POSTs to `/api/hooks/codex`; no argv keeps `/claude` (existing Claude installs untouched, no re-install, no settings.json churn).

- [ ] **Step 1: Write the failing test**

In `server/__tests__/claude-hook.test.ts`, add two cases following the file's existing pattern (it spawns the built `dist/hooks/claude-hook.js` with a temp-HOME `server.json` pointing at a live test server — reuse its existing spawn/server helpers verbatim, only adding the extra argv). Shape, adapted to the file's actual helper names:

```ts
it('argv provider id routes to /api/hooks/<id>', async () => {
  const received: string[] = [];
  server.onHookEvent((providerId) => received.push(providerId));
  // same spawn helper the existing tests use, plus one extra arg:
  await runHookScript(JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' }), ['codex']);
  expect(received).toEqual(['codex']);
});

it('invalid argv provider id exits silently with no event', async () => {
  const received: string[] = [];
  server.onHookEvent((providerId) => received.push(providerId));
  await runHookScript(JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' }), [
    'NOT_VALID!',
  ]);
  expect(received).toEqual([]);
});
```

If the existing spawn helper doesn't take extra args, extend it with an optional `args: string[] = []` parameter appended to the child-process argv.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run __tests__/claude-hook.test.ts`
Expected: FAIL — providerId received is `'claude'` (argv ignored today).

- [ ] **Step 3: Implement**

In `claude-hook.ts`, before building the request path:

```ts
// Provider route segment. The same script serves any hook-compatible CLI:
// installers pass the provider id as argv[2]; absent means 'claude' so
// existing installs keep working without re-trust/re-install.
const PROVIDER_ID_PATTERN = /^[a-z0-9-]+$/;
const providerId = process.argv[2] ?? 'claude';
if (!PROVIDER_ID_PATTERN.test(providerId)) process.exit(0);
```

and change the request path to:

```ts
        path: `${HOOK_API_PREFIX}/${providerId}`,
```

(Place the argv parsing at module top-level before `main()`; keep the never-fail-loudly contract.)

- [ ] **Step 4: Rebuild the bundled script + run tests**

Run: `npm run build && cd server && npx vitest run __tests__/claude-hook.test.ts && npm test`
(The test spawns `dist/hooks/claude-hook.js`, so the esbuild step must run first.)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/providers/hook/claude/hooks/claude-hook.ts server/__tests__/claude-hook.test.ts
git commit -m "feat(hooks): hook script takes provider route as argv (default claude)"
```

---

### Task 5: Capture real Codex hook payloads (probe — no production code)

**Files:**

- Create: `server/__tests__/fixtures/codex-hook-events.jsonl` (captured, redacted)

This task pins the ONE unverified assumption: the exact JSON shape Codex sends to hooks (field names, and whether SessionStart carries `transcript_path`).

- [ ] **Step 1: Back up Codex config**

```bash
cp ~/.codex/hooks.json ~/.codex/hooks.json.bak
```

- [ ] **Step 2: Add a capture hook**

Write `/tmp/codex-capture.sh` (any temp path):

```sh
#!/bin/sh
cat >> /tmp/codex-hook-capture.jsonl
echo >> /tmp/codex-hook-capture.jsonl
```

`chmod +x` it. Edit `~/.codex/hooks.json`: for each of `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`, append a second matcher-group `{ "matcher": "", "hooks": [{ "type": "command", "command": "/tmp/codex-capture.sh", "timeout": 5 }] }` (for Stop/UserPromptSubmit omit `matcher` to mirror the existing entries). Don't touch the existing pixel-agents entries.

- [ ] **Step 3: Run a short Codex session with trust bypassed**

```bash
cd /tmp && codex --dangerously-bypass-hook-trust exec "run the shell command: echo pixel-probe"
```

(`--dangerously-bypass-hook-trust` runs the untrusted capture hook without re-trusting in the TUI; it's scoped to this one invocation.)

- [ ] **Step 4: Inspect and record**

```bash
cat /tmp/codex-hook-capture.jsonl
```

Answer and note in the fixture file header (as `//`-free JSONL comments are impossible — use a `_comment` first line):

1. Does `SessionStart` include `transcript_path` (rollout file) and `cwd`?
2. What are `tool_name` values (`shell`? `exec_command`? `apply_patch`?) and the `tool_input` shape?
3. Does `Stop` fire at turn end?

Copy representative lines (one per event type, secrets/paths sanitized only if needed) into `server/__tests__/fixtures/codex-hook-events.jsonl`.

**Decision gate for Task 6:** if `transcript_path` is present → `usesTranscriptFile: true` (mtime staleness works). If absent → `usesTranscriptFile: false` and note that Codex agents rely on X-close/`sessionEnd`-less stale handling (document in the provider's constants.ts header).

- [ ] **Step 5: Restore config**

```bash
mv ~/.codex/hooks.json.bak ~/.codex/hooks.json
rm -f /tmp/codex-capture.sh /tmp/codex-hook-capture.jsonl
git add server/__tests__/fixtures/codex-hook-events.jsonl
git commit -m "test(codex): captured real Codex hook payload fixtures"
```

---

### Task 6: Codex provider module

**Files:**

- Create: `server/src/providers/hook/codex/constants.ts`
- Create: `server/src/providers/hook/codex/codex.ts`
- Test: `server/__tests__/codexProvider.test.ts` (new)

**Interfaces:**

- Consumes: fixture payloads from Task 5; `AgentEvent`/`HookProvider` from core.
- Produces: `export const codexProvider: HookProvider` with `id: 'codex'`. Task 7's installer imports `CODEX_HOOK_EVENTS` and `CODEX_SNAKE_LABELS` from its constants.ts.

- [ ] **Step 1: constants.ts**

```ts
/**
 * Codex-specific constants. Codex (0.142+) speaks the Claude Code hooks JSON
 * shape but supports a different event set: no SessionEnd, no Notification,
 * no PostToolUseFailure. Session lifecycle end is handled by transcript-mtime
 * staleness instead (see spec 2026-07-01-multi-provider-agents-design.md).
 */

/** Events we install in ~/.codex/hooks.json (the Claude-compatible subset). */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
] as const;

/** Codex's snake_case labels used in config.toml [hooks.state] trust keys. */
export const CODEX_SNAKE_LABELS: Record<(typeof CODEX_HOOK_EVENTS)[number], string> = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  PermissionRequest: 'permission_request',
  Stop: 'stop',
};

/** Events whose matcher is forced to None by Codex before trust-hashing —
 *  the `matcher` key must be OMITTED from both hooks.json and the hash preimage. */
export const CODEX_MATCHERLESS_EVENTS = new Set(['Stop', 'UserPromptSubmit']);

export const CODEX_TERMINAL_NAME_PREFIX = 'Codex';
export const CODEX_HOOK_TIMEOUT_SEC = 5;
```

- [ ] **Step 2: Failing tests from fixtures**

`server/__tests__/codexProvider.test.ts`:

```ts
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
  it('PreToolUse -> toolStart with tool name + input', () => {
    const n = codexProvider.normalizeHookEvent(byEvent('PreToolUse'));
    expect(n?.event.kind).toBe('toolStart');
  });
  it('PostToolUse -> toolEnd(current)', () => {
    const n = codexProvider.normalizeHookEvent(byEvent('PostToolUse'));
    expect(n?.event).toEqual({ kind: 'toolEnd', toolId: 'current' });
  });
  it('Stop -> turnEnd', () => {
    expect(codexProvider.normalizeHookEvent(byEvent('Stop'))?.event.kind).toBe('turnEnd');
  });
  it('SessionStart -> sessionStart with cwd', () => {
    const n = codexProvider.normalizeHookEvent(byEvent('SessionStart'));
    expect(n?.event.kind).toBe('sessionStart');
  });
  it('unknown events -> null', () => {
    expect(
      codexProvider.normalizeHookEvent({ hook_event_name: 'PreCompact', session_id: 'x' }),
    ).toBeNull();
  });
  it('has no team extension and no subagent tools', () => {
    expect(codexProvider.team).toBeUndefined();
    expect(codexProvider.subagentToolNames.size).toBe(0);
  });
});
```

Add a `sessionStart` assertion for `transcriptPath` if the Task 5 probe confirmed it.

Run: `cd server && npx vitest run __tests__/codexProvider.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: codex.ts**

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { BASH_COMMAND_DISPLAY_MAX_LENGTH } from '../../../constants.js';
import { CODEX_TERMINAL_NAME_PREFIX } from './constants.js';

// NOTE: installer wired in Task 7 — this task uses inline no-ops so the module
// compiles and the normalize/format tests run before the installer exists.

// ── formatToolStatus: Codex tool taxonomy ──
// Adjust the case labels to the tool names captured in
// __tests__/fixtures/codex-hook-events.jsonl (probe Task 5).
export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case 'shell':
    case 'exec_command': {
      const cmd = typeof inp.command === 'string' ? inp.command : '';
      return `Running ${cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH)}`;
    }
    case 'apply_patch':
      return 'Editing files';
    case 'read_file':
      return `Reading ${typeof inp.path === 'string' ? path.basename(inp.path) : ''}`;
    case 'web_search':
      return `Searching web ${typeof inp.query === 'string' ? inp.query : ''}`;
    default:
      return toolName;
  }
}

// ── normalizeHookEvent: Codex sends Claude-shaped hook payloads ──
function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string') return null;

  switch (eventName) {
    case 'PreToolUse': {
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : '';
      const toolInput =
        typeof raw.tool_input === 'object' && raw.tool_input !== null
          ? (raw.tool_input as Record<string, unknown>)
          : {};
      return {
        sessionId,
        event: { kind: 'toolStart', toolId: `hook-${Date.now()}`, toolName, input: toolInput },
      };
    }
    case 'PostToolUse':
      return { sessionId, event: { kind: 'toolEnd', toolId: 'current' } };
    case 'Stop':
      return { sessionId, event: { kind: 'turnEnd' } };
    case 'PermissionRequest':
      return { sessionId, event: { kind: 'permissionRequest' } };
    case 'SessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.source === 'string' ? raw.source : undefined,
          transcriptPath: typeof raw.transcript_path === 'string' ? raw.transcript_path : undefined,
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        },
      };
    // UserPromptSubmit: no normalized kind (mirrors Claude provider). PreCompact/
    // PostCompact/SubagentStart/SubagentStop: not installed; drop defensively.
    default:
      return null;
  }
}

export const codexProvider: HookProvider = {
  kind: 'hook',
  id: 'codex',
  displayName: 'Codex',
  protocolVersion: 1,
  usesTranscriptFile: true, // per Task 5 decision gate — flip to false if probe showed no transcript_path

  normalizeHookEvent,

  // Replaced with the real installer in Task 7.
  installHooks: () => Promise.resolve(),
  uninstallHooks: () => Promise.resolve(),
  areHooksInstalled: () => Promise.resolve(false),

  formatToolStatus,
  permissionExemptTools: new Set(['update_plan']),
  subagentToolNames: new Set(),
  readingTools: new Set(['read_file', 'web_search', 'view_image', 'list_dir']),
  terminalNamePrefix: CODEX_TERMINAL_NAME_PREFIX,
};
```

Adjust tool-name sets/labels to the probe's actual names.

- [ ] **Step 4: Run tests, commit**

```bash
cd server && npx vitest run __tests__/codexProvider.test.ts
git add server/src/providers/hook/codex server/__tests__/codexProvider.test.ts
git commit -m "feat(codex): Codex hook provider — normalize, tool taxonomy, status format"
```

---

### Task 7: Codex hook installer with trust-hash maintenance

**Files:**

- Create: `server/src/providers/hook/codex/codexHookInstaller.ts`
- Test: `server/__tests__/codexHookInstaller.test.ts` (new)

**Interfaces:**

- Consumes: `CODEX_HOOK_EVENTS`, `CODEX_SNAKE_LABELS`, `CODEX_MATCHERLESS_EVENTS`, `CODEX_HOOK_TIMEOUT_SEC` from Task 6's constants; `HOOK_SCRIPTS_DIR` + the shared hook script name `'claude-hook.js'` (import `CLAUDE_HOOK_SCRIPT_NAME` from the claude provider's constants — one physical script, per-provider argv).
- Produces: `installHooks(): Promise<void>`, `uninstallHooks(): Promise<void>`, `areHooksInstalled(): Promise<boolean>`, and (exported for tests) `trustHash(event, matcher, command, timeoutSec): string`.

- [ ] **Step 1: Failing test — the verified hash vectors**

`server/__tests__/codexHookInstaller.test.ts` (temp-HOME pattern copied from claudeHookInstaller.test.ts — `vi.mock('os')` BEFORE dynamic import):

```ts
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
```

Run: `cd server && npx vitest run __tests__/codexHookInstaller.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 2: Implement**

`server/src/providers/hook/codex/codexHookInstaller.ts`:

```ts
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
```

Caveat baked into `stripOurTrustEntries`: a `[hooks.state."…"]` header always terminates the previous section, and appending absolute table headers at EOF is valid TOML — no TOML parser needed.

- [ ] **Step 3: Run tests**

Run: `cd server && npx vitest run __tests__/codexHookInstaller.test.ts && npx vitest run __tests__/codexProvider.test.ts`
Expected: PASS, including both real hash vectors. If a hash vector fails, do NOT adjust the vector — the preimage construction is wrong; re-read the "Verified environment facts" section.

- [ ] **Step 4: Commit**

```bash
git add server/src/providers/hook/codex server/__tests__/codexHookInstaller.test.ts
git commit -m "feat(codex): hooks.json installer with config.toml trust-hash maintenance"
```

---

### Task 8: Register Codex, gate transcript parsing, verify end-to-end

**Files:**

- Modify: `server/src/providers/index.ts`
- Modify: `server/src/cli.ts` (providers array + onSetHooksEnabled loop)
- Modify: `adapters/vscode/PixelAgentsViewProvider.ts` (providers array)
- Modify: `server/src/fileWatcher.ts` (`adoptExternalSessionFromHook` — skip transcript watching for non-primary providers)
- Test: `server/__tests__/multiProviderDispatch.test.ts` (extend)

**Interfaces:**

- Consumes: `codexProvider` (Task 6), argv-parameterized hook script (Task 4), providerId param on adoption (Task 2).

- [ ] **Step 1: Registry + wiring**

`server/src/providers/index.ts` — add:

```ts
export { codexProvider } from './hook/codex/codex.js';
```

`server/src/cli.ts`:

```ts
import { claudeProvider, codexProvider, copyHookScript } from './providers/index.js';
...
    const runtime = new AgentRuntime(store, [claudeProvider, codexProvider]);
```

and generalize `onSetHooksEnabled`:

```ts
const onSetHooksEnabled = async (enabled: boolean): Promise<void> => {
  if (!currentConfig) return;
  for (const provider of runtime.getProviders()) {
    if (enabled) {
      await provider.installHooks(`http://127.0.0.1:${currentConfig.port}`, currentConfig.token);
    } else {
      await provider.uninstallHooks();
    }
  }
  if (enabled) copyHookScript(hookScriptRoot);
  console.log(`[Pixel Agents] Hooks ${enabled ? 'installed' : 'uninstalled'} (user toggle)`);
};
```

(The codex installer no-ops when `~/.codex` is absent, so this is safe on machines without Codex.)

Mirror the providers array in `adapters/vscode/PixelAgentsViewProvider.ts` (`[claudeProvider, codexProvider]`) and update its hook-install call sites the same way if it has any (grep `installHooks` in adapters/).

Also grep `server/src/cli.ts` and `server/src/httpServer.ts` for any other direct `claudeProvider.` method calls (e.g. startup hook install) and convert to the same `runtime.getProviders()` loop.

- [ ] **Step 2: Gate transcript watching to the primary provider**

In `server/src/fileWatcher.ts` `adoptExternalSessionFromHook` (transcript-backed branch): the branch currently starts JSONL watching/polling for the new agent. Codex rollout files are NOT Claude-transcript-shaped — parsing them would emit garbage. Immediately before the watcher/poll start calls, add:

```ts
// Only the primary (file-watching) provider's transcripts are parseable by
// transcriptParser. Other providers' agents keep jsonlFile for mtime-based
// staleness but are driven purely by hook events.
const parseable = providerId === getFileWatcherHookProvider().id;
```

and wrap the watch/poll start calls in `if (parseable) { ... }`. If no `getFileWatcherHookProvider()` accessor exists, add one next to `setFileWatcherHookProvider` in the same module (returns the module-level provider). The agent is still created with `jsonlFile = transcriptPath` in both cases — the stale-check (`EXTERNAL_ACTIVE_THRESHOLD_MS` mtime) and process-scan `jsonlFile` guards then work unchanged.

- [ ] **Step 3: Dispatch test with the real codex provider**

Extend `multiProviderDispatch.test.ts`:

```ts
import { codexProvider } from '../src/providers/hook/codex/codex.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';

it('claude + codex providers coexist without cross-talk', () => {
  const runtime = new AgentRuntime(store, [claudeProvider, codexProvider]);
  store.set(1, createTestAgent({ id: 1, providerId: 'claude' }));
  store.set(2, createTestAgent({ id: 2, providerId: 'codex' }));
  runtime.registerAgent('claude-sess', 1);
  runtime.registerAgent('codex-sess', 2);

  runtime.handleHookEvent('codex', { hook_event_name: 'Stop', session_id: 'codex-sess' });
  const statuses = messages.filter((m) => m.type === 'agentStatus');
  expect(statuses.every((m) => m.id === 2)).toBe(true);
});
```

Run: `cd server && npm test` — Expected: all PASS.

- [ ] **Step 4: Manual end-to-end verification**

```bash
npm run build
npm run web   # or however the standalone server is started per README/docs
```

1. Toggle hooks off/on in Settings (or restart) → confirm `~/.codex/hooks.json` now posts with the `codex` argv and `config.toml` gained the new trust hashes (`grep 'claude-hook.js" codex' ~/.codex/hooks.json`).
2. In a terminal: `cd ~/projects/personal/dex-screener && codex`, ask it to run a command.
3. In the web UI: a character appears with the CODEX badge, animates on tool use, shows the waiting bubble on Stop. **The character is NOT duplicated as a Claude agent** (dispatch fix).
4. Quit Codex → character reaped by the stale check after the mtime threshold (or X-close works).

Record any payload-shape surprises back into the fixtures + provider.

- [ ] **Step 5: Commit**

```bash
git add -A server adapters
git commit -m "feat(codex): register provider — codex sessions render as office characters"
```

Phase 2 done.

---

# Phase 3 — Hermes provider (local-only)

### Task 9: Hermes provider + state.db poller

**Files:**

- Create: `server/src/providers/hook/hermes/constants.ts`
- Create: `server/src/providers/hook/hermes/hermes.ts`
- Create: `server/src/providers/hook/hermes/hermesPoller.ts`
- Test: `server/__tests__/hermesPoller.test.ts` (new)

**Interfaces:**

- Consumes: `runtime.handleHookEvent(providerId, envelope)` — the poller synthesizes Claude-shaped envelopes (`{hook_event_name, session_id, ...}`) so buffering/normalization/dispatch are reused untouched.
- Produces: `hermesProvider: HookProvider` (`id: 'hermes'`, `usesTranscriptFile: false`); `class HermesPoller { constructor(opts); start(); stop(); tick(); }` — `tick()` public for tests. Task 10 adds persona continuity inside the poller.

- [ ] **Step 1: constants.ts**

```ts
/**
 * Hermes-agent provider (LOCAL-ONLY — not for upstream PRs; see
 * docs/superpowers/specs/2026-07-01-multi-provider-agents-design.md).
 * Hermes has no transcript files and no hooks API. A read-only poller over
 * ~/.hermes/state.db (SQLite WAL) synthesizes Claude-shaped hook envelopes.
 * NEVER open the DB writable: FTS triggers + app-maintained counters.
 */
export const HERMES_DB_RELATIVE_PATH = '.hermes/state.db';
export const HERMES_POLL_INTERVAL_MS = 1000;
/** At startup, only adopt live sessions with a message newer than this. */
export const HERMES_ACTIVE_THRESHOLD_MS = 600_000; // 10 minutes
/** Sessions with no new rows for this long get a synthesized SessionEnd. */
export const HERMES_INACTIVITY_TIMEOUT_MS = 1_800_000; // 30 minutes
/** Max message rows consumed per tick (backpressure). */
export const HERMES_MAX_ROWS_PER_TICK = 500;
```

- [ ] **Step 2: hermes.ts (provider)**

```ts
import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { BASH_COMMAND_DISPLAY_MAX_LENGTH } from '../../../constants.js';

// The poller synthesizes Claude-shaped envelopes, so normalization mirrors the
// Claude provider for the five envelope kinds the poller emits.
function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string') return null;

  switch (eventName) {
    case 'PreToolUse': {
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : '';
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: typeof raw.tool_call_id === 'string' ? raw.tool_call_id : `hook-${Date.now()}`,
          toolName,
          input: raw.tool_input,
        },
      };
    }
    case 'PostToolUse':
      return { sessionId, event: { kind: 'toolEnd', toolId: 'current' } };
    case 'Stop':
      return { sessionId, event: { kind: 'turnEnd' } };
    case 'SessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.source === 'string' ? raw.source : undefined,
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        },
      };
    case 'SessionEnd':
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason: typeof raw.reason === 'string' ? raw.reason : undefined,
        },
      };
    default:
      return null;
  }
}

function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  if (typeof inp.command === 'string')
    return `Running ${inp.command.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH)}`;
  return toolName;
}

export const hermesProvider: HookProvider = {
  kind: 'hook',
  id: 'hermes',
  displayName: 'Hermes',
  protocolVersion: 1,
  usesTranscriptFile: false, // hooks(poller)-only; cwd-only adoption path

  normalizeHookEvent,

  // Poller-based: nothing to install.
  installHooks: () => Promise.resolve(),
  uninstallHooks: () => Promise.resolve(),
  areHooksInstalled: () => Promise.resolve(true),

  formatToolStatus,
  permissionExemptTools: new Set(),
  subagentToolNames: new Set(),
  readingTools: new Set(['web_search', 'read_file', 'memory']),
};
```

- [ ] **Step 3: Failing poller tests with a fixture DB**

`server/__tests__/hermesPoller.test.ts` — build a real temp SQLite DB with `node:sqlite` (only the columns the poller reads):

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
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

const NOW_S = 1_782_934_000; // epoch seconds, matches Hermes REAL format

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
```

Run: `cd server && npx vitest run __tests__/hermesPoller.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 4: hermesPoller.ts**

```ts
import { DatabaseSync } from 'node:sqlite';

import {
  HERMES_ACTIVE_THRESHOLD_MS,
  HERMES_INACTIVITY_TIMEOUT_MS,
  HERMES_MAX_ROWS_PER_TICK,
  HERMES_POLL_INTERVAL_MS,
} from './constants.js';

export interface HermesPollerOptions {
  dbPath: string;
  /** Feed a synthesized Claude-shaped envelope into runtime.handleHookEvent. */
  onEvent: (providerId: 'hermes', envelope: Record<string, unknown>) => void;
  /** Task 10: find an existing agent id for a persona key, or undefined. */
  resolvePersonaAgent: (personaKey: string) => number | undefined;
  /** Task 10: re-point an existing agent to a new session id. */
  reattachSession: (agentId: number, newSessionId: string) => void;
}

interface SessionRow {
  id: string;
  source: string;
  cwd: string | null;
  ended_at: number | null;
}
interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  finish_reason: string | null;
  timestamp: number;
}

export function personaKey(source: string, cwd: string | null): string {
  return `${source}:${cwd ?? ''}`;
}

export class HermesPoller {
  private db: DatabaseSync | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cursor = -1; // -1 = first tick pending
  /** Sessions we've announced, with last-activity for inactivity reaping. */
  private readonly known = new Map<string, { lastActivityMs: number }>();

  constructor(private readonly opts: HermesPollerOptions) {}

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), HERMES_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.db?.close();
    this.db = null;
  }

  private open(): DatabaseSync | null {
    if (this.db) return this.db;
    try {
      this.db = new DatabaseSync(this.opts.dbPath, { readOnly: true });
      return this.db;
    } catch {
      return null; // hermes not installed / db locked — retry next tick
    }
  }

  tick(): void {
    let db: DatabaseSync | null;
    try {
      db = this.open();
      if (!db) return;

      if (this.cursor === -1) {
        this.bootstrap(db);
        return;
      }

      const rows = db
        .prepare(
          `SELECT id, session_id, role, tool_calls, tool_call_id, tool_name, finish_reason, timestamp
           FROM messages WHERE id > ? ORDER BY id LIMIT ?`,
        )
        .all(this.cursor, HERMES_MAX_ROWS_PER_TICK) as unknown as MessageRow[];

      for (const row of rows) {
        this.cursor = row.id;
        this.ensureSession(db, row.session_id);
        this.emitForRow(row);
        const s = this.known.get(row.session_id);
        if (s) s.lastActivityMs = Date.now();
      }

      this.reapEnded(db);
    } catch {
      // Read failure (WAL checkpoint race, etc.) — drop the connection and retry.
      this.db?.close();
      this.db = null;
    }
  }

  /** First tick: cursor to MAX(id) (never replay history), adopt live+recent sessions. */
  private bootstrap(db: DatabaseSync): void {
    const max = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages').get() as
      | { m: number }
      | undefined;
    this.cursor = max?.m ?? 0;
    const live = db
      .prepare('SELECT id, source, cwd, ended_at FROM sessions WHERE ended_at IS NULL')
      .all() as unknown as SessionRow[];
    const cutoffS = (Date.now() - HERMES_ACTIVE_THRESHOLD_MS) / 1000;
    for (const s of live) {
      const recent = db
        .prepare('SELECT 1 AS x FROM messages WHERE session_id = ? AND timestamp > ? LIMIT 1')
        .get(s.id, cutoffS);
      if (recent) this.announceSession(s);
    }
  }

  private ensureSession(db: DatabaseSync, sessionId: string): void {
    if (this.known.has(sessionId)) return;
    const s = db
      .prepare('SELECT id, source, cwd, ended_at FROM sessions WHERE id = ?')
      .get(sessionId) as unknown as SessionRow | undefined;
    if (s) this.announceSession(s);
  }

  private announceSession(s: SessionRow): void {
    this.known.set(s.id, { lastActivityMs: Date.now() });
    // Persona continuity (Task 10): reattach to an existing character when the
    // persona (source+cwd) already has one; otherwise a fresh SessionStart.
    const existing = this.opts.resolvePersonaAgent(personaKey(s.source, s.cwd));
    if (existing !== undefined) {
      this.opts.reattachSession(existing, s.id);
      return;
    }
    this.opts.onEvent('hermes', {
      hook_event_name: 'SessionStart',
      session_id: s.id,
      source: 'external',
      cwd: s.cwd ?? undefined,
    });
  }

  private emitForRow(row: MessageRow): void {
    if (row.role === 'assistant' && row.tool_calls) {
      let calls: Array<{ id?: string; function?: { name?: string; arguments?: string } }> = [];
      try {
        calls = JSON.parse(row.tool_calls) as typeof calls;
      } catch {
        /* malformed — skip */
      }
      for (const call of calls) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.function?.arguments ?? '{}');
        } catch {
          /* arguments not JSON — keep {} */
        }
        this.opts.onEvent('hermes', {
          hook_event_name: 'PreToolUse',
          session_id: row.session_id,
          tool_name: call.function?.name ?? '',
          tool_input: input,
          tool_call_id: call.id,
        });
      }
    }
    if (row.role === 'tool') {
      this.opts.onEvent('hermes', {
        hook_event_name: 'PostToolUse',
        session_id: row.session_id,
        tool_call_id: row.tool_call_id ?? undefined,
      });
    }
    if (row.role === 'assistant' && row.finish_reason === 'stop') {
      this.opts.onEvent('hermes', { hook_event_name: 'Stop', session_id: row.session_id });
    }
  }

  /** SessionEnd for rows with ended_at set, plus inactivity timeout. */
  private reapEnded(db: DatabaseSync): void {
    if (this.known.size === 0) return;
    const now = Date.now();
    for (const [sessionId, meta] of this.known) {
      const s = db
        .prepare('SELECT ended_at, end_reason FROM sessions WHERE id = ?')
        .get(sessionId) as unknown as
        | { ended_at: number | null; end_reason: string | null }
        | undefined;
      const endedInDb = s?.ended_at != null;
      const inactive = now - meta.lastActivityMs > HERMES_INACTIVITY_TIMEOUT_MS;
      if (endedInDb || inactive) {
        this.known.delete(sessionId);
        this.opts.onEvent('hermes', {
          hook_event_name: 'SessionEnd',
          session_id: sessionId,
          reason: endedInDb ? (s?.end_reason ?? 'ended') : 'stale',
        });
      }
    }
  }
}
```

- [ ] **Step 5: Run tests, commit**

Run: `cd server && npx vitest run __tests__/hermesPoller.test.ts && npm test`
Expected: PASS. (`node:sqlite` prints an experimental warning — harmless.)

```bash
git add server/src/providers/hook/hermes server/__tests__/hermesPoller.test.ts
git commit -m "feat(hermes): state.db poller synthesizing hook envelopes (local-only provider)"
```

---

### Task 10: Persona continuity

**Files:**

- Modify: `server/src/types.ts` (AgentState + PersistedAgent: `personaKey?: string`), `core/src/schemas.ts` (PersistedAgent)
- Modify: `server/src/agentStateStore.ts` (persist `personaKey`), restore path (set it back)
- Modify: `server/src/hookEventHandler.ts` or the adoption path — stamp `personaKey` on hermes agents at creation
- Modify: `server/src/agentRuntime.ts` — `reattachSession` support
- Test: `server/__tests__/hermesPoller.test.ts` (extend)

**Interfaces:**

- Consumes: `HermesPollerOptions.resolvePersonaAgent` / `reattachSession` stubs from Task 9.
- Produces: `runtime.reattachSession(agentId: number, newSessionId: string): void` — re-registers the session mapping and updates `agent.sessionId`; Task 11 wires the real callbacks.

- [ ] **Step 1: Failing test**

Extend `hermesPoller.test.ts`:

```ts
it('reattaches a new session id to an existing persona instead of spawning', () => {
  const reattached: Array<{ agentId: number; sessionId: string }> = [];
  const p = new HermesPoller({
    dbPath,
    onEvent: (pid, env) => events.push({ providerId: pid, envelope: env }),
    resolvePersonaAgent: (key) => (key === 'cli:/proj/a' ? 7 : undefined),
    reattachSession: (agentId, sessionId) => reattached.push({ agentId, sessionId }),
  });
  insertSession('s2', 'cli', '/proj/a');
  insertMessage('s2', 'user');
  p.tick();
  expect(reattached).toEqual([{ agentId: 7, sessionId: 's2' }]);
  expect(events.filter((e) => e.envelope.hook_event_name === 'SessionStart')).toHaveLength(0);
  p.stop();
});
```

Run: expect PASS already if Task 9's `announceSession` was implemented as shown — if so, this test documents the behavior; the failing parts are the runtime pieces below (verified by type-check).

- [ ] **Step 2: personaKey on AgentState + persistence**

- `server/src/types.ts` AgentState: add `personaKey?: string;` near `providerId`. Same field on both `PersistedAgent` interfaces (server + core), and in `agentStateStore.persist()` (`personaKey: agent.personaKey,`) + the restore path (`personaKey: p.personaKey,`).
- Stamp at creation: in the hooks-only/cwd-only adoption branch of `adoptExternalSessionFromHook` (Task 2 added `providerId`), when creating the AgentState also accept and set an optional `personaKey`. The hermes flow computes it as `personaKey(source, cwd)` — thread it via the envelope: include `persona_key` in the poller's SessionStart envelope, read it in the hookEventHandler external-session flow (raw-field read is allowed for adoption metadata, same as `transcript_path`/`cwd`), and pass to adoption.

In the poller's `announceSession`, add `persona_key: personaKey(s.source, s.cwd),` to the SessionStart envelope.

- [ ] **Step 3: runtime.reattachSession**

In `agentRuntime.ts`:

```ts
  /** Re-point an existing agent at a new session id (persona continuity —
   *  Hermes session ids rotate while the persona persists). */
  reattachSession(agentId: number, newSessionId: string): void {
    const agent = this.store.get(agentId);
    if (!agent) return;
    if (agent.sessionId) this.unregisterAgent(agent.sessionId);
    agent.sessionId = newSessionId;
    this.registerAgent(newSessionId, agentId);
    this.store.persist();
  }
```

- [ ] **Step 4: Run everything, commit**

```bash
cd server && npm test && cd .. && npm run build
git add -A server core
git commit -m "feat(hermes): persona continuity — rotating session ids reattach to one character"
```

---

### Task 11: Wire Hermes into the standalone server (config-gated)

**Files:**

- Modify: `server/src/configPersistence.ts` (hermesEnabled — 4 edits: interface, keys array, defaults, parse)
- Modify: `server/src/providers/index.ts` (export hermesProvider)
- Modify: `server/src/cli.ts` (register provider + start poller when enabled)
- Test: existing suites (config parse covered by any configPersistence tests; else rely on types + manual verify)

- [ ] **Step 1: hermesEnabled setting**

In `configPersistence.ts` add `hermesEnabled: boolean;` to `AdapterSettings`, `'hermesEnabled'` to `ADAPTER_SETTING_KEYS`, `hermesEnabled: false` to `DEFAULT_ADAPTER_SETTINGS`, and the typeof-guarded branch in `parseAdapterSettings`:

```ts
    hermesEnabled:
      typeof obj.hermesEnabled === 'boolean'
        ? obj.hermesEnabled
        : DEFAULT_ADAPTER_SETTINGS.hermesEnabled,
```

No UI toggle in v1 — enable by editing `~/.pixel-agents/config.json` → `standalone.hermesEnabled: true` (document in step 4's commit message and CLAUDE.md in Task 12).

- [ ] **Step 2: providers/index.ts**

```ts
// LOCAL-ONLY (do not include in upstream PRs): hermes provider + poller.
export { hermesProvider } from './hook/hermes/hermes.js';
export { HermesPoller } from './hook/hermes/hermesPoller.js';
```

- [ ] **Step 3: cli.ts wiring**

```ts
import { claudeProvider, codexProvider, copyHookScript, hermesProvider, HermesPoller } from './providers/index.js';
import { HERMES_DB_RELATIVE_PATH } from './providers/hook/hermes/constants.js';
...
    const runtime = new AgentRuntime(store, [claudeProvider, codexProvider, hermesProvider]);
```

After the settings-sync lines (`runtime.hooksEnabled.current = ...`):

```ts
// LOCAL-ONLY: hermes state.db poller (config-gated, default off)
let hermesPoller: HermesPoller | null = null;
if (adapter.getSetting('pixel-agents.hermesEnabled', false)) {
  hermesPoller = new HermesPoller({
    dbPath: path.join(os.homedir(), HERMES_DB_RELATIVE_PATH),
    onEvent: (providerId, envelope) => runtime.handleHookEvent(providerId, envelope),
    resolvePersonaAgent: (key) => {
      for (const [id, agent] of store) {
        if (agent.providerId === 'hermes' && agent.personaKey === key) return id;
      }
      return undefined;
    },
    reattachSession: (agentId, sessionId) => runtime.reattachSession(agentId, sessionId),
  });
  hermesPoller.start();
  console.log('[Pixel Agents] Hermes poller started');
}
```

Add `hermesPoller?.stop()` to the shutdown path (grep how the cli handles SIGINT/stop; mirror it). Add `import * as os from 'os';` if not present.

Note: hermesProvider registered unconditionally (harmless — no installer side effects, `installHooks` is a no-op); only the poller is gated.

- [ ] **Step 4: Build + tests + manual verify against the live DB**

```bash
npm run build && cd server && npm test
```

Enable `standalone.hermesEnabled` in `~/.pixel-agents/config.json`, start `npm run web`, confirm:

1. With QuantBot's tmux TUI running (or a `hermes` cli session active): a character appears with the HERMES badge, named from cwd (or the generic fallback).
2. Tool calls animate as they land in state.db; `finish_reason='stop'` produces the waiting bubble.
3. Restart the Hermes session → same character (persona reattach), no despawn/respawn.
4. `sqlite3` is never opened writable (verify no `-wal` growth attributable to us / no errors in Hermes).

```bash
git add -A server
git commit -m "feat(hermes): register provider + config-gated state.db poller (local-only)"
```

---

### Task 12: Documentation + wrap-up

**Files:**

- Modify: `CLAUDE.md` (architecture: providers section, hermes local-only note, hermesEnabled setting)
- Modify: `.claude/active-task.md` (mark done)
- Memory: update `web-app-consolidation.md` / add provider notes per memory protocol

- [ ] **Step 1: CLAUDE.md**

Update the compressed reference: `server/src/providers/` now lists `hook/claude/`, `hook/codex/` (upstreamable), `hook/hermes/` (LOCAL-ONLY — preserve across upstream merges, like claudeProcessScan.ts). Document: multi-provider dispatch (one HookEventHandler per provider), the argv-parameterized hook script, the Codex trust-hash installer, `hermesEnabled` config gate, `provider` field on agentCreated/existingAgents + badge.

- [ ] **Step 2: Full verification**

```bash
npm run build && npm test
```

Expected: everything green.

- [ ] **Step 3: Commit + finish**

```bash
git add CLAUDE.md
git commit -m "docs: multi-provider architecture — codex + hermes providers"
```

Then use superpowers:finishing-a-development-branch (and offer /code-review).
