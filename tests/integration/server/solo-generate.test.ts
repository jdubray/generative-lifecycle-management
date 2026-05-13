/**
 * Phase 6 — solo-mode generation integration tests.
 *
 * Cover the HTTP route end-to-end with the Claude subprocess and the verifier
 * subprocess mocked via injection on `runSoloGenerate`. We import the service
 * directly to call it with mocked runners; for the route test, we monkey-patch
 * `runSoloGenerate` is unnecessary — instead we cover the route validation
 * paths (400/404/409) and rely on the service-level tests for the happy path.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash } from '../../../src/domain/content-hash.ts';
import { runSoloGenerate, SoloGenerateError } from '../../../src/generation/solo-generate.ts';
import { makeTestServer, type TestServer } from './helpers.ts';

const WS_ID = 'ws-1';
const COMPONENT_GLM = 'acme:web.shop.catalog.product_repository';
const NODE_BODY_COMPONENT = {
  boundary: 'Owns the product table. Does NOT own pricing.',
  runtime: 'in_process',
  realization_file: 'src/repository.ts',
};
const NODE_BODY_PROMPT = {
  context_bundle: ['acme:web.shop', `${COMPONENT_GLM}.spec.functional`],
  outputs: [
    { path: 'src/repository.ts', description: 'Product repository module' },
    { path: 'test/repository.test.ts', description: 'Bun tests for the repo' },
  ],
  prompt_template: 'You are generating the product repository for Acme Shop.',
};
const NODE_BODY_ACCEPTANCE = {
  deliverables: [{ kind: 'test_file', path: 'test/repository.test.ts' }],
  verifier: {
    command: process.platform === 'win32' ? 'cmd /c exit 0' : 'true',
    expect: 'all tests pass; exit code 0',
  },
};
const NODE_BODY_SYSTEM = { system_role: 'root', realization_summary: 'Acme shop', acceptance_gate: 'all gates pass' };
const NODE_BODY_FUNC = { behaviors: [{ id: 'create', signature: 'create(input)' }] };

function seedComponent(s: TestServer): void {
  const now = '2026-05-12T00:00:00.000Z';
  function ins(id: string, glm: string, stratum: string, body: unknown, opts: { systemRole?: string; specKind?: string } = {}) {
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
        opts.systemRole ?? null, opts.specKind ?? null,
        'user-1', now, now,
      );
  }
  ins('node-sys', 'acme:web.shop', 'system', NODE_BODY_SYSTEM, { systemRole: 'root' });
  ins('node-cap', 'acme:web.shop.catalog', 'capability', { user_value: 'catalog', boundary: 'owns products' });
  ins('node-comp', COMPONENT_GLM, 'component', NODE_BODY_COMPONENT);
  ins('node-spec-func', `${COMPONENT_GLM}.spec.functional`, 'spec', NODE_BODY_FUNC, { specKind: 'functional' });
  ins('node-spec-prompt', `${COMPONENT_GLM}.spec.prompt`, 'spec', NODE_BODY_PROMPT, { specKind: 'prompt' });
  ins('node-spec-accept', `${COMPONENT_GLM}.spec.acceptance`, 'spec', NODE_BODY_ACCEPTANCE, { specKind: 'acceptance' });
}

function buildClaudeOutput(): string {
  return [
    '=== FILE: src/repository.ts ===',
    'export class Repository {}',
    '=== FILE: test/repository.test.ts ===',
    "import { test } from 'bun:test';",
    "test('placeholder', () => {});",
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Service-level tests — exercise runSoloGenerate() with both runners mocked.
// ---------------------------------------------------------------------------

describe('runSoloGenerate (service)', () => {
  let s: TestServer;
  let tmp: string;

  afterEach(() => {
    if (tmp) {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    s.db.close();
  });

  test('writes outputs, runs verifier, records provenance, returns result', async () => {
    s = makeTestServer();
    seedComponent(s);
    tmp = mkdtempSync(join(tmpdir(), 'glm-gen-test-'));
    s.deps.repos.workspaces.setSourceDir(WS_ID, tmp);

    const result = await runSoloGenerate(
      {
        repos: {
          nodes: s.deps.repos.nodes,
          workspaces: s.deps.repos.workspaces,
          provenance: s.deps.repos.provenance,
          audit: s.deps.repos.audit,
        },
        clock: s.deps.clock,
        userId: 'user-1',
      },
      {
        workspaceId: WS_ID,
        componentGlmId: COMPONENT_GLM,
        claudeRunner: async () => ({ stdout: buildClaudeOutput(), stderr: '' }),
        verifierRunner: () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
      },
    );

    expect(result.dryRun).toBe(false);
    expect(result.filesWritten.length).toBe(2);
    expect(result.filesWritten.map((f) => f.path)).toEqual([
      'src/repository.ts',
      'test/repository.test.ts',
    ]);
    expect(result.verifier.exitCode).toBe(0);
    expect(result.provenance).not.toBeNull();
    expect(result.provenance?.workspaceId).toBe(WS_ID);
    // Files actually exist on disk:
    expect(readFileSync(join(tmp, 'src/repository.ts'), 'utf8')).toContain('export class Repository');
    expect(readFileSync(join(tmp, 'test/repository.test.ts'), 'utf8')).toContain('placeholder');
  });

  test('--dry-run does not touch source_dir and skips provenance', async () => {
    s = makeTestServer();
    seedComponent(s);
    tmp = mkdtempSync(join(tmpdir(), 'glm-gen-test-'));
    s.deps.repos.workspaces.setSourceDir(WS_ID, tmp);

    const result = await runSoloGenerate(
      {
        repos: {
          nodes: s.deps.repos.nodes,
          workspaces: s.deps.repos.workspaces,
          provenance: s.deps.repos.provenance,
          audit: s.deps.repos.audit,
        },
      },
      {
        workspaceId: WS_ID,
        componentGlmId: COMPONENT_GLM,
        dryRun: true,
        claudeRunner: async () => ({ stdout: buildClaudeOutput(), stderr: '' }),
        verifierRunner: () => ({ exitCode: 0, stdout: '', stderr: '' }),
      },
    );

    expect(result.dryRun).toBe(true);
    expect(result.provenance).toBeNull();
    // Source dir is untouched:
    expect(() => readFileSync(join(tmp, 'src/repository.ts'))).toThrow();
  });

  test('throws SoloGenerateError on missing workspace', async () => {
    s = makeTestServer();
    seedComponent(s);
    await expect(
      runSoloGenerate(
        {
          repos: {
            nodes: s.deps.repos.nodes,
            workspaces: s.deps.repos.workspaces,
            provenance: s.deps.repos.provenance,
            audit: s.deps.repos.audit,
          },
        },
        {
          workspaceId: 'no-such-ws',
          componentGlmId: COMPONENT_GLM,
          claudeRunner: async () => ({ stdout: '', stderr: '' }),
          verifierRunner: () => ({ exitCode: 0, stdout: '', stderr: '' }),
        },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test('throws 409 when source_dir is unset', async () => {
    s = makeTestServer();
    seedComponent(s);
    await expect(
      runSoloGenerate(
        {
          repos: {
            nodes: s.deps.repos.nodes,
            workspaces: s.deps.repos.workspaces,
            provenance: s.deps.repos.provenance,
            audit: s.deps.repos.audit,
          },
        },
        {
          workspaceId: WS_ID,
          componentGlmId: COMPONENT_GLM,
          claudeRunner: async () => ({ stdout: '', stderr: '' }),
          verifierRunner: () => ({ exitCode: 0, stdout: '', stderr: '' }),
        },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  test('throws 422 when component is wrong stratum', async () => {
    s = makeTestServer();
    seedComponent(s);
    tmp = mkdtempSync(join(tmpdir(), 'glm-gen-test-'));
    s.deps.repos.workspaces.setSourceDir(WS_ID, tmp);
    await expect(
      runSoloGenerate(
        {
          repos: {
            nodes: s.deps.repos.nodes,
            workspaces: s.deps.repos.workspaces,
            provenance: s.deps.repos.provenance,
            audit: s.deps.repos.audit,
          },
        },
        {
          workspaceId: WS_ID,
          componentGlmId: 'acme:web.shop.catalog', // a capability, not component
          claudeRunner: async () => ({ stdout: '', stderr: '' }),
          verifierRunner: () => ({ exitCode: 0, stdout: '', stderr: '' }),
        },
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  test('throws when Claude output has no FILE markers', async () => {
    s = makeTestServer();
    seedComponent(s);
    tmp = mkdtempSync(join(tmpdir(), 'glm-gen-test-'));
    s.deps.repos.workspaces.setSourceDir(WS_ID, tmp);
    await expect(
      runSoloGenerate(
        {
          repos: {
            nodes: s.deps.repos.nodes,
            workspaces: s.deps.repos.workspaces,
            provenance: s.deps.repos.provenance,
            audit: s.deps.repos.audit,
          },
        },
        {
          workspaceId: WS_ID,
          componentGlmId: COMPONENT_GLM,
          claudeRunner: async () => ({ stdout: 'just some prose, no markers', stderr: '' }),
          verifierRunner: () => ({ exitCode: 0, stdout: '', stderr: '' }),
        },
      ),
    ).rejects.toBeInstanceOf(SoloGenerateError);
  });

  test('rejects path-traversal in Claude output', async () => {
    s = makeTestServer();
    seedComponent(s);
    tmp = mkdtempSync(join(tmpdir(), 'glm-gen-test-'));
    s.deps.repos.workspaces.setSourceDir(WS_ID, tmp);
    const evilOutput = '=== FILE: ../../etc/passwd ===\nroot::0:0::/:/bin/sh\n';
    await expect(
      runSoloGenerate(
        {
          repos: {
            nodes: s.deps.repos.nodes,
            workspaces: s.deps.repos.workspaces,
            provenance: s.deps.repos.provenance,
            audit: s.deps.repos.audit,
          },
        },
        {
          workspaceId: WS_ID,
          componentGlmId: COMPONENT_GLM,
          claudeRunner: async () => ({ stdout: evilOutput, stderr: '' }),
          verifierRunner: () => ({ exitCode: 0, stdout: '', stderr: '' }),
        },
      ),
    ).rejects.toBeInstanceOf(SoloGenerateError);
  });

  test('verifier failure → SoloGenerateError 422 and no provenance row', async () => {
    s = makeTestServer();
    seedComponent(s);
    tmp = mkdtempSync(join(tmpdir(), 'glm-gen-test-'));
    s.deps.repos.workspaces.setSourceDir(WS_ID, tmp);
    await expect(
      runSoloGenerate(
        {
          repos: {
            nodes: s.deps.repos.nodes,
            workspaces: s.deps.repos.workspaces,
            provenance: s.deps.repos.provenance,
            audit: s.deps.repos.audit,
          },
        },
        {
          workspaceId: WS_ID,
          componentGlmId: COMPONENT_GLM,
          claudeRunner: async () => ({ stdout: buildClaudeOutput(), stderr: '' }),
          verifierRunner: () => ({ exitCode: 1, stdout: '', stderr: 'tests failed' }),
        },
      ),
    ).rejects.toMatchObject({ status: 422 });
    // No provenance row recorded:
    expect(s.deps.repos.provenance.listByWorkspace(WS_ID).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Route-level tests — validate request shape only (happy path covered above).
// ---------------------------------------------------------------------------

describe('POST /workspaces/:id/solo-generate (route)', () => {
  let s: TestServer;
  afterEach(() => s.db.close());

  test('400 when component_id is missing', async () => {
    s = makeTestServer();
    const res = await s.request('POST', `/api/v1/workspaces/${WS_ID}/solo-generate`, {
      body: {},
    });
    expect(res.status).toBe(400);
  });

  test('400 when source_dir is relative', async () => {
    s = makeTestServer();
    seedComponent(s);
    const res = await s.request('POST', `/api/v1/workspaces/${WS_ID}/solo-generate`, {
      body: { component_id: COMPONENT_GLM, source_dir: 'not-absolute' },
    });
    expect(res.status).toBe(400);
  });

  test('404 when workspace does not exist', async () => {
    s = makeTestServer();
    const res = await s.request('POST', `/api/v1/workspaces/no-such-ws/solo-generate`, {
      body: { component_id: COMPONENT_GLM },
    });
    expect(res.status).toBe(404);
  });

  test('409 when workspace has no source_dir and none provided', async () => {
    s = makeTestServer();
    seedComponent(s);
    const res = await s.request('POST', `/api/v1/workspaces/${WS_ID}/solo-generate`, {
      body: { component_id: COMPONENT_GLM },
    });
    expect(res.status).toBe(409);
  });

  test('persists source_dir on workspace when provided in request body', async () => {
    s = makeTestServer();
    // No seedComponent() — the route will fail at the component lookup AFTER
    // persisting source_dir, so we don't risk spawning the real claude CLI.
    const tmp2 = mkdtempSync(join(tmpdir(), 'glm-gen-test-'));
    try {
      const res = await s.request('POST', `/api/v1/workspaces/${WS_ID}/solo-generate`, {
        body: { component_id: 'acme:no-such.component', source_dir: tmp2 },
      });
      // Component is missing → 404 from the service. But source_dir was set
      // earlier in the route, BEFORE runSoloGenerate is called.
      expect(res.status).toBe(404);
      const ws = s.deps.repos.workspaces.findById(WS_ID);
      expect(ws?.sourceDir).toBe(tmp2);
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});
