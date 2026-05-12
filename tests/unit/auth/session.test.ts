import { describe, expect, test } from 'bun:test';
import {
  COOKIE_NAME,
  InvalidSessionError,
  buildClearCookie,
  buildSetCookie,
  generateSecret,
  readSessionCookie,
  signSession,
  verifySession,
} from '../../../src/auth/session.ts';

const SECRET = 'a'.repeat(64);

describe('signSession + verifySession', () => {
  test('round-trips an unexpired payload', () => {
    const cookie = signSession({ userId: 'u1', exp: Date.now() + 60_000 }, SECRET);
    const decoded = verifySession(cookie, SECRET);
    expect(decoded.userId).toBe('u1');
  });

  test('rejects tampered body', () => {
    const cookie = signSession({ userId: 'u1', exp: Date.now() + 60_000 }, SECRET);
    const parts = cookie.split('.');
    const tampered = `${parts[0]}x.${parts[1]}`;
    expect(() => verifySession(tampered, SECRET)).toThrow(InvalidSessionError);
  });

  test('rejects forged signature', () => {
    const cookie = signSession({ userId: 'u1', exp: Date.now() + 60_000 }, 'other-secret');
    expect(() => verifySession(cookie, SECRET)).toThrow(InvalidSessionError);
  });

  test('rejects expired payload', () => {
    const cookie = signSession({ userId: 'u1', exp: 100 }, SECRET);
    expect(() => verifySession(cookie, SECRET)).toThrow(InvalidSessionError);
  });

  test('rejects malformed cookie', () => {
    expect(() => verifySession('not-a-cookie', SECRET)).toThrow(InvalidSessionError);
  });
});

describe('cookie header helpers', () => {
  test('buildSetCookie attaches HttpOnly + SameSite=Strict', () => {
    const header = buildSetCookie('value-here', { secure: false });
    expect(header).toContain(`${COOKIE_NAME}=value-here`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).not.toContain('Secure');
  });

  test('buildClearCookie sets Max-Age=0', () => {
    expect(buildClearCookie({ secure: false })).toContain('Max-Age=0');
  });

  test('readSessionCookie extracts our value from a multi-cookie header', () => {
    const header = `other=foo; ${COOKIE_NAME}=abc.def; another=bar`;
    expect(readSessionCookie(header)).toBe('abc.def');
  });

  test('readSessionCookie returns null when missing', () => {
    expect(readSessionCookie('other=foo')).toBeNull();
    expect(readSessionCookie(null)).toBeNull();
  });
});

describe('generateSecret', () => {
  test('returns 64 hex chars', () => {
    const s = generateSecret();
    expect(s.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(s)).toBe(true);
  });
});
