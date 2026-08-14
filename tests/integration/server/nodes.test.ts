import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type TestServer, makeTestServer } from './helpers.ts';

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

  test('POST persists relationships (composes-of edges) so node-by-node authoring works', async () => {
    const res = await s.request('POST', '/api/v1/workspaces/ws-1/nodes', {
      body: {
        glmId: 'glm:capability.shop',
        stratum: 'capability',
        title: 'Shop',
        body: { user_value: 'browse + buy' },
        revisionMajor: 'A',
        revisionIteration: 0,
        revisionStatus: 'in_work',
        overrideKind: 'net_new',
        relationships: [
          {
            ord: 0,
            kind: 'composes-of',
            targetGlmId: 'glm:component.cart',
            attributes: { find_number: '1.0' },
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    const got = await s.request('GET', '/api/v1/workspaces/ws-1/nodes/glm:capability.shop');
    const payload = (await got.json()) as {
      relationships: Array<{ kind: string; targetGlmId: string }>;
    };
    expect(payload.relationships).toHaveLength(1);
    expect(payload.relationships[0]).toMatchObject({
      kind: 'composes-of',
      targetGlmId: 'glm:component.cart',
    });
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

  // A body-only edit (what `glm_apply_patch`, `glm refine`, and the Sekkei
  // editor all send) must not silently destroy the node's graph wiring.
  // `NodeRepository.update()` clears parameters / constraints / relationships
  // before rewriting them from its input, so the route has to hand them back.
  describe('PUT preserves supporting rows the request does not mention', () => {
    const AUTHORED = {
      glmId: 'glm:capability.shop',
      stratum: 'capability',
      title: 'Shop',
      body: { user_value: 'browse + buy' },
      revisionMajor: 'A',
      revisionIteration: 0,
      revisionStatus: 'in_work',
      overrideKind: 'net_new',
      relationships: [
        {
          ord: 0,
          kind: 'composes-of',
          targetGlmId: 'glm:component.cart',
          attributes: { find_number: '1.0' },
        },
        { ord: 1, kind: 'depends-on', targetGlmId: 'pkg:npm/zod@3' },
      ],
      parameters: [
        {
          name: 'currency',
          type: 'string',
          options: null,
          minValue: null,
          maxValue: null,
          defaultValue: 'USD',
          bindingScope: 'workspace',
          ord: 0,
        },
      ],
      constraints: [
        { ord: 0, kind: 'invariant', expression: 'cart.total >= 0', severity: 'error' },
      ],
    };

    interface Fetched {
      relationships: Array<{ kind: string; targetGlmId: string }>;
      parameters: Array<{ name: string }>;
      constraints: Array<{ expression: string }>;
    }

    const fetchNode = async (): Promise<Fetched> => {
      const got = await s.request('GET', '/api/v1/workspaces/ws-1/nodes/glm:capability.shop');
      return (await got.json()) as Fetched;
    };

    beforeEach(async () => {
      await s.request('POST', '/api/v1/workspaces/ws-1/nodes', { body: AUTHORED });
    });

    test('a body-only PUT keeps relationships, parameters and constraints', async () => {
      const res = await s.request('PUT', '/api/v1/workspaces/ws-1/nodes/glm:capability.shop', {
        body: { body: { user_value: 'browse, buy, and return' } },
      });
      expect(res.status).toBe(200);

      const payload = await fetchNode();
      expect(payload.relationships).toHaveLength(2);
      expect(payload.relationships[0]).toMatchObject({
        kind: 'composes-of',
        targetGlmId: 'glm:component.cart',
      });
      expect(payload.parameters).toHaveLength(1);
      expect(payload.parameters[0]?.name).toBe('currency');
      expect(payload.constraints).toHaveLength(1);
      expect(payload.constraints[0]?.expression).toBe('cart.total >= 0');
    });

    test('a PUT that supplies relationships replaces them wholesale', async () => {
      const res = await s.request('PUT', '/api/v1/workspaces/ws-1/nodes/glm:capability.shop', {
        body: {
          body: { user_value: 'browse + buy' },
          relationships: [{ ord: 0, kind: 'composes-of', targetGlmId: 'glm:component.checkout' }],
        },
      });
      expect(res.status).toBe(200);

      const payload = await fetchNode();
      expect(payload.relationships).toHaveLength(1);
      expect(payload.relationships[0]?.targetGlmId).toBe('glm:component.checkout');
      // Untouched collections still survive.
      expect(payload.parameters).toHaveLength(1);
    });

    test('an explicit empty relationships array clears them', async () => {
      const res = await s.request('PUT', '/api/v1/workspaces/ws-1/nodes/glm:capability.shop', {
        body: { body: { user_value: 'browse + buy' }, relationships: [] },
      });
      expect(res.status).toBe(200);
      expect((await fetchNode()).relationships).toHaveLength(0);
    });

    test('the soft-delete DELETE keeps the node wired up', async () => {
      const res = await s.request('DELETE', '/api/v1/workspaces/ws-1/nodes/glm:capability.shop');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { node: { revisionStatus: string } };
      expect(body.node.revisionStatus).toBe('obsolete');

      const payload = await fetchNode();
      expect(payload.relationships).toHaveLength(2);
      expect(payload.parameters).toHaveLength(1);
      expect(payload.constraints).toHaveLength(1);
    });
  });

  // Soft-delete leaves the row in place, so it still owns its (workspace, glm_id)
  // and (workspace, content_hash) uniqueness — an author who mis-created a node
  // cannot re-create it correctly. `?hard=true` is the escape hatch.
  describe('DELETE ?hard=true', () => {
    const mkNode = (glmId: string, relationships: unknown[] = []) => ({
      glmId,
      stratum: 'component',
      title: glmId,
      body: { boundary: glmId, runtime: 'es2022' },
      revisionMajor: 'A',
      revisionIteration: 0,
      revisionStatus: 'in_work',
      overrideKind: 'net_new',
      relationships,
    });

    test('removes the node so the glm_id can be re-used', async () => {
      await s.request('POST', '/api/v1/workspaces/ws-1/nodes', { body: mkNode('glm:component.oops') });

      const res = await s.request(
        'DELETE',
        '/api/v1/workspaces/ws-1/nodes/glm:component.oops?hard=true',
      );
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { deleted: string; hard: boolean };
      expect(payload).toMatchObject({ deleted: 'glm:component.oops', hard: true });

      expect((await s.request('GET', '/api/v1/workspaces/ws-1/nodes/glm:component.oops')).status).toBe(404);

      // The whole point: re-authoring the same id now succeeds.
      const recreated = await s.request('POST', '/api/v1/workspaces/ws-1/nodes', {
        body: mkNode('glm:component.oops'),
      });
      expect(recreated.status).toBe(201);
    });

    test('sweeps inbound edges so no parent is left pointing at a ghost', async () => {
      await s.request('POST', '/api/v1/workspaces/ws-1/nodes', { body: mkNode('glm:component.child') });
      await s.request('POST', '/api/v1/workspaces/ws-1/nodes', {
        body: {
          ...mkNode('glm:capability.parent'),
          stratum: 'capability',
          body: { user_value: 'v' },
          relationships: [
            { ord: 0, kind: 'composes-of', targetGlmId: 'glm:component.child' },
            { ord: 1, kind: 'composes-of', targetGlmId: 'glm:component.keeper' },
          ],
        },
      });

      await s.request('DELETE', '/api/v1/workspaces/ws-1/nodes/glm:component.child?hard=true');

      const parent = (await (
        await s.request('GET', '/api/v1/workspaces/ws-1/nodes/glm:capability.parent')
      ).json()) as { relationships: Array<{ targetGlmId: string }> };
      expect(parent.relationships).toHaveLength(1);
      expect(parent.relationships[0]?.targetGlmId).toBe('glm:component.keeper');
    });

    test('without the flag it still soft-deletes', async () => {
      await s.request('POST', '/api/v1/workspaces/ws-1/nodes', { body: mkNode('glm:component.soft') });
      const res = await s.request('DELETE', '/api/v1/workspaces/ws-1/nodes/glm:component.soft');
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { node: { revisionStatus: string } };
      expect(payload.node.revisionStatus).toBe('obsolete');
      expect((await s.request('GET', '/api/v1/workspaces/ws-1/nodes/glm:component.soft')).status).toBe(200);
    });

    test('hard delete of a nonexistent node is a 404', async () => {
      const res = await s.request('DELETE', '/api/v1/workspaces/ws-1/nodes/glm:nope?hard=true');
      expect(res.status).toBe(404);
    });
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
    const res = await s.request(
      'GET',
      '/api/v1/workspaces/ws-1/nodes/glm:component.shared/where-used',
    );
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

    const acquireRes = await s.request(
      'POST',
      '/api/v1/workspaces/ws-1/nodes/glm:component.lockme/lock',
    );
    expect(acquireRes.status).toBe(200);

    const hbRes = await s.request(
      'PUT',
      '/api/v1/workspaces/ws-1/nodes/glm:component.lockme/lock/heartbeat',
    );
    expect(hbRes.status).toBe(200);

    const releaseRes = await s.request(
      'DELETE',
      '/api/v1/workspaces/ws-1/nodes/glm:component.lockme/lock',
    );
    expect(releaseRes.status).toBe(200);
  });

  test('two users contending for the same lock: second gets 423', async () => {
    s.db
      .prepare(
        'INSERT INTO users (id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('user-2', 'bob@example.com', 'Bob', 'editor', new Date().toISOString());

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
