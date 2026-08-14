# Remote access

Pixel Agents ships a standalone web server — no VS Code required. This guide
covers running it locally, exposing it to your phone over
[Tailscale](https://tailscale.com), and the password screen that protects it.

## Running locally

```bash
npm run web
```

This builds the server + webview and starts on `http://127.0.0.1:3100`. Bound
to loopback, the server is only reachable from the same machine and **no
password is required**.

CLI flags (via `node dist/cli.js` directly):

```
--port, -p <number>   Port to listen on (default: 3100)
--host <string>       Host to bind to (default: 127.0.0.1)
```

## Accessing on your phone with Tailscale

Tailscale is a zero-config mesh VPN built on WireGuard. Install it on the
machine running Pixel Agents and on your phone, and they join the same private
network — no port forwarding, no public exposure. Traffic is encrypted
end-to-end by WireGuard, and the access password protects the UI at the
application level on top of that.

The web UI is mobile-friendly (touch drag-pan, pinch-zoom, installable as a
PWA), so it works well as a glanceable agent dashboard from your phone.

**Setup:**

1. Install [Tailscale](https://tailscale.com/download) on your server and your
   iPhone/Android.
2. Start the server bound to all interfaces with a password of your choosing:

   ```bash
   PIXEL_AGENTS_TOKEN=your-secret npm run web:host
   ```

   (`web:host` is `npm run web` + `--host 0.0.0.0`. Equivalent direct form:
   `PIXEL_AGENTS_TOKEN=your-secret node dist/cli.js --host 0.0.0.0 --port 3100`.)

3. Open `http://<server-tailscale-ip>:3100` in your phone's browser (find the
   server's Tailscale IP in the Tailscale app or with `tailscale ip -4`).
   You'll see a sign-in screen — enter the password once.

4. Optional: use your browser's **Add to Home Screen** for an app-like
   experience. The PWA manifest and icons are served without auth so the
   installed app gets the proper icon.

### How the password works

- The password is supplied **only** via the `PIXEL_AGENTS_TOKEN` environment
  variable at launch. It is never written to disk by the server, and the
  server never prints it to the log.
- If you bind to a non-loopback host **without** setting `PIXEL_AGENTS_TOKEN`,
  the server refuses to run open: it generates a random token and prints a
  one-time login URL to the console. Set the env var to pin a stable password.
- Signing in (via the form, or by opening
  `http://<ip>:3100/login?token=your-secret` once) sets an httpOnly `pa_auth`
  cookie valid for 1 year. The cookie also rides the WebSocket upgrade, so the
  client code never handles the secret. You sign in once per device.
- For scripts/health tooling, an `Authorization: Bearer <token>` header is
  accepted on any route.
- The gate covers the SPA, `/ws`, and `/api/*`. Exempt: `/api/health`,
  `/login`, the Claude hook endpoint (it carries its own machine-to-machine
  bearer token), and the PWA manifest/icons.
- To rotate the password, restart the server with a new `PIXEL_AGENTS_TOKEN`.
  All existing cookies become invalid immediately.

> **Note:** `~/.pixel-agents/server.json` contains a `token` field — that is
> **not** the access password. It's a separate token regenerated on every
> startup, used by the Claude Code hook scripts to authenticate against the
> local hook endpoint.

## Keeping it running

The server is a single foreground process. For a quick always-on setup:

```bash
PIXEL_AGENTS_TOKEN=your-secret nohup node dist/cli.js --host 0.0.0.0 --port 3100 \
  > ~/.pixel-agents/server.log 2>&1 &
```

`GET /api/health` requires no auth and is suitable for watchdogs. For
proper supervision (auto-restart on crash or reboot), wrap the same command in
a launchd plist (macOS) or systemd unit (Linux).

### Redeploying changes

- **Webview-only changes** (anything under `webview-ui/`): rebuild
  (`npm run web:build`) — the running server serves the new bundle from
  `dist/webview` on the next browser refresh. No restart needed.
- **Server changes** (anything under `server/` or `core/`): rebuild **and**
  restart the process.

## Accessing from a remote machine over SSH

If you don't use Tailscale, keep the server on loopback and tunnel:

```bash
ssh -N -L 3100:127.0.0.1:3100 user@your.server.com
```

Then open `http://localhost:3100` locally. No password needed — loopback
binds skip auth.

## Security notes

- Plain HTTP is fine **inside a tailnet**: WireGuard already encrypts every
  packet between your devices. The password is defense-in-depth in case a
  device on your tailnet is compromised.
- Do **not** port-forward the server to the public internet. The password
  screen is not designed to be the only line of defense (no rate limiting, no
  TLS). If you need public access, put it behind a reverse proxy with TLS and
  proper auth, or use `tailscale serve`/`tailscale funnel` which handle certs.
- Token comparison is constant-time, and the cookie is httpOnly — but the
  login URL form (`/login?token=...`) can end up in browser history; prefer
  the form field on shared devices.
