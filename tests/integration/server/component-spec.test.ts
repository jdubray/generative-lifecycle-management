/**
 * Composite endpoint `GET /workspaces/:id/components/:glm_id/spec` — drives
 * the MCP `glm_get_component_spec` tool. The endpoint resolves the
 * component + its spec.prompt + spec.acceptance + context bundle into one
 * payload so the MCP client can build a generation prompt without N
 * round-trips.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { contentHash } from '../../../src/domain/content-hash.ts';
import { makeTestServer, type TestServer } from './helpers.ts';

const WS_ID = 'ws-1';
const COMPONENT_GLM = 'acme:web.shop.catalog.product_repository';

function seedComponent(s: TestServer, opts: { sourceDir?: string | null } = {}): void {
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
    { system_role: 'root', realization_summary: 'shop', acceptance_gate: 'all green' },
    { systemRole: 'root' });
  ins('node-cap', 'acme:web.shop.catalog', 'capability', { user_value: 'catalog', boundary: 'owns products' });
  ins('node-comp', COMPONENT_GLM, 'component', { boundary: 'owns products table', runtime: 'in_process' });
  ins('node-spec-prompt', `${COMPONENT_GLM}.spec.prompt`, 'spec',
    {
      context_bundle: ['acme:web.shop', 'acme:web.shop.catalog'],
      outputs: [{ path: 'src/repository.ts', description: 'repo module' }],
      prompt_template: 'You are generating the product repository.',
    },
    { specKind: 'prompt' });
  ins('node-spec-accept', `${COMPONENT_GLM}.spec.acceptance`, 'spec',
    {
      verifier: { command: 'bun test test/repository.test.ts', expect: 'exit 0' },
    },
    { specKind: 'acceptance' });
  if (opts.sourceDir !== undefined) {
    s.deps.repos.workspaces.setSourceDir(WS_ID, opts.sourceDir);
  }
}

describe('GET /workspaces/:id/components/:glm_id/spec', () => {
  let s: TestServer;
  afterEach(() => s?.db.close());

  test('returns the composite payload — component, prompt, acceptance, context bundle', async () => {
    s = makeTestServer();
    seedComponent(s, { sourceDir: '/tmp/acme-shop' });

    const res = await s.request('GET', `/api/v1/workspaces/${WS_ID}/components/${encodeURIComponent(COMPONENT_GLM)}/spec`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { spec: Record<string, unknown> };
    expect(json.spec).toBeDefined();

    const spec = json.spec as {
      component: { glmId: string; stratum: string };
      specPrompt: { glmId: string };
      specAcceptance: { glmId: string };
      outputs: Array<{ path: string }>;
      contextBundle: { text: string; bindingHash: string };
      hardConstraints: string;
      sourceDir: string | null;
      promptTemplate: string;
      verifierCommand: string;
    };

    expect(spec.component.glmId).toBe(COMPONENT_GLM);
    expect(spec.component.stratum).toBe('component');
    expect(spec.specPrompt.glmId).toBe(`${COMPONENT_GLM}.spec.prompt`);
    expect(spec.specAcceptance.glmId).toBe(`${COMPONENT_GLM}.spec.acceptance`);
    expect(spec.outputs).toHaveLength(1);
    expect(spec.outputs[0]?.path).toBe('src/repository.ts');
    expect(spec.contextBundle.text).toContain('acme:web.shop');
    expect(spec.contextBundle.text).toContain('acme:web.shop.catalog');
    expect(spec.contextBundle.bindingHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(spec.hardConstraints).toContain('=== FILE:');
    expect(spec.sourceDir).toBe('/tmp/acme-shop');
    expect(spec.promptTemplate).toContain('product repository');
    expect(spec.verifierCommand).toBe('bun test test/repository.test.ts');
  });

  test('returns 404 when the component does not exist', async () => {
    s = makeTestServer();
    const res = await s.request('GET', `/api/v1/workspaces/${WS_ID}/components/petco%3Aweb.shop.unknown/spec`);
    expect(res.status).toBe(404);
  });

  test('returns 422 when the target is not a component stratum', async () => {
    s = makeTestServer();
    seedComponent(s);
    const res = await s.request('GET', `/api/v1/workspaces/${WS_ID}/components/${encodeURIComponent('acme:web.shop')}/spec`);
    expect(res.status).toBe(422);
  });

  test('returns 422 when spec.prompt is missing', async () => {
    s = makeTestServer();
    // Seed component but no spec.prompt
    const now = '2026-05-13T00:00:00.000Z';
    s.db
      .prepare(
        `INSERT INTO nodes (id, workspace_id, glm_id, stratum, title, description,
            body_json, content_hash, revision_major, revision_iteration, revision_status,
            override_kind, system_role, spec_kind, authored_by, authored_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'orphan-comp', WS_ID, COMPONENT_GLM, 'component', COMPONENT_GLM, '',
        JSON.stringify({ boundary: 'x', runtime: 'in_process' }),
        contentHash({ boundary: 'x', runtime: 'in_process' }),
        'A', 0, 'in_work', 'net_new',
        null, null, 'user-1', now, now,
      );
    const res = await s.request('GET', `/api/v1/workspaces/${WS_ID}/components/${encodeURIComponent(COMPONENT_GLM)}/spec`);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain('spec.prompt');
  });

  test('returns 401 without auth', async () => {
    s = makeTestServer();
    seedComponent(s);
    const res = await s.app.request(`/api/v1/workspaces/${WS_ID}/components/${encodeURIComponent(COMPONENT_GLM)}/spec`);
    expect(res.status).toBe(401);
  });
});
