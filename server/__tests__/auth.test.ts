import { describe, expect, it } from 'vitest';

import {
  AUTH_COOKIE,
  getCookie,
  isAuthed,
  isLoopbackHost,
  resolveAccessAuth,
  safeEqual,
} from '../src/auth.js';

describe('auth', () => {
  it('safeEqual compares constant-time and rejects mismatches/lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('getCookie extracts a named cookie from a Cookie header', () => {
    expect(getCookie('pa_auth=xyz', 'pa_auth')).toBe('xyz');
    expect(getCookie('a=1; pa_auth=xyz; b=2', 'pa_auth')).toBe('xyz');
    expect(getCookie('a=1; b=2', 'pa_auth')).toBeUndefined();
    expect(getCookie(undefined, 'pa_auth')).toBeUndefined();
    expect(getCookie(`${AUTH_COOKIE}=a%20b`, AUTH_COOKIE)).toBe('a b');
  });

  it('isAuthed accepts a valid cookie or Bearer header, rejects otherwise', () => {
    const token = 'secret-123';
    expect(isAuthed({ cookie: `${AUTH_COOKIE}=secret-123` }, token)).toBe(true);
    expect(isAuthed({ authorization: 'Bearer secret-123' }, token)).toBe(true);
    expect(isAuthed({ cookie: `${AUTH_COOKIE}=nope` }, token)).toBe(false);
    expect(isAuthed({ authorization: 'Bearer nope' }, token)).toBe(false);
    expect(isAuthed({}, token)).toBe(false);
  });

  it('isLoopbackHost recognizes local hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('100.64.1.2')).toBe(false);
  });

  it('resolveAccessAuth: loopback → no auth', () => {
    const r = resolveAccessAuth('127.0.0.1', undefined);
    expect(r.requireAuth).toBe(false);
    expect(r.generated).toBe(false);
  });

  it('resolveAccessAuth: non-loopback with no env token → generated, required', () => {
    const r = resolveAccessAuth('0.0.0.0', undefined);
    expect(r.requireAuth).toBe(true);
    expect(r.generated).toBe(true);
    expect(r.token.length).toBeGreaterThan(0);
  });

  it('resolveAccessAuth: explicit env token → required, not generated, even on loopback', () => {
    const r = resolveAccessAuth('127.0.0.1', 'my-token');
    expect(r.requireAuth).toBe(true);
    expect(r.generated).toBe(false);
    expect(r.token).toBe('my-token');
  });
});
