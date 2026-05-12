import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signed-cookie session (spec §6.4). The cookie value is
 *
 *   <base64url(JSON({ userId, exp }))>.<base64url(HMAC-SHA256(payload, secret))>
 *
 * No server-side state. The HMAC binds the body to the secret so that a
 * client cannot forge or extend a session. Tampering is detected via
 * constant-time comparison; expired payloads are rejected.
 *
 * 7-day TTL by default; callers can override.
 */

export const COOKIE_NAME = 'glm_session';
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionPayload {
  userId: string;
  /** Unix epoch milliseconds at which the cookie should be rejected. */
  exp: number;
}

export class InvalidSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSessionError';
  }
}

/** Encode + sign a payload into a cookie value. */
export function signSession(payload: SessionPayload, secret: string): string {
  const body = base64url(JSON.stringify(payload));
  const mac = hmac(body, secret);
  return `${body}.${mac}`;
}

/** Parse + verify a cookie value. Throws on tamper, malformed, or expired. */
export function verifySession(cookie: string, secret: string, now = Date.now()): SessionPayload {
  const parts = cookie.split('.');
  if (parts.length !== 2) throw new InvalidSessionError('malformed session cookie');
  const [body, mac] = parts as [string, string];
  const expected = hmac(body, secret);
  if (!constantTimeEqualHex(mac, expected)) {
    throw new InvalidSessionError('session signature mismatch');
  }
  let payload: SessionPayload;
  try {
    payload = JSON.parse(fromBase64url(body)) as SessionPayload;
  } catch {
    throw new InvalidSessionError('session payload is not JSON');
  }
  if (typeof payload.userId !== 'string' || typeof payload.exp !== 'number') {
    throw new InvalidSessionError('session payload shape invalid');
  }
  if (payload.exp <= now) {
    throw new InvalidSessionError('session expired');
  }
  return payload;
}

/** Build a `Set-Cookie` header value for the signed session. */
export function buildSetCookie(cookie: string, opts: { secure?: boolean; maxAgeMs?: number } = {}): string {
  const secure = opts.secure ?? true;
  const maxAgeS = Math.floor((opts.maxAgeMs ?? DEFAULT_TTL_MS) / 1000);
  const flags = ['HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAgeS}`];
  if (secure) flags.push('Secure');
  return `${COOKIE_NAME}=${cookie}; ${flags.join('; ')}`;
}

/** Build a `Set-Cookie` that expires the session immediately. */
export function buildClearCookie(opts: { secure?: boolean } = {}): string {
  const secure = opts.secure ?? true;
  const flags = ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
  if (secure) flags.push('Secure');
  return `${COOKIE_NAME}=; ${flags.join('; ')}`;
}

/** Extract our session cookie value from a Cookie header. */
export function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${COOKIE_NAME}=`)) {
      return trimmed.slice(COOKIE_NAME.length + 1);
    }
  }
  return null;
}

/** Generate a 32-byte hex secret suitable for SESSION_SECRET. */
export function generateSecret(): string {
  return randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function hmac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function fromBase64url(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a, 'hex');
  const bBuf = Buffer.from(b, 'hex');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
