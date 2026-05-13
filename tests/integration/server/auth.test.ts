import { afterEach, describe, expect, test } from 'bun:test';
import { issueApiToken } from '../../../src/auth/api-token.ts';
import { buildSetCookie, signSession } from '../../../src/auth/session.ts';
import { makeTestServer, type TestServer } from './helpers.ts';

describe('auth middleware', () => {
  let s: TestServer;
  afterEach(() => s.db.close());

  test('rejects anonymous requests with 401', async () => {
    s = makeTestServer();
    const res = await s.app.request('/api/v1/workspaces/ws-1/nodes');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthenticated');
  });

  test('accepts x-test-user-id when allowTestAuthHeader=true', async () => {
    s = makeTestServer();
    const res = await s.request('GET', '/api/v1/workspaces/ws-1/nodes');
    expect(res.status).toBe(200);
  });

  test('rejects x-test-user-id when allowTestAuthHeader is off', async () => {
    const db = new (await import('bun:sqlite')).Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    const { runMigrations } = await import('../../../src/repository/db.ts');
    const { MIGRATIONS_DIR } = await import('../helpers.ts');
    runMigrations(db, MIGRATIONS_DIR);
    db.prepare('INSERT INTO users (id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'user-1',
      'alice@example.com',
      'Alice',
      'editor',
      new Date().toISOString(),
    );
    db.prepare('INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)').run(
      'ws-1',
      'demo',
      'Demo',
      new Date().toISOString(),
    );
    const { createApp } = await import('../../../src/server/app.ts');
    const { app } = createApp({
      db,
      sessionSecret: 'a'.repeat(64),
      cookieSecure: false,
      allowTestAuthHeader: false,
    });
    const res = await app.request('/api/v1/workspaces/ws-1/nodes', {
      headers: { 'x-test-user-id': 'user-1' },
    });
    expect(res.status).toBe(401);
    db.close();
  });

  test('accepts a valid session cookie', async () => {
    s = makeTestServer();
    const cookie = signSession({ userId: 'user-1', exp: Date.now() + 60_000 }, s.deps.sessionSecret);
    const setCookieHeader = buildSetCookie(cookie, { secure: false });
    // Use just the name=value portion as a Cookie header
    const cookieHeader = setCookieHeader.split(';')[0];
    const res = await s.app.request('/api/v1/workspaces/ws-1/nodes', {
      headers: { cookie: cookieHeader ?? '' },
    });
    expect(res.status).toBe(200);
  });

  test('rejects a session cookie with a forged signature', async () => {
    s = makeTestServer();
    const cookie = signSession({ userId: 'user-1', exp: Date.now() + 60_000 }, 'wrong-secret');
    const res = await s.app.request('/api/v1/workspaces/ws-1/nodes', {
      headers: { cookie: `glm_session=${cookie}` },
    });
    expect(res.status).toBe(401);
  });

  test('accepts a valid Bearer API token', async () => {
    s = makeTestServer();
    const { rawToken } = issueApiToken(s.deps.repos.apiTokens, {
      id: 'tok-1',
      userId: 'user-1',
      name: 'laptop-CLI',
    });
    const res = await s.app.request('/api/v1/workspaces/ws-1/nodes', {
      headers: { authorization: `Bearer ${rawToken}` },
    });
    expect(res.status).toBe(200);
  });

  test('rejects a tampered Bearer token', async () => {
    s = makeTestServer();
    const { rawToken } = issueApiToken(s.deps.repos.apiTokens, {
      id: 'tok-2',
      userId: 'user-1',
      name: 'cli',
    });
    const tampered = `${rawToken}x`;
    const res = await s.app.request('/api/v1/workspaces/ws-1/nodes', {
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(res.status).toBe(401);
  });

  test('revoked Bearer token is rejected', async () => {
    s = makeTestServer();
    const { rawToken, stored } = issueApiToken(s.deps.repos.apiTokens, {
      id: 'tok-3',
      userId: 'user-1',
      name: 'cli',
    });
    s.deps.repos.apiTokens.revoke(stored.id);
    const res = await s.app.request('/api/v1/workspaces/ws-1/nodes', {
      headers: { authorization: `Bearer ${rawToken}` },
    });
    expect(res.status).toBe(401);
  });

  // ---------- Solo-mode token (docs/solo-mode-spec.md §5.3) ----------

  test('GLM_SOLO_TOKEN match short-circuits to the solo user', async () => {
    const prev = process.env.GLM_SOLO_TOKEN;
    process.env.GLM_SOLO_TOKEN = 'solo-test-token-abc';
    try {
      s = makeTestServer();
      // The solo user is created on first authenticated request — not before.
      expect(s.deps.repos.users.findById('solo')).toBeNull();

      const res = await s.app.request('/api/v1/workspaces/ws-1/nodes', {
        headers: { authorization: 'Bearer solo-test-token-abc' },
      });
      expect(res.status).toBe(200);

      // Solo user now exists in the DB with admin role.
      const solo = s.deps.repos.users.findById('solo');
      expect(solo).not.toBeNull();
      expect(solo?.email).toBe('solo@glm.local');
      expect(solo?.role).toBe('admin');
    } finally {
      if (prev === undefined) delete process.env.GLM_SOLO_TOKEN;
      else process.env.GLM_SOLO_TOKEN = prev;
    }
  });

  test('GLM_SOLO_TOKEN is idempotent — second request reuses the user row', async () => {
    const prev = process.env.GLM_SOLO_TOKEN;
    process.env.GLM_SOLO_TOKEN = 'solo-test-token-xyz';
    try {
      s = makeTestServer();
      await s.app.request('/api/v1/workspaces/ws-1/nodes', {
        headers: { authorization: 'Bearer solo-test-token-xyz' },
      });
      const r2 = await s.app.request('/api/v1/workspaces/ws-1/nodes', {
        headers: { authorization: 'Bearer solo-test-token-xyz' },
      });
      expect(r2.status).toBe(200);
      // No duplicate rows — find by email also resolves.
      expect(s.deps.repos.users.findByEmail('solo@glm.local')?.id).toBe('solo');
    } finally {
      if (prev === undefined) delete process.env.GLM_SOLO_TOKEN;
      else process.env.GLM_SOLO_TOKEN = prev;
    }
  });

  test('a non-matching bearer falls through to the API-token path', async () => {
    const prev = process.env.GLM_SOLO_TOKEN;
    process.env.GLM_SOLO_TOKEN = 'solo-real';
    try {
      s = makeTestServer();
      const res = await s.app.request('/api/v1/workspaces/ws-1/nodes', {
        headers: { authorization: 'Bearer not-the-solo-token' },
      });
      // No matching API token → 401, NOT 200 via the solo path.
      expect(res.status).toBe(401);
      expect(s.deps.repos.users.findById('solo')).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.GLM_SOLO_TOKEN;
      else process.env.GLM_SOLO_TOKEN = prev;
    }
  });

  test('when GLM_SOLO_TOKEN is unset, no solo bypass even with a bearer', async () => {
    const prev = process.env.GLM_SOLO_TOKEN;
    delete process.env.GLM_SOLO_TOKEN;
    try {
      s = makeTestServer();
      const res = await s.app.request('/api/v1/workspaces/ws-1/nodes', {
        headers: { authorization: 'Bearer anything' },
      });
      expect(res.status).toBe(401);
    } finally {
      if (prev !== undefined) process.env.GLM_SOLO_TOKEN = prev;
    }
  });
});
