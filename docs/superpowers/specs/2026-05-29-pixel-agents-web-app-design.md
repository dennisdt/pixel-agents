# Pixel Agents Web App — Design Spec

**Date:** 2026-05-29
**Branch:** `feat/web-app` (off `feat/tauri-app`)
**Status:** Approved, implementing

## Goal

Host Pixel Agents as a local web app on a port so it can be viewed (and driven)
from mobile devices over Tailscale. Port over the modular visual updates +
leveling system developed on `feat/tauri-app`, but base the watcher on
**upstream's canonical server** rather than a divergent fork.

## Key discovery that shaped the design

Upstream (`pablodelucca` → `pixel-agents-hq`) already ships a **standalone
Fastify server** (`server/src/cli.ts` → `npx pixel-agents` /
`node dist/cli.js --host 0.0.0.0 --port 3100`) with **zero VS Code dependency**:

- Serves the SPA static files + a real `/ws` WebSocket + the hook HTTP endpoint
  in one process.
- Watches `~/.claude/projects/*.jsonl` itself (self-contained interval poller)
  _and_ accepts hook POSTs → discovers and tails terminal sessions headless.
- Webview `transport/webSocketTransport.ts` already pairs with `/ws`
  (reconnect/backoff/pending-queue).
- Ships a formal AsyncAPI 3.0.0 protocol (`core/asyncapi.yaml`), generated typed
  messages (`core/src/messages.ts`), an `AgentRuntime` lifecycle core, and an
  `AgentStateStore` (centralized state + `broadcast`).

This is exactly the web-app backend we would otherwise hand-build in Rust. Per
the user's directive ("use upstream's improvements, don't prioritize our
patches"), we adopt it instead of building a headless Rust binary.

## Decisions (locked)

1. **Full interactive** — launch agents from the phone (not view-only).
2. **Auth** — shared-secret token on top of Tailscale.
3. **Consolidate fully** on upstream's Node server for both web and (eventually)
   desktop; retire the Rust watcher.
4. **#231 subagent-ghost fix** — comes free from upstream's watcher; no Rust
   backport needed under full consolidation.

## What upstream's server does NOT have (we build on top)

- **EXP / leveling pipeline.** Upstream has only ephemeral per-session
  `inputTokens`/`outputTokens` (not per-cwd, not persisted). Our leveling needs
  cumulative `output_tokens` per directory + persistence + `directoryExp` /
  `directoryExpAll` messages.
- **Auth.** Standalone mode deliberately skips WS auth (assumes `127.0.0.1`).
  For `0.0.0.0`/Tailscale we add a shared-secret token gate.
- **Launch-from-web.** Standalone server is observe-only ("+ Agent" hidden, no
  `launchAgent` handler). We add server-side agent spawning.

## Architecture

### End state

One backend — upstream's Fastify server (`node dist/cli.js`) — serves SPA +
`/ws` + hooks and watches JSONL headless. The webview (with our aura/leveling)
connects via `transport/`'s `WebSocketTransport`. Rust watcher retired.
Reachable from phone at `http://<tailscale-ip>:3100`.

### Transitional (during this spec)

The desktop Tauri app stays on its Rust backend until Phase 2. To keep it
working after the merge (which deletes `vscodeApi.ts`), we add a
`TauriTransport` implementation of the new `MessageTransport` interface.

## Plan

### Phase 0 — Merge `upstream/main` → `feat/web-app` (foundation)

Done as one controlled pass; validate on a throwaway integration branch first;
gate on `npm test` (webview + server) + both builds green before landing.

- Resolve the 5 conflicts:
  - `webview-ui/src/main.tsx` — combine browserMock guards →
    `isBrowserRuntime && import.meta.env.DEV && !isTauri()`.
  - `webview-ui/src/office/toolUtils.ts` — union: keep upstream
    `setProviderCapabilities`/`isReadingToolName`/`isSubagentToolName` **and** our
    `calculateLevel`/`getAuraForLevel`/`getAuraIntensity`; reconcile the shared
    `../constants.js` import.
  - `webview-ui/src/components/BottomToolbar.tsx` — take upstream structure
    (`transport.send('launchAgent')` + `isBrowserRuntime` gating); re-insert our
    Tauri `ProjectPickerModal` branch (guarded by `isTauri()`).
  - `webview-ui/src/hooks/useExtensionMessages.ts` — take upstream's
    `transport.onMessage` pump + `providerCapabilities`; re-layer our
    `directoryExp`/`directoryExpAll`/`syncCharacterLevel` handlers.
  - `webview-ui/src/vscodeApi.ts` — **delete** (modify/delete; upstream removed
    it). Port `createTauriApi`'s queue-until-ready logic into `TauriTransport`.
- Adopt `transport/` as canonical; delete our `ipc/` layer
  (`backend.ts`, `tauri-backend.ts`, `vscode-backend.ts`).
- Add `TauriTransport implements MessageTransport` (port from
  `ipc/tauri-backend.ts`: `MESSAGE_TO_COMMAND` invoke map for `send`,
  `tauri.event.listen('backend-event')` for `onMessage`, ready/queue). Extend
  `runtime.ts` with `isTauri()`; add a Tauri branch to `createTransport()` (else
  Tauri wrongly selects `WebSocketTransport`).
- Add `directoryExp` / `directoryExpAll` to `core/asyncapi.yaml`; regenerate
  `core/src/messages.ts`.
- **Trap fix:** default the webview's reading-tool set to Claude's known reading
  tools so `isReadingTool` works before/without a `providerCapabilities` message
  — keeps reading-vs-typing animations correct on web _and_ the still-Rust
  desktop app.
- Update `CLAUDE.md` to the new `core/` + `adapters/vscode/` + `server/` layout.

### Phase 1 — Web app on the Node server

- **EXP/leveling pipeline (Node).** Port the Rust logic: accumulate
  `message.usage.output_tokens` per cwd + `credited_sessions` dedupe (in `core/`
  or `server/`); persist to `~/.pixel-agents/directory-stats.json` (atomic
  tmp+rename); pre-scan history once on adoption; emit `directoryExpAll` on boot
  and `directoryExp` on increment. Becomes the single EXP source (serves desktop
  after Phase 2).
- **Auth (shared-secret token).** Token via env (`PIXEL_AGENTS_TOKEN`) or
  persisted; minimal login page → signed HMAC cookie checked on `/`, `/ws`,
  `/api/*` (hook endpoint keeps its own bearer token). Default-bind `127.0.0.1`;
  `--host 0.0.0.0` opt-in with a loud startup warning if exposed without a token.
  Verify CSP allows the same-origin `ws(s)`.
- **Launch-from-web (full interactive).** New `launchAgent` server handler that
  spawns `claude --session-id <uuid>` into a tmux window on the host; server-side
  recent-projects list + path entry replaces native folder dialogs; un-hide
  "+ Agent" in browser mode when the server advertises launch capability.
  `focusAgent`/export/import stay no-ops on web for v1.
- **Tailscale ops.** `npm run web` (build cli + webview, then run); optional
  launchd plist / `start.sh` for an always-on daemon; `/api/health` already
  exists for watchdogs. Transport security = Tailscale WireGuard (plain http over
  the tailnet is fine; `tailscale serve`/cert optional later).

## Risks / traps (all surfaced during investigation)

- `providerCapabilities` semantic dependency → handled by the default reading-
  tool list.
- WS-auth gap in standalone mode → the auth build-on-top.
- Upstream token counters not persisted → our EXP store owns persistence.
- Merge temporarily touches the desktop app → `TauriTransport` + default-tool
  list keep it working.

## Testing

- `npm test` (webview + server vitest) green post-merge.
- New server tests: EXP accumulation / dedupe / persistence / emission; auth
  gate; `launchAgent` (mock tmux).
- Manual: build → `node dist/cli.js --host 0.0.0.0 --token …` → open from phone
  over Tailscale → agents appear, leveling/auras light up, launch works.
- Desktop Tauri smoke test still passes.

## Deferred → Phase 2 (separate spec)

Migrate the desktop Tauri app to run the Node server as a sidecar (webview →
`ws://127.0.0.1`), delete the Rust watcher/hooks/EXP, remove `TauriTransport`.
