/**
 * PATCH /workspaces/:id — partial-update endpoint. v1 only handles
 * `sourceDir` (used by the CLI's client-side generate flow to persist
 * --source-dir before calling the spec / verifier / record-generation
 * endpoints).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { makeTestServer, type TestServer } from './helpers.ts';

describe('PATCH /workspaces/:id', () => {
  let s: TestServer;
  afterEach(() => s?.db.close());

  test('persists sourceDir and returns the updated workspace', async () => {
    s = makeTestServer();
    const res = await s.request('PATCH', '/api/v1/workspaces/ws-1', {
      body: { sourceDir: '/work/petshop' },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { workspace: { id: string; sourceDir: string | null } };
    expect(json.workspace.id).toBe('ws-1');
    expect(json.workspace.sourceDir).toBe('/work/petshop');
    // And the change is visible on subsequent GETs:
    const ws = s.deps.repos.workspaces.findById('ws-1');
    expect(ws?.sourceDir).toBe('/work/petshop');
  });

  test('rejects a relative sourceDir', async () => {
    s = makeTestServer();
    const res = await s.request('PATCH', '/api/v1/workspaces/ws-1', {
      body: { sourceDir: 'relative/path' },
    });
    expect(res.status).toBe(400);
  });

  test('rejects a non-string sourceDir', async () => {
    s = makeTestServer();
    const res = await s.request('PATCH', '/api/v1/workspaces/ws-1', {
      body: { sourceDir: 42 },
    });
    expect(res.status).toBe(400);
  });

  test('returns 404 for an unknown workspace', async () => {
    s = makeTestServer();
    const res = await s.request('PATCH', '/api/v1/workspaces/unknown', {
      body: { sourceDir: '/x' },
    });
    expect(res.status).toBe(404);
  });

  test('returns 401 without auth', async () => {
    s = makeTestServer();
    const res = await s.app.request('/api/v1/workspaces/ws-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceDir: '/x' }),
    });
    expect(res.status).toBe(401);
  });
});
