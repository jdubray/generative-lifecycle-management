import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { makeTestServer, type TestServer } from './helpers.ts';

/**
 * Reuse & Inheritance REST coverage (AC-28, AC-29 path, AC-30, AC-31 not
 * server-asserted — that one is about regeneration replay timestamps).
 */
describe('reuse routes', () => {
  let s: TestServer;
  beforeEach(() => {
    s = makeTestServer();
  });
  afterEach(() => s.db.close());

  test('GET /reuse returns the candidate list', async () => {
    s.deps.repos.reuse.insert({
      id: 'r-1',
      workspaceId: 'ws-1',
      subtree: 'glm:component.shared',
      title: 'Shared',
      stage: 'Variant-Local',
    });
    const res = await s.request('GET', '/api/v1/workspaces/ws-1/reuse');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: Array<{ id: string }> };
    expect(body.candidates.length).toBe(1);
    expect(body.candidates[0]?.id).toBe('r-1');
  });

  test('AC-28: find-candidates surfaces nodes with ≥ 2 direct dependents', async () => {
    // Create shared + two consumers via the REST API so relationships land.
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
    // Two consumers each composing-of shared. Insert relationships through the
    // node repository directly because the public POST does not yet accept
    // relationships in v1.
    for (const i of [1, 2]) {
      s.deps.repos.nodes.insert({
        id: `consumer-${i}`,
        workspaceId: 'ws-1',
        glmId: `glm:component.consumer${i}`,
        stratum: 'component',
        title: `Consumer ${i}`,
        body: { boundary: `consumer-${i}`, runtime: 'r' },
        revisionMajor: 'A',
        revisionIteration: 0,
        revisionStatus: 'in_work',
        overrideKind: 'net_new',
        authoredBy: 'alice@example.com',
        relationships: [
          {
            ord: 0,
            kind: 'composes-of',
            targetGlmId: 'glm:component.shared',
            attributes: null,
          },
        ],
      });
    }

    const res = await s.request('POST', '/api/v1/workspaces/ws-1/reuse/find-candidates');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: Array<{ subtree: string }> };
    expect(body.created.some((c) => c.subtree === 'glm:component.shared')).toBe(true);
  });

  test('AC-30: refusing to promote past Candidate-for-Promotion without a steward', async () => {
    const candidate = s.deps.repos.reuse.insert({
      id: 'r-no-steward',
      workspaceId: 'ws-1',
      subtree: 'glm:component.x',
      title: 'X',
      stage: 'Candidate-for-Promotion',
    });
    const res = await s.request('PUT', `/api/v1/workspaces/ws-1/reuse/${candidate.id}/stage`, {
      body: { stage: 'Promoted-to-Library' },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { ac: string } };
    expect(body.error.ac).toBe('AC-30');
  });

  test('AC-30: promoting succeeds once a steward is set', async () => {
    const candidate = s.deps.repos.reuse.insert({
      id: 'r-with-steward',
      workspaceId: 'ws-1',
      subtree: 'glm:component.y',
      title: 'Y',
      stage: 'Candidate-for-Promotion',
      steward: 'owner@example.com',
    });
    const res = await s.request('PUT', `/api/v1/workspaces/ws-1/reuse/${candidate.id}/stage`, {
      body: { stage: 'Promoted-to-Library' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidate: { stage: string } };
    expect(body.candidate.stage).toBe('Promoted-to-Library');
  });

  test('stewardship can be assigned via PUT /reuse/:id/steward', async () => {
    const candidate = s.deps.repos.reuse.insert({
      id: 'r-3',
      workspaceId: 'ws-1',
      subtree: 'glm:component.z',
      title: 'Z',
      stage: 'Candidate-for-Promotion',
    });
    const res = await s.request('PUT', `/api/v1/workspaces/ws-1/reuse/${candidate.id}/steward`, {
      body: { steward: 'newowner@example.com' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidate: { steward: string } };
    expect(body.candidate.steward).toBe('newowner@example.com');
  });
});
