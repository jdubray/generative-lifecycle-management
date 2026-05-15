import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { makeTestServer, type TestServer } from './helpers.ts';

describe('workspace endpoints', () => {
  let s: TestServer;
  beforeEach(() => {
    s = makeTestServer();
  });
  afterEach(() => s.db.close());

  test('GET /workspaces lists every workspace', async () => {
    const res = await s.request('GET', '/api/v1/workspaces');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ id: string; slug: string }> };
    expect(body.workspaces.some((w) => w.slug === 'demo')).toBe(true);
  });

  test('GET /workspaces/:id returns a single workspace', async () => {
    const res = await s.request('GET', '/api/v1/workspaces/ws-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace: { slug: string } };
    expect(body.workspace.slug).toBe('demo');
  });

  test('GET /workspaces/:id/summary aggregates nodes / scrs / drift / generation', async () => {
    // Seed something countable.
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
    await s.request('POST', '/api/v1/workspaces/ws-1/scrs', {
      body: {
        id: 'SCR-1',
        title: 't',
        scrClass: 'II',
        problem: 'p',
        diffYaml: [],
        targetNodes: [],
      },
    });

    const res = await s.request('GET', '/api/v1/workspaces/ws-1/summary');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: { total: number; byStratum: Record<string, number> };
      scrs: { active: number; byStatus: Record<string, number> };
      drift: { drifted: number };
      generation: { cacheHits: number; cacheMisses: number };
      activity: unknown[];
    };
    expect(body.nodes.total).toBe(1);
    expect(body.nodes.byStratum.component).toBe(1);
    expect(body.scrs.byStatus.Draft).toBe(1);
    expect(body.drift.drifted).toBe(0);
    expect(Array.isArray(body.activity)).toBe(true);
  });

  test('GET /workspaces/:id/summary 404s for unknown workspace', async () => {
    const res = await s.request('GET', '/api/v1/workspaces/ws-nope/summary');
    expect(res.status).toBe(404);
  });

  // Regression: slug-based lookup must propagate ws.id to all repo queries.
  // Before the fix, routes called resolveWorkspace() to resolve the slug but
  // then used the raw URL param (slug) for every subsequent repo call,
  // causing all counts to return 0 for slug-addressed workspaces.
  test('GET /workspaces/:slug/summary returns correct counts when addressed by slug', async () => {
    await s.request('POST', '/api/v1/workspaces/ws-1/nodes', {
      body: {
        glmId: 'glm:component.slug-test',
        stratum: 'component',
        title: 'SlugTest',
        body: { boundary: 'b', runtime: 'r' },
        revisionMajor: 'A',
        revisionIteration: 0,
        revisionStatus: 'in_work',
        overrideKind: 'net_new',
      },
    });

    // Address by slug ('demo') instead of UUID ('ws-1').
    const res = await s.request('GET', '/api/v1/workspaces/demo/summary');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: { total: number; byStratum: Record<string, number> };
    };
    // Must be > 0 — previously returned 0 because slug was used as workspace_id
    // in the listByWorkspaceStratum query, which matched no rows.
    expect(body.nodes.total).toBeGreaterThan(0);
    expect(body.nodes.byStratum.component).toBeGreaterThan(0);
  });
});
