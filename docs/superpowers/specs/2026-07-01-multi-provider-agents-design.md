# Multi-Provider Pixel Agents: Claude + Codex + Hermes

**Date:** 2026-07-01
**Status:** Approved
**Branch:** feat/web-app

## Goal

Extend pixel-agents beyond Claude Code so externally started **Codex CLI** and
**hermes-agent** sessions render as office characters with live tool animations,
waiting bubbles, and despawn. Render-only adoption in v1 — no launch-from-web
for new providers. Claude behavior unchanged.

## Decisions

| Question           | Decision                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| v1 scope           | Render-only adoption of externally started sessions                                                     |
| Hermes coverage    | All `~/.hermes/state.db` sessions (cli/TUI, webui, gateway)                                             |
| Character identity | Persistent persona character — new Hermes session id reattaches to existing character                   |
| Provider visuals   | Small static pixel badge per provider near name label / ToolOverlay                                     |
| Upstream policy    | Local-first; core dispatch + Codex provider kept upstreamable, Hermes stays local                       |
| Codex hook trust   | Installer rewrites `~/.codex/hooks.json` AND auto-updates `[hooks.state]` trust hashes in `config.toml` |

## Background (feasibility evidence)

- A provider abstraction already exists: `HookProvider` in `core/src/provider.ts:60-135`
  (id, `protocolVersion`, `usesTranscriptFile`, `normalizeHookEvent`,
  `installHooks`/`uninstallHooks`/`areHooksInstalled`, `formatToolStatus`,
  tool-name sets `permissionExemptTools`/`subagentToolNames`/`readingTools`).
  HTTP route `/api/hooks/:providerId` already parses a provider id
  (`server/src/httpServer.ts:162-191`).
- Required event stream per session (`server/src/hookEventHandler.ts:318-348`):
  `sessionStart` → `toolStart`/`toolEnd` → `turnEnd` → (`permissionRequest`) → `sessionEnd`.
  Wire shape: POST with Bearer hook token, snake_case `session_id` + `hook_event_name`
  (`core/src/schemas.ts:101-105`).
- **Codex 0.142.4 natively speaks the Claude Code hooks schema.** The pixel-agents
  hook script is already installed in `~/.codex/hooks.json` posting to the
  `/claude` route, and `HookEventHandler.handleEvent` ignores its `_providerId`
  param (`server/src/hookEventHandler.ts:131`) — so Codex events currently
  impersonate Claude. Fixing dispatch is both the blocker and a bug fix.
- Codex sessions are JSONL rollout files
  (`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`) with `session_meta.cwd`,
  `task_started`/`task_complete`, `function_call`/`function_call_output`.
  Not parsed in v1 (see Codex section).
- Hermes has no per-session transcript files. Universal surface: read-only WAL
  polling of `~/.hermes/state.db`. Tool-call rows flush mid-turn (live granularity);
  `messages.finish_reason='stop'` = turn end (`'tool_calls'` = mid-turn);
  `sessions` table has `id`, `source`, `cwd`, `ended_at`/`end_reason`.
  No permission/approval signal in the DB (exists only on the dashboard WebSocket).

## 1. Core: multi-provider dispatch (upstreamable)

- Replace single-provider injection (`server/src/cli.ts:117`) with a registry-built
  `Map<providerId, { provider, handler: HookEventHandler }>` — one handler instance
  per provider so per-session state and timers stay isolated.
  `server.onHookEvent` dispatches by the URL's provider id.
- Events for unregistered provider ids are rejected (fixes Codex-as-Claude contamination).
- `clientMessageHandler.ts` drops its direct `claudeProvider` import (`:11`);
  session dirs / launch resolve through the registry. Launch remains Claude-only in v1.
- `providerCapabilities` message becomes per-provider: carries `providerId`; webview
  keeps a `Map<providerId, capabilities>`. (`core/src/messages.ts:64-68`, asyncapi regen.)
- `agentCreated` + webview `Character` + `PersistedAgent` gain `provider: string`
  (default `'claude'` for back-compat). `PersistedAgent.jsonlFile`/`projectDir`
  become optional (`core/src/schemas.ts:9-22`) — Hermes has neither.
- Pre-existing one-line fix: `hookEventHandler.ts:434` hardcodes
  `toolName !== 'Task' && toolName !== 'Agent'` → use `provider.subagentToolNames`.

## 2. Codex provider (upstreamable)

- New `server/src/providers/hook/codex/` mirroring the Claude provider:
  `id: 'codex'`, `protocolVersion: 1`, same six hook events
  (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop).
- **One parameterized hook script**: the route segment (currently hardcoded `/claude`
  at `providers/hook/claude/hooks/claude-hook.ts:35`) is injected at install time.
  No fork of the script.
- Installer writes `~/.codex/hooks.json` (posting to `/api/hooks/codex`) and updates
  the sha256 `trusted_hash` entries under `[hooks.state]` in `~/.codex/config.toml`.
  Migration note: replaces the existing /claude-route install on first run.
- **Hooks-only in v1** — no rollout-JSONL parsing. Status text comes from
  `PreToolUse.tool_input` via `formatToolStatus`.
- **Staleness/despawn:** Codex emits no SessionEnd hook (observed). Use the rollout
  file's mtime — `transcript_path` from SessionStart — for stale-checks without
  parsing contents. `usesTranscriptFile: true`, but transcript _parsing_ is gated
  off for Codex (mtime only).
- Tool sets: `exec_command` family → typing; `readingTools ≈ { web_search }`;
  `subagentToolNames = {}` (no sub-agent characters — no Subagent hooks observed).
- Adoption only: sessions start externally (`codex`, `codex resume <id>`); SessionStart
  hook creates the agent. No `--session-id` for new sessions exists anyway (UUIDv7,
  server-generated).
- Future (out of v1): rollout-JSONL polling as hooks-fallback + EXP from
  `token_count` events — requires wiring `HookProvider.parseTranscriptLine`
  (currently zero callers, `core/src/provider.ts:118`) and un-hardcoding
  `sessionId == basename(file, '.jsonl')` in `fileWatcher.ts:485/:927/:1321` and
  `agentRuntime.ts:503`.

## 3. Hermes provider (local-only)

Maintained as a local patch alongside `claudeProcessScan.ts` (per upstream policy).

- `hermesProvider`: `id: 'hermes'`, `usesTranscriptFile: false` — uses the cwd-only
  adoption path (`hookEventHandler.ts:221-223`).
- **In-server poller module**, config-gated (off by default), doing read-only WAL
  reads of `~/.hermes/state.db` and synthesizing `AgentEvent`s fed to the hermes
  handler (direct call, not HTTP):
  - new `sessions` row → `sessionStart` (with `cwd`)
  - assistant message row with `tool_calls` JSON → `toolStart` (toolId = `tool_call_id`)
  - `role='tool'` row → `toolEnd`
  - `finish_reason='stop'` → `turnEnd`
  - `sessions.ended_at` set → `sessionEnd`
- **Persona continuity:** provider keeps persona key = (`source`, `cwd`) → character
  mapping. A new session id whose key matches an existing character reattaches
  (keeps seat, EXP, name) instead of despawn/respawn churn. QuantBot survives
  session restarts within a server run. Continuity does NOT currently survive a
  pixel-agents _server_ restart: `restoreExternalAgents` only restores agents
  with a `jsonlFile` on disk, and hooks-only providers persist `jsonlFile: ''`,
  so a persisted persona has nothing to reattach to after the process
  restarts. See `agentStateStore.ts` (persist site) and `cli.ts`
  (`resolvePersonaAgent`) for the in-code note; cross-restart reattach is a
  documented follow-up, not yet implemented.
- No permission bubbles in v1 — `state.db` carries no approval signal. Documented
  future path: dashboard WebSocket `approval.request` (`tui_gateway /api/events`),
  which would need a `StreamProvider` kind (TODO at `core/src/provider.ts:137`).
- Known caveat: mid-turn insert ordering unverified — worst case `toolStart` arrives
  at tool completion; animations still work, slightly delayed.

## 4. Webview

- Static 8×8 pixel provider badge near the name label / in ToolOverlay, keyed off
  the new `provider` field. No animation, no new character sprites or palettes
  (restrained-effects preference).
- Animation mapping is already provider-agnostic via capabilities
  (`webview-ui/src/office/toolUtils.ts:113-135`); unknown tools default to the
  typing animation.

## 5. Error handling

- Unknown provider id on `/api/hooks/:providerId` → 200 `'ok'`, event dropped in
  `AgentRuntime.handleHookEvent` with a debug log (not a 404: hook scripts fire
  off the response, so a non-2xx status would just add noise to their own
  error handling without anyone downstream reading it).
- `protocolVersion` mismatch → events dropped (existing behavior, now per provider).
- Hermes DB unreadable/locked → poller backs off and retries; no agent state changes
  on read failure (WAL read-only connection).
- Codex trust-hash update failure → installer reports actionable error (manual
  re-trust instructions); hooks.json left consistent (write both files or neither).

## 6. Testing

- Vitest, `server/__tests__/`:
  - Dispatch: two registered providers, events route to the right handler, no
    cross-talk; unregistered id rejected.
  - Codex: `normalizeHookEvent` for all six events; installer rewrites hooks.json +
    trust hashes against a fixture `config.toml`; migration from /claude-route install.
  - Hermes: poller row→event mapping and persona reattach against a fixture sqlite DB.
- Existing Claude tests stay green in every phase.

## 7. Rollout phases (independently landable)

1. **Core dispatch** — registry, per-provider handlers, `provider` field,
   per-provider capabilities, schema/back-compat migrations.
2. **Codex provider** — provider + parameterized hook script + installer/trust,
   badge rendering.
3. **Hermes provider** — poller, persona continuity, local-patch isolation.

## Out of scope (v1)

- Launch-from-web for Codex/Hermes.
- Codex rollout-transcript parsing (status fallback, EXP).
- Hermes permission bubbles / dashboard WebSocket transport.
- Sub-agent characters for Codex/Hermes.
