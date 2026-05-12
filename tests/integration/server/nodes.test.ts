import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { makeTestServer, type TestServer } from './helpers.ts';

describe('node REST routes', () => {
  let s: TestServer;
  beforeEach(() => {
    s = makeTestServer();
  });
  afterEach(() => s.db.close());

  test('POST creates a node and returns 201 with the node body', async () => {
    const res = await s.request('POST', '/api/v1/workspaces/ws-1/nodes', {
      body: {
        glmId: 'glm:component.web',
        stratum: 'component',
        title: 'Web Component',
        body: { boundary: 'browser DOM', runtime: 'es2022' },
        revisionMajor: 'A',
        revisionIteration: 0,
        revisionStatus: 'in_work',
        overrideKind: 'net_new',
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { node: { glmId: string; contentHash: string } };
    expect(body.node.glmId).toBe('glm:component.web');
    expect(body.node.contentHash.startsWith('sha256:')).toBe(true);
  });

  test('POST + GET round-trips the node', async () => {
    await s.request('POST', '/api/v1/workspaces/ws-1/nodes', {
      body: {
        glmId: 'glm:capability.checkout',
        stratum: 'capability',
        title: 'Checkout',
        body: { user_value: 'pay' },
        revisionMajor: 'A',
        revisionIteration: 0,
        revisionStatus: 'in_work',
        overrideKind: 'net_new',
      },
    });
    const res = await s.request('GET', '/api/v1/workspaces/ws-1/nodes/glm:capability.checkout');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { node: { title: string }; parameters: unknown[] };
    expect(body.node.title).toBe('Checkout');
    expect(body.parameters).toEqual([]);
  });

  test('GET list filters by stratum', async () => {
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
    await s.request('POST', '/api/v1/workspaces/ws-1/nodes', {
      body: {
        glmId: 'glm:capability.y',
        stratum: 'capability',
        title: 'Y',
        body: { user_value: 'foo' },
        revisionMajor: 'A',
        revisionIteration: 0,
        revisionStatus: 'in_work',
        overrideKind: 'net_new',
      },
    });
    const components = await s
      .request('GET', '/api/v1/workspaces/ws-1/nodes?stratum=component')
      .then((r) => r.json() as Promise<{ nodes: Array<{ glmId: string }> }>);
    expect(components.nodes.length).toBe(1);
    expect(components.nodes[0]?.glmId).toBe('glm:component.x');
  });

  test('POST with bad stratum body returns 422', async () => {
    const res = await s.request('POST', '/api/v1/workspaces/ws-1/nodes', {
      body: {
        glmId: 'glm:component.bad',
        stratum: 'component',
        title: 'bad',
        body: { boundary: 'b' }, // missing runtime
        revisionMajor: 'A',
        revisionIteration: 0,
        revisionStatus: 'in_work',
        overrideKind: 'net_new',
      },
    });
    expect(res.status).toBe(422);
  });

  test('GET on a nonexistent node returns 404', async () => {
    const res = await s.request('GET', '/api/v1/workspaces/ws-1/nodes/glm:nope');
    expect(res.status).toBe(404);
  });

  test('GET on a nonexistent workspace returns 404', async () => {
    const res = await s.request('GET', '/api/v1/workspaces/ws-nope/nodes');
    expect(res.status).toBe(404);
  });

  test('GET where-used returns direct + transitive', async () => {
    // target
    await s.request('POST', '/api/v1/workspaces/ws-1/nodes', {
      body: {
        glmId: 'glm:component.shared',
        stratum: 'component',
        title: 'Shared',
        body: { boundary: 'b', runtime: 'r' },
        revisionMajor: 'A',
        revisionIteration: 0,
        revisionStatus: 'in_work',
        overrideKind: 'net_new',
      },
    });
    // direct consumer (would need relationships; for this smoke test we just
    // verify the endpoint shape since the repository didn't take rels in the
    // POST body in v1 — keep this loose).
    const res = await s.request('GET', '/api/v1/workspaces/ws-1/nodes/glm:component.shared/where-used');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { target: string; direct: unknown[]; transitive: unknown[] };
    expect(body.target).toBe('glm:component.shared');
    expect(Array.isArray(body.direct)).toBe(true);
  });

  test('lock acquire / heartbeat / release flow', async () => {
    await s.request('POST', '/api/v1/workspaces/ws-1/nodes', {
      body: {
        glmId: 'glm:component.lockme',
        stratum: 'component',
        title: 'Lock me',
        body: { boundary: 'b', runtime: 'r' },
        revisionMajor: 'A',
        revisionIteration: 0,
        revisionStatus: 'in_work',
        overrideKind: 'net_new',
      },
    });

    const acquireRes = await s.request('POST', '/api/v1/workspaces/ws-1/nodes/glm:component.lockme/lock');
    expect(acquireRes.status).toBe(200);

    const hbRes = await s.request('PUT', '/api/v1/workspaces/ws-1/nodes/glm:component.lockme/lock/heartbeat');
    expect(hbRes.status).toBe(200);

    const releaseRes = await s.request('DELETE', '/api/v1/workspaces/ws-1/nodes/glm:component.lockme/lock');
    expect(releaseRes.status).toBe(200);
  });

  test('two users contending for the same lock: second gets 423', async () => {
    s.db.prepare('INSERT INTO users (id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'user-2',
      'bob@example.com',
      'Bob',
      'editor',
      new Date().toISOString(),
    );

    await s.request('POST', '/api/v1/workspaces/ws-1/nodes', {
      body: {
        glmId: 'glm:component.contended',
        stratum: 'component',
        title: 'c',
        body: { boundary: 'b', runtime: 'r' },
        revisionMajor: 'A',
        revisionIteration: 0,
        revisionStatus: 'in_work',
        overrideKind: 'net_new',
      },
    });
    await s.request('POST', '/api/v1/workspaces/ws-1/nodes/glm:component.contended/lock', {
      userId: 'user-1',
    });
    const bobAttempt = await s.request(
      'POST',
      '/api/v1/workspaces/ws-1/nodes/glm:component.contended/lock',
      { userId: 'user-2' },
    );
    expect(bobAttempt.status).toBe(423);
    const body = (await bobAttempt.json()) as { error: { heldBy: string } };
    expect(body.error.heldBy).toBe('user-1');
  });
});
