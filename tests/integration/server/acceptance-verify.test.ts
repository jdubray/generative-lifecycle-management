/**
 * POST /workspaces/:id/acceptance-verify — drives the MCP
 * `glm_run_acceptance_verifier` tool. Runs a component's authoritative
 * verifier command in the workspace's source_dir.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash } from '../../../src/domain/content-hash.ts';
import { makeTestServer, type TestServer } from './helpers.ts';

const WS_ID = 'ws-1';
const COMPONENT_GLM = 'acme:web.shop.catalog.product_repository';

function seedComponent(s: TestServer, verifierCommand: string): void {
  const now = '2026-05-13T00:00:00.000Z';
  function ins(id: string, glm: string, stratum: string, body: unknown, extra: { systemRole?: string; specKind?: string } = {}) {
    s.db
      .prepare(
        `INSERT INTO nodes (id, workspace_id, glm_id, stratum, title, description,
            body_json, content_hash, revision_major, revision_iteration, revision_status,
            override_kind, system_role, spec_kind, authored_by, authored_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, WS_ID, glm, stratum, glm, '',
        JSON.stringify(body), contentHash(body),
        'A', 0, 'in_work', 'net_new',
        extra.systemRole ?? null, extra.specKind ?? null,
        'user-1', now, now,
      );
  }
  ins('node-sys', 'acme:web.shop', 'system',
    { system_role: 'root', realization_summary: 'shop', acceptance_gate: 'green' },
    { systemRole: 'root' });
  ins('node-cap', 'acme:web.shop.catalog', 'capability', { user_value: 'catalog', boundary: 'owns products' });
  ins('node-comp', COMPONENT_GLM, 'component', { boundary: 'products table', runtime: 'in_process' });
  ins('node-spec-prompt', `${COMPONENT_GLM}.spec.prompt`, 'spec',
    {
      context_bundle: ['acme:web.shop'],
      outputs: [{ path: 'src/repository.ts' }],
      prompt_template: 'Generate the product repository.',
    },
    { specKind: 'prompt' });
  ins('node-spec-accept', `${COMPONENT_GLM}.spec.acceptance`, 'spec',
    { verifier: { command: verifierCommand, expect: 'exit 0' } },
    { specKind: 'acceptance' });
}

describe('POST /workspaces/:id/acceptance-verify', () => {
  let s: TestServer;
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp) {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      tmp = undefined;
    }
    s?.db.close();
  });

  test('runs the sekkei-authored verifier command in source_dir and returns exit code 0', async () => {
    s = makeTestServer();
    // A trivially-passing command on both platforms.
    const command = process.platform === 'win32' ? 'cmd /c exit 0' : 'true';
    seedComponent(s, command);
    tmp = mkdtempSync(join(tmpdir(), 'glm-accept-test-'));
    s.deps.repos.workspaces.setSourceDir(WS_ID, tmp);

    const res = await s.request('POST', `/api/v1/workspaces/${WS_ID}/acceptance-verify`, {
      body: { componentId: COMPONENT_GLM },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: { command: string; cwd: string; exitCode: number } };
    expect(json.result.command).toBe(command);
    expect(json.result.cwd).toBe(tmp);
    expect(json.result.exitCode).toBe(0);
  });

  test('propagates non-zero exit code with stderr captured', async () => {
    s = makeTestServer();
    // Trivially-failing command.
    const command = process.platform === 'win32' ? 'cmd /c exit 7' : 'sh -c "exit 7"';
    seedComponent(s, command);
    tmp = mkdtempSync(join(tmpdir(), 'glm-accept-test-'));
    s.deps.repos.workspaces.setSourceDir(WS_ID, tmp);

    const res = await s.request('POST', `/api/v1/workspaces/${WS_ID}/acceptance-verify`, {
      body: { componentId: COMPONENT_GLM },
    });
    expect(res.status).toBe(200); // HTTP success even when the verifier failed; failure is in the body
    const json = (await res.json()) as { result: { exitCode: number } };
    expect(json.result.exitCode).toBe(7);
  });

  test('returns 409 when workspace has no source_dir', async () => {
    s = makeTestServer();
    seedComponent(s, 'true');
    // Deliberately do NOT setSourceDir.

    const res = await s.request('POST', `/api/v1/workspaces/${WS_ID}/acceptance-verify`, {
      body: { componentId: COMPONENT_GLM },
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain('source_dir');
  });

  test('returns 400 when componentId is missing', async () => {
    s = makeTestServer();
    seedComponent(s, 'true');
    const res = await s.request('POST', `/api/v1/workspaces/${WS_ID}/acceptance-verify`, { body: {} });
    expect(res.status).toBe(400);
  });

  test('returns 404 when component does not exist', async () => {
    s = makeTestServer();
    tmp = mkdtempSync(join(tmpdir(), 'glm-accept-test-'));
    s.deps.repos.workspaces.setSourceDir(WS_ID, tmp);
    const res = await s.request('POST', `/api/v1/workspaces/${WS_ID}/acceptance-verify`, {
      body: { componentId: 'petco:web.shop.unknown' },
    });
    expect(res.status).toBe(404);
  });

  test('returns 401 without auth', async () => {
    s = makeTestServer();
    seedComponent(s, 'true');
    const res = await s.app.request(`/api/v1/workspaces/${WS_ID}/acceptance-verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ componentId: COMPONENT_GLM }),
    });
    expect(res.status).toBe(401);
  });
});
