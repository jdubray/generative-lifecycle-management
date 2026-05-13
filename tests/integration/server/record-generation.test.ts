/**
 * POST /workspaces/:id/record-generation — provenance + audit attestation
 * for the MCP-driven generation flow. Replaces the in-flight provenance
 * insert in the legacy server-side `solo-generate` once Phase F lands.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { contentHash } from '../../../src/domain/content-hash.ts';
import { makeTestServer, type TestServer } from './helpers.ts';

const WS_ID = 'ws-1';
const COMPONENT_GLM = 'acme:web.shop.catalog.product_repository';

const VALID_FILES = [
  { path: 'src/repository.ts', sha256: `sha256:${'a'.repeat(64)}`, bytes: 1200 },
  { path: 'test/repository.test.ts', sha256: `sha256:${'b'.repeat(64)}`, bytes: 800 },
];

function seedComponent(s: TestServer): void {
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
  ins('node-comp', COMPONENT_GLM, 'component', { boundary: 'owns products table', runtime: 'in_process' });
  ins('node-spec-prompt', `${COMPONENT_GLM}.spec.prompt`, 'spec',
    {
      context_bundle: ['acme:web.shop'],
      outputs: [{ path: 'src/repository.ts' }],
      prompt_template: 'Generate the product repository.',
    },
    { specKind: 'prompt' });
  ins('node-spec-accept', `${COMPONENT_GLM}.spec.acceptance`, 'spec',
    { verifier: { command: 'bun test', expect: 'exit 0' } },
    { specKind: 'acceptance' });
}

describe('POST /workspaces/:id/record-generation', () => {
  let s: TestServer;
  afterEach(() => s?.db.close());

  test('inserts a provenance row + audit row and returns the provenance', async () => {
    s = makeTestServer();
    seedComponent(s);

    const res = await s.request('POST', `/api/v1/workspaces/${WS_ID}/record-generation`, {
      body: {
        componentId: COMPONENT_GLM,
        files: VALID_FILES,
        verifierExitCode: 0,
        bindingHash: `sha256:${'c'.repeat(64)}`,
        generatorIdentity: 'claude-code/sonnet-4-6',
        durationMs: 4321,
      },
    });
    expect(res.status).toBe(200);
    const { provenance } = (await res.json()) as { provenance: { id: string; workspaceId: string; subjectFile: string; sekkeiRoot: string; bindingHash: string; generatorLlm: string; durationMs: number } };
    expect(provenance.id).toBeTruthy();
    expect(provenance.workspaceId).toBe(WS_ID);
    expect(provenance.subjectFile).toBe('src/repository.ts,test/repository.test.ts');
    expect(provenance.sekkeiRoot).toBe(COMPONENT_GLM);
    expect(provenance.bindingHash).toBe(`sha256:${'c'.repeat(64)}`);
    expect(provenance.generatorLlm).toBe('claude-code/sonnet-4-6');
    expect(provenance.durationMs).toBe(4321);

    // Verify a row landed in the DB.
    const rows = s.db.prepare('SELECT id FROM provenance_events WHERE workspace_id = ?').all(WS_ID) as Array<{ id: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(provenance.id);

    const audit = s.db.prepare("SELECT event_type, payload_json FROM audit_events WHERE workspace_id = ? AND event_type = 'mcp.generate'").all(WS_ID) as Array<{ event_type: string; payload_json: string }>;
    expect(audit.length).toBe(1);
    expect(JSON.parse(audit[0]?.payload_json ?? '{}')).toMatchObject({
      componentId: COMPONENT_GLM,
      filesWritten: 2,
      verifierExitCode: 0,
      provenanceId: provenance.id,
    });
  });

  test('falls back to current bindingHash when client omits it', async () => {
    s = makeTestServer();
    seedComponent(s);

    const res = await s.request('POST', `/api/v1/workspaces/${WS_ID}/record-generation`, {
      body: { componentId: COMPONENT_GLM, files: VALID_FILES, verifierExitCode: 0 },
    });
    expect(res.status).toBe(200);
    const { provenance } = (await res.json()) as { provenance: { bindingHash: string } };
    expect(provenance.bindingHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('defaults generatorIdentity to claude-code/mcp', async () => {
    s = makeTestServer();
    seedComponent(s);
    const res = await s.request('POST', `/api/v1/workspaces/${WS_ID}/record-generation`, {
      body: { componentId: COMPONENT_GLM, files: VALID_FILES, verifierExitCode: 0 },
    });
    expect(res.status).toBe(200);
    const { provenance } = (await res.json()) as { provenance: { generatorLlm: string } };
    expect(provenance.generatorLlm).toBe('claude-code/mcp');
  });

  test('returns 400 when files is empty', async () => {
    s = makeTestServer();
    seedComponent(s);
    const res = await s.request('POST', `/api/v1/workspaces/${WS_ID}/record-generation`, {
      body: { componentId: COMPONENT_GLM, files: [], verifierExitCode: 0 },
    });
    expect(res.status).toBe(400);
  });

  test('returns 400 when a file entry is missing sha256', async () => {
    s = makeTestServer();
    seedComponent(s);
    const res = await s.request('POST', `/api/v1/workspaces/${WS_ID}/record-generation`, {
      body: {
        componentId: COMPONENT_GLM,
        files: [{ path: 'src/x.ts', bytes: 100 }],
        verifierExitCode: 0,
      },
    });
    expect(res.status).toBe(400);
  });

  test('returns 400 when verifierExitCode is not an integer', async () => {
    s = makeTestServer();
    seedComponent(s);
    const res = await s.request('POST', `/api/v1/workspaces/${WS_ID}/record-generation`, {
      body: { componentId: COMPONENT_GLM, files: VALID_FILES, verifierExitCode: 'green' },
    });
    expect(res.status).toBe(400);
  });

  test('returns 404 when the component does not exist', async () => {
    s = makeTestServer();
    const res = await s.request('POST', `/api/v1/workspaces/${WS_ID}/record-generation`, {
      body: { componentId: 'petco:web.shop.unknown', files: VALID_FILES, verifierExitCode: 0 },
    });
    expect(res.status).toBe(404);
  });

  test('returns 401 without auth', async () => {
    s = makeTestServer();
    seedComponent(s);
    const res = await s.app.request(`/api/v1/workspaces/${WS_ID}/record-generation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ componentId: COMPONENT_GLM, files: VALID_FILES, verifierExitCode: 0 }),
    });
    expect(res.status).toBe(401);
  });
});
