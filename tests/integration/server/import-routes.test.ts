import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { makeTestServer, type TestServer } from './helpers.ts';

/**
 * POST /workspaces + POST /workspaces/import end-to-end coverage.
 */

const SAMPLE_SEKKEI = [
  {
    filename: 'sekkei.yaml',
    content: `id: kizo:dev.demo
stratum: system
title: Demo
revision: { major: A, iteration: 0, status: in_work }
provenance: { derives_from: null, override_kind: net_new, authored_by: alice@example.com, authored_at: 2026-05-11T00:00:00Z }
body: { system_role: root, acceptance_gate: A.0 }
relationships:
  - { kind: composes-of, target: kizo:dev.demo.thing }
`,
  },
  {
    filename: 'nodes/components/thing.yaml',
    content: `id: kizo:dev.demo.thing
stratum: component
title: Thing
revision: { major: A, iteration: 0, status: in_work }
provenance: { derives_from: null, override_kind: net_new, authored_by: alice@example.com, authored_at: 2026-05-11T00:00:00Z }
body: { boundary: b, runtime: in_process }
`,
  },
];

describe('POST /workspaces', () => {
  let s: TestServer;
  beforeEach(() => { s = makeTestServer(); });
  afterEach(() => s.db.close());

  test('creates a workspace and adds caller as owner', async () => {
    const res = await s.request('POST', '/api/v1/workspaces', {
      body: { slug: 'new-thing', name: 'New Thing' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspace: { id: string; slug: string } };
    expect(body.workspace.slug).toBe('new-thing');
    const member = s.deps.repos.workspaces.findMember(body.workspace.id, 'user-1');
    expect(member?.role).toBe('owner');
  });

  test('rejects an invalid slug', async () => {
    const res = await s.request('POST', '/api/v1/workspaces', {
      body: { slug: 'Bad Slug!', name: 'x' },
    });
    expect(res.status).toBe(400);
  });

  test('rejects a duplicate slug with 409', async () => {
    await s.request('POST', '/api/v1/workspaces', { body: { slug: 'one', name: 'One' } });
    const res = await s.request('POST', '/api/v1/workspaces', { body: { slug: 'one', name: 'Again' } });
    expect(res.status).toBe(409);
  });
});

describe('POST /workspaces/import', () => {
  let s: TestServer;
  beforeEach(() => { s = makeTestServer(); });
  afterEach(() => s.db.close());

  test('imports inline documents and returns a populated summary', async () => {
    const res = await s.request('POST', '/api/v1/workspaces/import', {
      body: { slug: 'demo-sekkei', name: 'Demo sekkei', documents: SAMPLE_SEKKEI },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workspaceId: string;
      summary: { nodesInserted: number; nodesUnchanged: number };
    };
    expect(body.summary.nodesInserted).toBe(2);
    const nodes = s.deps.repos.nodes.listByWorkspace(body.workspaceId);
    expect(nodes.length).toBe(2);
  });

  test('caller is enrolled as owner', async () => {
    const res = await s.request('POST', '/api/v1/workspaces/import', {
      body: { slug: 'demo-2', name: 'Demo 2', documents: SAMPLE_SEKKEI },
    });
    const body = (await res.json()) as { workspaceId: string };
    const member = s.deps.repos.workspaces.findMember(body.workspaceId, 'user-1');
    expect(member?.role).toBe('owner');
  });

  test('idempotent re-import reports unchanged counts', async () => {
    await s.request('POST', '/api/v1/workspaces/import', {
      body: { slug: 'demo-3', name: 'Demo 3', documents: SAMPLE_SEKKEI },
    });
    const second = await s.request('POST', '/api/v1/workspaces/import', {
      body: { slug: 'demo-3', name: 'Demo 3', documents: SAMPLE_SEKKEI },
    });
    expect([200, 201]).toContain(second.status);
    const body = (await second.json()) as {
      summary: { nodesInserted: number; nodesUnchanged: number };
    };
    expect(body.summary.nodesInserted).toBe(0);
    expect(body.summary.nodesUnchanged).toBe(2);
  });

  test('dry-run reports the same counts without persisting', async () => {
    const res = await s.request('POST', '/api/v1/workspaces/import', {
      body: { slug: 'demo-4', name: 'Demo 4', documents: SAMPLE_SEKKEI, dryRun: true },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: { nodesInserted: number; dryRun: boolean } };
    expect(body.summary.dryRun).toBe(true);
    expect(body.summary.nodesInserted).toBe(2);
    expect(s.deps.repos.workspaces.findBySlug('demo-4')).toBeNull();
  });

  test('rejects an invalid slug', async () => {
    const res = await s.request('POST', '/api/v1/workspaces/import', {
      body: { slug: 'BAD SLUG', name: 'x', documents: SAMPLE_SEKKEI },
    });
    expect(res.status).toBe(400);
  });

  test('rejects missing documents', async () => {
    const res = await s.request('POST', '/api/v1/workspaces/import', {
      body: { slug: 'demo-5', name: 'x', documents: [] },
    });
    expect(res.status).toBe(400);
  });

  test('drops non-YAML filenames from the document list', async () => {
    const res = await s.request('POST', '/api/v1/workspaces/import', {
      body: {
        slug: 'demo-6',
        name: 'x',
        documents: [
          { filename: 'README.md', content: '# nope' },
          ...SAMPLE_SEKKEI,
        ],
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { summary: { nodesInserted: number } };
    expect(body.summary.nodesInserted).toBe(2);
  });
});
