import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import {
  buildClearCookie,
  buildSetCookie,
  DEFAULT_TTL_MS,
  signSession,
} from '../../auth/session.ts';
import type { UserRole } from '../../types.ts';
import { type AppEnv, requirePrincipal } from '../middleware/auth.ts';
import { httpError } from '../middleware/error.ts';

/**
 * Browser authentication routes.
 *
 *   POST /auth/login   { email }         → 200 { user }  + Set-Cookie
 *   POST /auth/logout                    → 204             + clear cookie
 *   GET  /auth/me                        → 200 { user }
 *
 * v1 ships a password-less dev login: the server auto-creates a user with
 * role=editor on first sight of an email. Real auth (OIDC / SAML / WebAuthn)
 * arrives in Phase 10; the route signatures here are forward-compatible.
 */
export function authRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/auth/login', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; displayName?: string };
    const email = normalizeEmail(body.email);
    if (!email) throw httpError(400, 'a valid email is required');
    const displayName = sanitizeDisplayName(body.displayName, email);
    let user = c.var.repos.users.findByEmail(email);
    if (!user) {
      user = c.var.repos.users.insert({
        id: randomUUID(),
        email,
        displayName,
        role: 'editor' as UserRole,
      });
    }
    const exp = c.var.deps.clock().getTime() + DEFAULT_TTL_MS;
    const cookie = signSession({ userId: user.id, exp }, c.var.deps.sessionSecret);
    c.header('Set-Cookie', buildSetCookie(cookie, { secure: c.var.deps.cookieSecure }));
    return c.json({ user });
  });

  app.post('/auth/logout', (c) => {
    c.header('Set-Cookie', buildClearCookie({ secure: c.var.deps.cookieSecure }));
    return c.body(null, 204);
  });

  app.get('/auth/me', (c) => {
    const principal = requirePrincipal(c);
    return c.json({ user: principal.user, via: principal.via });
  });

  return app;
}

const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const MAX_EMAIL_LENGTH = 254; // RFC 5321 path limit
const MAX_DISPLAY_NAME = 80;

/** Returns the email normalized to lowercase, or `null` if it fails validation. */
function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_EMAIL_LENGTH) return null;
  if (/\s/.test(trimmed)) return null;
  if (!EMAIL_PATTERN.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function sanitizeDisplayName(raw: unknown, fallbackEmail: string): string {
  const candidate = typeof raw === 'string' ? raw.trim() : '';
  const base = candidate.length > 0 ? candidate : (fallbackEmail.split('@')[0] ?? fallbackEmail);
  return base.slice(0, MAX_DISPLAY_NAME);
}
