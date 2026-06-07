import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { makeTestServer, type TestServer } from './helpers.ts';

/**
 * Regression: workspace `:id` path params must resolve **either** a UUID or a
 * slug on every route module, not just the ones in `workspaces.ts`.
 *
 * Before the shared `requireWorkspace` helper (src/server/routes/_workspace.ts),
 * each route module had its own helper that called `workspaces.findById` only.
 * That made a slug 404 everywhere except the `workspaces.ts` routes — which
 * broke 7 of 8 MCP tools and the CLI whenever a slug was passed (e.g.
 * `/glm-verify glm-self`). The seeded workspace here is id `ws-1`, slug `demo`.
 */
describe('workspace slug resolution across route modules', () => {
  let s: TestServer;
  beforeEach(() => {
    s = makeTestServer(); // seeds workspace id=ws-1, slug=demo
  });
  afterEach(() => s.db.close());

  // Routes that previously only accepted the UUID. Each must now resolve the
  // slug identically. We assert "not 404" (the old failure mode) — a 200 read
  // or a 200/2xx action means the slug was resolved to the workspace.
  const slugReadRoutes: Array<[string, string]> = [
    ['GET', '/api/v1/workspaces/demo/nodes'],
    ['GET', '/api/v1/workspaces/demo/scrs'],
    ['GET', '/api/v1/workspaces/demo/drift'],
    ['GET', '/api/v1/workspaces/demo/provenance'],
    ['GET', '/api/v1/workspaces/demo/variants'],
    ['GET', '/api/v1/workspaces/demo/verifier/runs'],
  ];

  for (const [method, path] of slugReadRoutes) {
    test(`${method} ${path} resolves the slug (not 404)`, async () => {
      const res = await s.request(method, path);
      expect(res.status).toBe(200);
    });
  }

  test('POST /verify resolves the slug and runs the verifier', async () => {
    const res = await s.request('POST', '/api/v1/workspaces/demo/verify');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: { workspaceId: string } };
    // Crucially the run is keyed by the canonical UUID, not the slug.
    expect(body.run.workspaceId).toBe('ws-1');
  });

  test('the canonical UUID still works on the same routes', async () => {
    const res = await s.request('GET', '/api/v1/workspaces/ws-1/nodes');
    expect(res.status).toBe(200);
  });

  test('an unknown slug still 404s', async () => {
    const res = await s.request('GET', '/api/v1/workspaces/does-not-exist/nodes');
    expect(res.status).toBe(404);
  });
});
