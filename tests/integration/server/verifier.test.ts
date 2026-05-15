import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { contentHash } from '../../../src/domain/content-hash.ts';
import { makeTestServer, type TestServer } from './helpers.ts';

/**
 * Verifier route coverage (done-when: gate violations land in
 * `verification_runs` and surface in the UI via the summary endpoint).
 */
describe('verifier routes', () => {
  let s: TestServer;
  beforeEach(() => {
    s = makeTestServer();
  });
  afterEach(() => s.db.close());

  function seedCleanSekkei() {
    s.deps.repos.nodes.insert({
      id: 'sys-root',
      workspaceId: 'ws-1',
      glmId: 'glm:system.web',
      stratum: 'system',
      title: 'Web System',
      body: { system_role: 'root', acceptance_gate: 'A.0' },
      systemRole: 'root',
      revisionMajor: 'A',
      revisionIteration: 0,
      revisionStatus: 'in_work',
      overrideKind: 'net_new',
      authoredBy: 'alice@example.com',
    });
    s.deps.repos.nodes.insert({
      id: 'cap-checkout',
      workspaceId: 'ws-1',
      glmId: 'glm:capability.checkout',
      stratum: 'capability',
      title: 'Checkout',
      body: { user_value: 'pay' },
      revisionMajor: 'A',
      revisionIteration: 0,
      revisionStatus: 'in_work',
      overrideKind: 'net_new',
      authoredBy: 'alice@example.com',
    });
  }

  test('POST /verify on a clean sekkei returns overallPass=true', async () => {
    seedCleanSekkei();
    const res = await s.request('POST', '/api/v1/workspaces/ws-1/verify');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: { overallPass: boolean; gateResults: { gates: Array<{ name: string }> } } };
    expect(body.run.overallPass).toBe(true);
    expect(body.run.gateResults.gates.length).toBe(8); // gates 1, 2, 2b, 3, 4, 5, 6, 7
  });

  test('POST /verify on a sekkei with a dangling reference fails gate 3', async () => {
    seedCleanSekkei();
    s.deps.repos.nodes.insert({
      id: 'comp-x',
      workspaceId: 'ws-1',
      glmId: 'glm:component.x',
      stratum: 'component',
      title: 'X',
      body: { boundary: 'browser DOM', runtime: 'es2022' },
      revisionMajor: 'A',
      revisionIteration: 0,
      revisionStatus: 'in_work',
      overrideKind: 'net_new',
      authoredBy: 'alice@example.com',
      relationships: [
        { ord: 0, kind: 'depends-on', targetGlmId: 'glm:component.missing', attributes: null },
      ],
    });
    const res = await s.request('POST', '/api/v1/workspaces/ws-1/verify');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: { overallPass: boolean; gateResults: { gates: Array<{ name: string; passed: boolean }> } };
    };
    expect(body.run.overallPass).toBe(false);
    const gate3 = body.run.gateResults.gates.find((g) => g.name === '3.closure_completeness');
    expect(gate3?.passed).toBe(false);
  });

  test('verifier persists a row and emits a workspace event', async () => {
    seedCleanSekkei();
    const events: Array<{ type: string }> = [];
    s.deps.events.subscribe('ws-1', (e) => events.push(e));
    await s.request('POST', '/api/v1/workspaces/ws-1/verify');
    const runs = s.deps.repos.verificationRuns.listLatest('ws-1', 5);
    expect(runs.length).toBe(1);
    expect(runs[0]?.overallPass).toBe(true);
    expect(events.some((e) => e.type === 'generation.complete')).toBe(true);

    // Also recorded in audit_events.
    const audits = s.deps.repos.audit.listByType('ws-1', 'verifier.run');
    expect(audits.length).toBe(1);
  });

  test('GET /verifier/runs/latest returns the most recent run', async () => {
    seedCleanSekkei();
    await s.request('POST', '/api/v1/workspaces/ws-1/verify');
    const res = await s.request('GET', '/api/v1/workspaces/ws-1/verifier/runs/latest');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: { overallPass: boolean } | null };
    expect(body.run?.overallPass).toBe(true);
  });

  test('workspace summary surfaces the latest verifier run for the Dashboard', async () => {
    seedCleanSekkei();
    await s.request('POST', '/api/v1/workspaces/ws-1/verify');
    const res = await s.request('GET', '/api/v1/workspaces/ws-1/summary');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verifier: { overallPass: boolean } | null };
    expect(body.verifier?.overallPass).toBe(true);
  });

  test('POST /verify accepts an optional brief and fails when expected nodes are missing', async () => {
    seedCleanSekkei();
    const res = await s.request('POST', '/api/v1/workspaces/ws-1/verify', {
      body: {
        brief: [{ glmId: 'glm:capability.payment', stratum: 'capability', label: 'Payment cap' }],
      },
    });
    const body = (await res.json()) as {
      run: { overallPass: boolean; gateResults: { gates: Array<{ name: string; passed: boolean }> } };
    };
    const gate4 = body.run.gateResults.gates.find((g) => g.name === '4.brief_coverage');
    expect(gate4?.passed).toBe(false);
  });

  test('GET /verifier/runs/:run_id 404s an unknown run', async () => {
    const res = await s.request('GET', '/api/v1/workspaces/ws-1/verifier/runs/unknown');
    expect(res.status).toBe(404);
  });

  // Sanity: contentHash import is exercised so the test file is type-checked
  // by the suite at the same time it certifies behavior.
  test('contentHash helper still produces sha256: prefix', () => {
    expect(contentHash({}).startsWith('sha256:')).toBe(true);
  });
});
