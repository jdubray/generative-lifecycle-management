import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { makeTestServer, type TestServer } from './helpers.ts';

/**
 * Drift write-surface coverage (AC-23, AC-24, AC-26).
 */
describe('drift actions', () => {
  let s: TestServer;
  beforeEach(() => {
    s = makeTestServer();
    s.db.prepare(
      'INSERT INTO nodes (id, workspace_id, glm_id, stratum, title, description, body_json, content_hash, revision_major, revision_iteration, revision_status, override_kind, derives_from_node_id, system_role, spec_kind, authored_by, authored_at, updated_at, generator_identity_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'node-1',
      'ws-1',
      'glm:component.web',
      'component',
      'Web',
      '',
      JSON.stringify({ boundary: 'browser DOM', runtime: 'es2022' }),
      'sha256:dummy',
      'A',
      0,
      'in_work',
      'net_new',
      null,
      null,
      null,
      'alice@example.com',
      '2026-05-11T00:00:00.000Z',
      '2026-05-11T00:00:00.000Z',
      null,
    );
    // seed two drift records
    s.deps.repos.drift.upsert({
      id: 'd-1',
      workspaceId: 'ws-1',
      nodeId: 'node-1',
      file: 'src/a.ts',
      status: 'Live-Drifted',
      kind: 'live_state',
      desiredHash: 'sha256:aaa',
      observedHash: 'sha256:bbb',
      policy: 'auto-heal',
    });
    s.deps.repos.drift.upsert({
      id: 'd-2',
      workspaceId: 'ws-1',
      nodeId: 'node-1',
      file: 'src/b.ts',
      status: 'Live-Drifted',
      kind: 'live_state',
      desiredHash: 'sha256:ccc',
      observedHash: 'sha256:ddd',
      policy: 'alert',
    });
  });
  afterEach(() => s.db.close());

  test('AC-23: POST /drift/sweep is callable and audited', async () => {
    const res = await s.request('POST', '/api/v1/workspaces/ws-1/drift/sweep');
    expect(res.status).toBe(200);
    const audits = s.deps.repos.audit.listByType('ws-1', 'drift.sweep');
    expect(audits.length).toBe(1);
  });

  test('AC-24: POST /drift/auto-heal only reconciles records with policy=auto-heal', async () => {
    const res = await s.request('POST', '/api/v1/workspaces/ws-1/drift/auto-heal');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: number; healed: number };
    expect(body.candidates).toBe(1);
    expect(body.healed).toBe(1);
    // d-1 is now Synced; d-2 (policy=alert) is still Live-Drifted.
    expect(s.deps.repos.drift.findById('d-1')?.status).toBe('Synced');
    expect(s.deps.repos.drift.findById('d-2')?.status).toBe('Live-Drifted');
  });

  test('AC-26: waiver without durationDays is rejected', async () => {
    const res = await s.request('PUT', '/api/v1/workspaces/ws-1/drift/d-1/resolve', {
      body: { action: 'waiver' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { ac: string } };
    expect(body.error.ac).toBe('AC-26');
  });

  test('AC-26: waiver with positive durationDays is accepted and emits a drift.waiver audit', async () => {
    const res = await s.request('PUT', '/api/v1/workspaces/ws-1/drift/d-1/resolve', {
      body: { action: 'waiver', durationDays: 14 },
    });
    expect(res.status).toBe(200);
    const audits = s.deps.repos.audit.listByType('ws-1', 'drift.waiver');
    expect(audits.length).toBe(1);
    expect((audits[0]?.payload as { durationDays: number }).durationDays).toBe(14);
    expect(s.deps.repos.drift.findById('d-1')?.status).toBe('Suspended');
  });
});
