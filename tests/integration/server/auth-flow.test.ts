import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { COOKIE_NAME } from '../../../src/auth/session.ts';
import { runMigrations } from '../../../src/repository/db.ts';
import { createApp } from '../../../src/server/app.ts';
import { MIGRATIONS_DIR } from '../helpers.ts';

describe('auth flow (login / logout / me)', () => {
  let db: Database;
  let app: ReturnType<typeof createApp>['app'];

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db, MIGRATIONS_DIR);
    ({ app } = createApp({
      db,
      sessionSecret: 'a'.repeat(64),
      cookieSecure: false,
      allowTestAuthHeader: false,
    }));
  });
  afterEach(() => db.close());

  test('login creates a user on first sight and issues a Set-Cookie', async () => {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });
    expect(res.status).toBe(200);
    const cookieHeader = res.headers.get('set-cookie') ?? '';
    expect(cookieHeader.startsWith(`${COOKIE_NAME}=`)).toBe(true);
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('SameSite=Strict');

    const me = await app.request('/api/v1/auth/me', {
      headers: { cookie: cookieHeader.split(';')[0] ?? '' },
    });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { email: string; role: string } };
    expect(body.user.email).toBe('alice@example.com');
    expect(body.user.role).toBe('editor');
  });

  test('login is idempotent across sessions for the same email', async () => {
    const first = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com' }),
    });
    const second = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com' }),
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = (await first.json()) as { user: { id: string } };
    const b = (await second.json()) as { user: { id: string } };
    expect(a.user.id).toBe(b.user.id);
  });

  test('login rejects a missing or malformed email', async () => {
    const r1 = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r1.status).toBe(400);
    const r2 = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(r2.status).toBe(400);
  });

  test('logout returns 204 and clears the cookie', async () => {
    const res = await app.request('/api/v1/auth/logout', { method: 'POST' });
    expect(res.status).toBe(204);
    const cookieHeader = res.headers.get('set-cookie') ?? '';
    expect(cookieHeader).toContain('Max-Age=0');
  });

  test('me without a cookie returns 401', async () => {
    const res = await app.request('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });
});
