/**
 * Access auth for the standalone web app.
 *
 * Standalone mode bound to 127.0.0.1 needs no auth (local only). When bound to a
 * non-loopback host (0.0.0.0 for Tailscale/LAN), a shared-secret access token
 * gates the SPA, /ws, and /api/* — defense-in-depth on top of the Tailscale VPN.
 *
 * Delivery: the user opens `/login?token=<token>` once (on their phone); the
 * server sets an httpOnly cookie that rides along on subsequent page loads AND
 * the same-origin WebSocket upgrade, so no client code needs the token.
 *
 * This is distinct from the hook bearer token in server.json (machine-to-machine
 * for the local hook script).
 */

import * as crypto from 'crypto';

export const AUTH_COOKIE = 'pa_auth';

/** Constant-time string equality (avoids token-comparison timing leaks). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Extract a single cookie value from a Cookie header. */
export function getCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

/** True if the request carries a valid access token via cookie or Bearer header. */
export function isAuthed(
  headers: { cookie?: string; authorization?: string },
  token: string,
): boolean {
  const cookie = getCookie(headers.cookie, AUTH_COOKIE);
  if (cookie && safeEqual(cookie, token)) return true;
  const auth = headers.authorization ?? '';
  const prefix = 'Bearer ';
  if (auth.startsWith(prefix) && safeEqual(auth.slice(prefix.length), token)) return true;
  return false;
}

/** Hosts that need no access auth (server only reachable locally). */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Resolve the access-auth posture from the bind host + environment.
 * - Explicit PIXEL_AGENTS_TOKEN → require it (regardless of host).
 * - Non-loopback host with no token → generate one (caller prints it loudly).
 * - Loopback host with no token → no auth (local only).
 */
export function resolveAccessAuth(
  host: string,
  envToken: string | undefined,
): { requireAuth: boolean; token: string; generated: boolean } {
  if (envToken) {
    return { requireAuth: true, token: envToken, generated: false };
  }
  if (!isLoopbackHost(host)) {
    return { requireAuth: true, token: crypto.randomUUID(), generated: true };
  }
  return { requireAuth: false, token: '', generated: false };
}

/** Minimal standalone login page (no SPA assets needed). */
export function loginPageHtml(error: boolean): string {
  const msg = error
    ? '<p style="color:#ff6b6b">Invalid token. Try again.</p>'
    : '<p style="color:#9aa">Enter your access token.</p>';
  return `<!doctype html>
<html lang="en" style="color-scheme:dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pixel Agents — Sign in</title>
<style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
    background:#1e1e2e;color:#fff;font-family:system-ui,sans-serif}
  form{background:#2a2a3e;padding:24px;border:2px solid #444;box-shadow:4px 4px 0 #0a0a14;
    display:flex;flex-direction:column;gap:12px;min-width:260px}
  h1{font-size:18px;margin:0 0 4px}
  input{padding:10px;border:2px solid #555;background:#1e1e2e;color:#fff;font-size:16px}
  button{padding:10px;border:none;background:#7aa2f7;color:#0a0a14;font-weight:700;
    font-size:16px;cursor:pointer}
</style>
</head>
<body>
<form method="GET" action="/login">
  <h1>Pixel Agents</h1>
  ${msg}
  <input name="token" type="password" placeholder="access token" autofocus autocomplete="current-password" />
  <button type="submit">Enter</button>
</form>
</body>
</html>`;
}
