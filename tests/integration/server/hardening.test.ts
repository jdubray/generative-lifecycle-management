import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateSecret } from '../../../src/auth/session.ts';
import { runMigrations } from '../../../src/repository/db.ts';
import { createApp } from '../../../src/server/app.ts';
import { MIGRATIONS_DIR } from '../helpers.ts';
import { makeTestServer, type TestServer } from './helpers.ts';

describe('hardening: security headers', () => {
  let s: TestServer;
  beforeEach(() => {
    s = makeTestServer();
  });
  afterEach(() => s.db.close());

  test('CSP + nosniff + DENY framing are set on every response', async () => {
    const res = await s.request('GET', '/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('permissions-policy')).toContain('geolocation=()');
  });

  test('every response carries an X-Request-Id', async () => {
    const res = await s.request('GET', '/api/v1/health');
    const id = res.headers.get('x-request-id') ?? '';
    expect(id.length).toBeGreaterThan(0);
  });

  test('caller-supplied X-Request-Id is echoed verbatim', async () => {
    const res = await s.app.request('/api/v1/health', { headers: { 'x-request-id': 'corr-42' } });
    expect(res.headers.get('x-request-id')).toBe('corr-42');
  });

  test('error responses also carry the security headers', async () => {
    // Anonymous request to a workspace route → 401 from requireAuth().
    const res = await s.app.request('/api/v1/workspaces/ws-1/nodes');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('hardening: rate limit on /auth/*', () => {
  test('exceeding the auth bucket returns 429 with Retry-After', async () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db, MIGRATIONS_DIR);
    const { app } = createApp({
      db,
      sessionSecret: generateSecret(),
      cookieSecure: false,
      allowTestAuthHeader: false,
    });
    let last: Response | undefined;
    // The /auth bucket capacity is 12; burst past that.
    for (let i = 0; i < 14; i++) {
      last = await app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
        body: JSON.stringify({ email: `user${i}@example.com` }),
      });
    }
    expect(last?.status).toBe(429);
    expect(Number.parseInt(last?.headers.get('retry-after') ?? '0', 10)).toBeGreaterThanOrEqual(1);
    db.close();
  });
});

describe('hardening: audit coverage for state-changing endpoints', () => {
  let s: TestServer;
  beforeEach(() => {
    s = makeTestServer();
  });
  afterEach(() => s.db.close());

  test('node POST writes node.create', async () => {
    await s.request('POST', '/api/v1/workspaces/ws-1/nodes', {
      body: {
        glmId: 'glm:component.x',
        stratum: 'component',
        title: 'X',
        body: { boundary: 'b', runtime: 'r' },
        revisionMajor: 'A',
        revisionIteration: 0,
        revisionStatus: 'in_work',
        overrideKind: 'net_new',
      },
    });
    expect(s.deps.repos.audit.listByType('ws-1', 'node.create').length).toBe(1);
  });

  test('SCR submit writes scr.submit (AC-07 also covers this)', async () => {
    await s.request('POST', '/api/v1/workspaces/ws-1/scrs', {
      body: { id: 'SCR-1', title: 't', scrClass: 'II', problem: 'p', diffYaml: [], targetNodes: [] },
    });
    await s.request('PUT', '/api/v1/workspaces/ws-1/scrs/SCR-1/status', {
      body: { event: 'submit' },
    });
    expect(s.deps.repos.audit.listByType('ws-1', 'scr.submit').length).toBe(1);
  });

  test('drift waiver writes drift.waiver', async () => {
    s.deps.repos.nodes.insert({
      id: 'n-1',
      workspaceId: 'ws-1',
      glmId: 'glm:component.x',
      stratum: 'component',
      title: 'X',
      body: { boundary: 'b', runtime: 'r' },
      revisionMajor: 'A',
      revisionIteration: 0,
      revisionStatus: 'in_work',
      overrideKind: 'net_new',
      authoredBy: 'a@b',
    });
    s.deps.repos.drift.upsert({
      id: 'd-1',
      workspaceId: 'ws-1',
      nodeId: 'n-1',
      file: 's',
      status: 'Live-Drifted',
      kind: 'live_state',
      desiredHash: 'sha256:a',
      observedHash: 'sha256:b',
      policy: 'alert',
    });
    const res = await s.request('PUT', '/api/v1/workspaces/ws-1/drift/d-1/resolve', {
      body: { action: 'waiver', durationDays: 7 },
    });
    expect(res.status).toBe(200);
    expect(s.deps.repos.audit.listByType('ws-1', 'drift.waiver').length).toBe(1);
  });

});

describe('hardening: perf indexes', () => {
  test('the 0004 migration was applied and indexes exist', async () => {
    const s2 = makeTestServer();
    const idx = s2.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all() as Array<{ name: string }>;
    const names = new Set(idx.map((r) => r.name));
    expect(names.has('idx_scrs_workspace_proposed_at')).toBe(true);
    expect(names.has('idx_provenance_events_subject_ts')).toBe(true);
    expect(names.has('idx_edit_locks_user')).toBe(true);
    s2.db.close();
  });
});
