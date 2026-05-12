import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { makeTestServer, type TestServer } from './helpers.ts';

/**
 * Effectivity & Rollout REST coverage (AC-19, AC-20, AC-21, AC-22).
 */
describe('rollout routes', () => {
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
    s.db.prepare(
      'INSERT INTO variants (id, workspace_id, label, instance, channel, pin_policy_default) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('v-1', 'ws-1', 'web/team', null, 'stable', 'pin-on-release');
    s.db.prepare(
      'INSERT INTO variant_rollout (variant_id, node_id, available_rev, pin_rev, state) VALUES (?, ?, ?, ?, ?)',
    ).run('v-1', 'node-1', 'A.0', null, 'Available-on-Channel');
  });
  afterEach(() => s.db.close());

  test('GET /workspaces/:id/variants/:vid/rollout returns entries', async () => {
    const res = await s.request('GET', '/api/v1/workspaces/ws-1/variants/v-1/rollout');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rollout: Array<{ state: string }> };
    expect(body.rollout[0]?.state).toBe('Available-on-Channel');
  });

  test('AC-20: advance refuses when pinRev already equals availableRev', async () => {
    s.db.prepare('UPDATE variant_rollout SET pin_rev = available_rev').run();
    const res = await s.request(
      'PUT',
      '/api/v1/workspaces/ws-1/variants/v-1/rollout/node-1/advance',
    );
    expect(res.status).toBe(409);
  });

  test('AC-21: advance emits a rollout.advance audit event', async () => {
    const res = await s.request(
      'PUT',
      '/api/v1/workspaces/ws-1/variants/v-1/rollout/node-1/advance',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rollout: { state: string } };
    expect(body.rollout.state).toBe('Pinned-by-Variant');

    const audits = s.deps.repos.audit.listByType('ws-1', 'rollout.advance');
    expect(audits.length).toBe(1);
    const payload = audits[0]?.payload as { from: string; to: string };
    expect(payload.from).toBe('Available-on-Channel');
    expect(payload.to).toBe('Pinned-by-Variant');
  });

  test('AC-19: pin-policy override is persisted', async () => {
    const res = await s.request(
      'PUT',
      '/api/v1/workspaces/ws-1/variants/v-1/rollout/node-1/pin-policy',
      { body: { pinRev: 'A.1' } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rollout: { pinRev: string } };
    expect(body.rollout.pinRev).toBe('A.1');
    // Audit row
    const audits = s.deps.repos.audit.listByType('ws-1', 'rollout.pin_policy');
    expect(audits.length).toBe(1);
  });
});
