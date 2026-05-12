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
});
