import { describe, expect, test } from 'bun:test';
import { GlmClient } from '../../src/lib/glm-client.ts';
import { HttpError, ServerUnreachableError } from '../../src/lib/errors.ts';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GlmClient', () => {
  test('health() hits /api/v1/health and parses the response', async () => {
    const { fn, calls } = stubFetch(() => jsonResponse(200, { ok: true, service: 'glm', version: '1.0.0' }));
    const client = new GlmClient({ baseUrl: 'http://localhost:3000', fetch: fn });
    const result = await client.health();
    expect(result).toEqual({ ok: true, service: 'glm', version: '1.0.0' });
    expect(calls[0]?.url).toBe('http://localhost:3000/api/v1/health');
  });

  test('health() does not send Authorization even when a token is set', async () => {
    const { fn, calls } = stubFetch(() => jsonResponse(200, { ok: true, service: 'glm', version: '1.0.0' }));
    const client = new GlmClient({ baseUrl: 'http://localhost:3000', token: 'secret', fetch: fn });
    await client.health();
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  test('getWorkspace() sends Authorization: Bearer <token>', async () => {
    const { fn, calls } = stubFetch(() =>
      jsonResponse(200, { workspace: { id: 'ws-1', slug: 'test', name: 'Test' } }),
    );
    const client = new GlmClient({ baseUrl: 'http://localhost:3000', token: 't0k', fetch: fn });
    const ws = await client.getWorkspace('ws-1');
    expect(ws.id).toBe('ws-1');
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer t0k');
    expect(headers.Accept).toBe('application/json');
  });

  test('strips trailing slashes from baseUrl', () => {
    const c = new GlmClient({ baseUrl: 'http://localhost:3000//' });
    expect(c.baseUrl).toBe('http://localhost:3000');
  });

  test('throws ServerUnreachableError when fetch rejects (network error)', async () => {
    const { fn } = stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const client = new GlmClient({ baseUrl: 'http://localhost:9999', fetch: fn });
    await expect(client.health()).rejects.toBeInstanceOf(ServerUnreachableError);
  });

  test('throws HttpError with status code on non-2xx', async () => {
    const { fn } = stubFetch(() => jsonResponse(404, { error: 'not found' }));
    const client = new GlmClient({ baseUrl: 'http://localhost:3000', fetch: fn });
    try {
      await client.getWorkspace('missing');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      const err = e as HttpError;
      expect(err.status).toBe(404);
      expect(err.exitCode).toBe(66); // EX_NOINPUT for 404
    }
  });

  test('HttpError maps 401/403 to exit 77, others to 70', async () => {
    for (const [status, exit] of [
      [401, 77],
      [403, 77],
      [500, 70],
      [502, 70],
    ] as const) {
      const { fn } = stubFetch(() => jsonResponse(status, {}));
      const client = new GlmClient({ baseUrl: 'http://localhost:3000', token: 't', fetch: fn });
      try {
        await client.getWorkspace('x');
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as HttpError).exitCode).toBe(exit);
      }
    }
  });

  test('getWorkspaceSummary URL-encodes the workspace id', async () => {
    const { fn, calls } = stubFetch(() =>
      jsonResponse(200, {
        workspace: { id: 'has spaces', slug: 'x', name: 'X' },
        nodesByStratum: {},
        scrsByStatus: {},
        driftByStatus: {},
      }),
    );
    const client = new GlmClient({ baseUrl: 'http://localhost:3000', fetch: fn });
    await client.getWorkspaceSummary('has spaces');
    expect(calls[0]?.url).toBe('http://localhost:3000/api/v1/workspaces/has%20spaces/summary');
  });
});
