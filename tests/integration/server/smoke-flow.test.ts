import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Scr } from '../../../src/types.ts';
import { makeTestServer, type TestServer } from './helpers.ts';

/**
 * Phase 3 done-when: a curl-driven smoke flow that creates a node, opens an
 * SCR, transitions it through Submitted → Under Review → Approved. AC-07
 * (scr.submit audit event) and AC-08 (approving an SCR persists the
 * approval row + flips status) are covered here.
 */
describe('end-to-end SCR smoke flow (AC-07, AC-08)', () => {
  let s: TestServer;
  beforeEach(() => {
    s = makeTestServer();
  });
  afterEach(() => s.db.close());

  test('create node → create SCR → submit → start review → approve', async () => {
    // 1. create a target node
    const nodeRes = await s.request('POST', '/api/v1/workspaces/ws-1/nodes', {
      body: {
        glmId: 'glm:capability.checkout',
        stratum: 'capability',
        title: 'Checkout',
        body: { user_value: 'allow customers to pay' },
        revisionMajor: 'A',
        revisionIteration: 0,
        revisionStatus: 'in_work',
        overrideKind: 'net_new',
      },
    });
    expect(nodeRes.status).toBe(201);

    // 2. create an SCR targeting that node
    const createRes = await s.request('POST', '/api/v1/workspaces/ws-1/scrs', {
      body: {
        id: 'SCR-2090',
        title: 'Allow guest checkout',
        scrClass: 'I',
        problem: 'Customers abandon at signup',
        diffYaml: [{ line: '+   guest: true', kind: 'add' }],
        targetNodes: ['glm:capability.checkout'],
      },
    });
    expect(createRes.status).toBe(201);

    // 3. submit (AC-07)
    const submitRes = await s.request('PUT', '/api/v1/workspaces/ws-1/scrs/SCR-2090/status', {
      body: { event: 'submit' },
    });
    expect(submitRes.status).toBe(200);

    const submitted = (await submitRes.json()) as { scr: Scr };
    expect(submitted.scr.status).toBe('Submitted');

    const submitAudits = s.deps.repos.audit.listByType('ws-1', 'scr.submit');
    expect(submitAudits.length).toBe(1);
    expect((submitAudits[0]?.payload as { scrId: string }).scrId).toBe('SCR-2090');

    // 4. start review
    const reviewRes = await s.request('PUT', '/api/v1/workspaces/ws-1/scrs/SCR-2090/status', {
      body: { event: 'startReview' },
    });
    expect(reviewRes.status).toBe(200);

    // 5. add an approval (AC-08): persists approval row + flips status to Approved
    const approveRes = await s.request(
      'POST',
      '/api/v1/workspaces/ws-1/scrs/SCR-2090/approvals',
      { body: { decision: 'approve' } },
    );
    expect(approveRes.status).toBe(201);
    const approved = (await approveRes.json()) as { scr: Scr };
    expect(approved.scr.status).toBe('Approved');

    const approvals = s.deps.repos.scrs.listApprovals('SCR-2090');
    expect(approvals.length).toBe(1);
    expect(approvals[0]?.decision).toBe('approve');

    // Final fetch confirms status persisted
    const finalRes = await s.request('GET', '/api/v1/workspaces/ws-1/scrs/SCR-2090');
    const final = (await finalRes.json()) as { scr: Scr; approvals: Array<{ decision: string }> };
    expect(final.scr.status).toBe('Approved');
    expect(final.approvals.length).toBe(1);
  });

  test('illegal SCR transition returns 409', async () => {
    await s.request('POST', '/api/v1/workspaces/ws-1/scrs', {
      body: { id: 'SCR-1', title: 't', scrClass: 'II', problem: 'p', diffYaml: [], targetNodes: [] },
    });
    // Cannot approve from Draft
    const res = await s.request('PUT', '/api/v1/workspaces/ws-1/scrs/SCR-1/status', {
      body: { event: 'approve' },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; from: string } };
    expect(body.error.code).toBe('invalid_scr_transition');
    expect(body.error.from).toBe('Draft');
  });

  test('return event requires a reason', async () => {
    await s.request('POST', '/api/v1/workspaces/ws-1/scrs', {
      body: { id: 'SCR-2', title: 't', scrClass: 'II', problem: 'p', diffYaml: [], targetNodes: [] },
    });
    await s.request('PUT', '/api/v1/workspaces/ws-1/scrs/SCR-2/status', { body: { event: 'submit' } });
    await s.request('PUT', '/api/v1/workspaces/ws-1/scrs/SCR-2/status', { body: { event: 'startReview' } });
    const res = await s.request('PUT', '/api/v1/workspaces/ws-1/scrs/SCR-2/status', {
      body: { event: 'return' },
    });
    expect(res.status).toBe(400);
  });
});
