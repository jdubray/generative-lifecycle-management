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
