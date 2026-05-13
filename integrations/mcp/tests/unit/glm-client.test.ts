import { describe, expect, test } from 'bun:test';
import { GlmClient } from '../../src/lib/glm-client.ts';
import { HttpError, ServerUnreachableError } from '../../src/lib/errors.ts';

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init ?? {});
  }) as typeof fetch;
}

describe('GlmClient.getWorkspaceSummary', () => {
  test('sends bearer auth + parses JSON response', async () => {
    let seenAuth: string | null = null;
    let seenUrl = '';
    const client = new GlmClient({
      baseUrl: 'http://localhost:3300',
      token: 'tok-x',
      fetch: fakeFetch((url, init) => {
        seenUrl = url;
        seenAuth =
          (init.headers as Record<string, string>)?.Authorization ?? null;
        return new Response(
          JSON.stringify({
            workspace: { id: 'ws-1', slug: 'demo', name: 'Demo' },
            nodesByStratum: { component: 5 },
            scrsByStatus: {},
            driftByStatus: {},
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    });
    const out = await client.getWorkspaceSummary('ws-1');
    expect(seenUrl).toBe('http://localhost:3300/api/v1/workspaces/ws-1/summary');
    expect(seenAuth).toBe('Bearer tok-x');
    expect(out.workspace.slug).toBe('demo');
    expect(out.nodesByStratum.component).toBe(5);
  });

  test('omits Authorization header when no token configured', async () => {
    let seenAuth: string | null = 'sentinel';
    const client = new GlmClient({
      baseUrl: 'http://localhost:3300',
      token: undefined,
      fetch: fakeFetch((_url, init) => {
        const headers = (init.headers as Record<string, string>) ?? {};
        seenAuth = headers.Authorization ?? null;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    });
    await client.getWorkspaceSummary('ws-1').catch(() => undefined);
    expect(seenAuth).toBeNull();
  });

  test('non-2xx response throws HttpError carrying status + body', async () => {
    const client = new GlmClient({
      baseUrl: 'http://localhost:3300',
      token: 'tok',
      fetch: fakeFetch(() =>
        new Response('{"error":{"code":"not_found"}}', { status: 404 }),
      ),
    });
    await expect(client.getWorkspaceSummary('missing')).rejects.toBeInstanceOf(HttpError);
  });

  test('network error throws ServerUnreachableError', async () => {
    const client = new GlmClient({
      baseUrl: 'http://localhost:3300',
      token: 'tok',
      fetch: fakeFetch(() => {
        throw new TypeError('connect ECONNREFUSED');
      }),
    });
    await expect(client.getWorkspaceSummary('ws-1')).rejects.toBeInstanceOf(
      ServerUnreachableError,
    );
  });
});

describe('GlmClient.listNodes', () => {
  test('appends stratum query when supplied', async () => {
    let seenUrl = '';
    const client = new GlmClient({
      baseUrl: 'http://localhost:3300',
      token: 'tok',
      fetch: fakeFetch((url) => {
        seenUrl = url;
        return new Response('{"nodes":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    });
    await client.listNodes('ws-1', { stratum: 'component' });
    expect(seenUrl).toBe('http://localhost:3300/api/v1/workspaces/ws-1/nodes?stratum=component');
  });

  test('omits query when stratum unspecified', async () => {
    let seenUrl = '';
    const client = new GlmClient({
      baseUrl: 'http://localhost:3300',
      token: 'tok',
      fetch: fakeFetch((url) => {
        seenUrl = url;
        return new Response('{"nodes":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    });
    await client.listNodes('ws-1');
    expect(seenUrl).toBe('http://localhost:3300/api/v1/workspaces/ws-1/nodes');
  });
});

describe('GlmClient.getNode', () => {
  test('GETs the right path with encoded glm_id', async () => {
    let seenUrl = '';
    const client = new GlmClient({
      baseUrl: 'http://localhost:3300',
      token: 'tok',
      fetch: fakeFetch((url) => {
        seenUrl = url;
        return new Response(
          JSON.stringify({ node: { glmId: 'acme:web.shop' }, parameters: [], constraints: [], relationships: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    });
    const out = await client.getNode('ws-1', 'acme:web.shop');
    expect(seenUrl).toBe('http://localhost:3300/api/v1/workspaces/ws-1/nodes/acme%3Aweb.shop');
    expect(out.node.glmId).toBe('acme:web.shop');
  });
});

describe('GlmClient.runVerifier', () => {
  test('POSTs empty body to /verify and unwraps {run}', async () => {
    let seenUrl = '';
    let seenMethod = '';
    let seenBody = '';
    const client = new GlmClient({
      baseUrl: 'http://localhost:3300',
      token: 'tok',
      fetch: fakeFetch((url, init) => {
        seenUrl = url;
        seenMethod = init.method ?? '';
        seenBody = (init.body as string) ?? '';
        return new Response(
          JSON.stringify({
            run: {
              id: 'r-1',
              workspaceId: 'ws-1',
              ts: '2026-05-13T15:00:00Z',
              overallPass: true,
              gateResults: { gates: [] },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    });
    const out = await client.runVerifier('ws-1');
    expect(seenMethod).toBe('POST');
    expect(seenUrl).toBe('http://localhost:3300/api/v1/workspaces/ws-1/verify');
    expect(seenBody).toBe('{}');
    expect(out.id).toBe('r-1');
  });
});

describe('GlmClient.runAcceptanceVerify', () => {
  test('POSTs {componentId} body and unwraps {result}', async () => {
    let seenUrl = '';
    let seenBody = '';
    const client = new GlmClient({
      baseUrl: 'http://localhost:3300',
      token: 'tok',
      fetch: fakeFetch((url, init) => {
        seenUrl = url;
        seenBody = (init.body as string) ?? '';
        return new Response(
          JSON.stringify({
            result: {
              command: 'bun test',
              cwd: '/work',
              exitCode: 0,
              stdout: '',
              stderr: '',
              durationMs: 5,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    });
    const out = await client.runAcceptanceVerify('ws-1', 'acme:c');
    expect(seenUrl).toBe('http://localhost:3300/api/v1/workspaces/ws-1/acceptance-verify');
    expect(JSON.parse(seenBody)).toEqual({ componentId: 'acme:c' });
    expect(out.exitCode).toBe(0);
  });
});

describe('GlmClient.recordGeneration', () => {
  test('POSTs the full record-generation request and unwraps {provenance}', async () => {
    let seenUrl = '';
    let seenBody = '';
    const client = new GlmClient({
      baseUrl: 'http://localhost:3300',
      token: 'tok',
      fetch: fakeFetch((url, init) => {
        seenUrl = url;
        seenBody = (init.body as string) ?? '';
        return new Response(
          JSON.stringify({
            provenance: {
              id: 'p-1',
              workspaceId: 'ws-1',
              occurredAt: '2026-05-13T16:00:00Z',
              subjectFile: 'src/x.ts',
              subjectDigest: 'sha256:dd',
              sekkeiRoot: 'acme:c',
              sekkeiRev: 'sha256:aa',
              bindingHash: 'sha256:bb',
              generatorLlm: 'claude-code/sonnet-4-6',
              generatorPromptVersion: 'sha256:cc',
              durationMs: 100,
              note: null,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    });
    const out = await client.recordGeneration('ws-1', {
      componentId: 'acme:c',
      files: [{ path: 'src/x.ts', sha256: `sha256:${'a'.repeat(64)}`, bytes: 100 }],
      verifierExitCode: 0,
      bindingHash: 'sha256:bb',
    });
    expect(seenUrl).toBe('http://localhost:3300/api/v1/workspaces/ws-1/record-generation');
    const parsed = JSON.parse(seenBody);
    expect(parsed.componentId).toBe('acme:c');
    expect(parsed.verifierExitCode).toBe(0);
    expect(parsed.files).toHaveLength(1);
    expect(out.id).toBe('p-1');
  });
});

describe('GlmClient.acquireLock / releaseLock', () => {
  test('acquireLock POSTs to .../lock and unwraps {lock}', async () => {
    let seenUrl = '';
    const client = new GlmClient({
      baseUrl: 'http://localhost:3300',
      token: 'tok',
      fetch: fakeFetch((url) => {
        seenUrl = url;
        return new Response(
          JSON.stringify({
            lock: {
              nodeId: 'n-1',
              heldBy: 'solo',
              heartbeatAt: '2026-05-13T16:00:00Z',
              expiresAt: '2026-05-13T16:00:30Z',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    });
    const out = await client.acquireLock('ws-1', 'acme:c.spec.prompt');
    expect(seenUrl).toBe('http://localhost:3300/api/v1/workspaces/ws-1/nodes/acme%3Ac.spec.prompt/lock');
    expect(out.heldBy).toBe('solo');
  });

  test('releaseLock DELETEs', async () => {
    let seenUrl = '';
    let seenMethod = '';
    const client = new GlmClient({
      baseUrl: 'http://localhost:3300',
      token: 'tok',
      fetch: fakeFetch((url, init) => {
        seenUrl = url;
        seenMethod = init.method ?? '';
        return new Response('{"released":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    });
    await client.releaseLock('ws-1', 'acme:c.spec.prompt');
    expect(seenMethod).toBe('DELETE');
    expect(seenUrl).toBe('http://localhost:3300/api/v1/workspaces/ws-1/nodes/acme%3Ac.spec.prompt/lock');
  });
});

describe('GlmClient.updateNodeBody', () => {
  test('PUTs {body: ...} to nodes/:glm_id and unwraps {node}', async () => {
    let seenMethod = '';
    let seenBody = '';
    const client = new GlmClient({
      baseUrl: 'http://localhost:3300',
      token: 'tok',
      fetch: fakeFetch((_url, init) => {
        seenMethod = init.method ?? '';
        seenBody = (init.body as string) ?? '';
        return new Response(JSON.stringify({ node: { glmId: 'acme:c', contentHash: 'sha256:xx' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    });
    const out = await client.updateNodeBody('ws-1', 'acme:c', { boundary: 'updated' });
    expect(seenMethod).toBe('PUT');
    expect(JSON.parse(seenBody)).toEqual({ body: { boundary: 'updated' } });
    expect(out.contentHash).toBe('sha256:xx');
  });
});

describe('GlmClient.getComponentSpec', () => {
  test('unwraps the {spec} envelope', async () => {
    const payload = {
      spec: {
        component: { glmId: 'acme:c' },
        specPrompt: { glmId: 'acme:c.spec.prompt' },
        specAcceptance: { glmId: 'acme:c.spec.acceptance' },
        outputs: [],
        contextBundle: { text: '', bindingHash: 'sha256:000' },
        hardConstraints: 'X',
        sourceDir: null,
        promptTemplate: '',
        verifierCommand: 'true',
      },
    };
    const client = new GlmClient({
      baseUrl: 'http://localhost:3300',
      token: 'tok',
      fetch: fakeFetch(() =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    });
    const out = await client.getComponentSpec('ws-1', 'acme:c');
    expect(out.component.glmId).toBe('acme:c');
    expect(out.verifierCommand).toBe('true');
  });
});
