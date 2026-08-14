import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type TestServer, makeTestServer } from './helpers.ts';

/**
 * The MCP endpoint speaks JSON-RPC 2.0 over Streamable HTTP. These tests drive
 * it at the wire level — the same bytes a Claude Code client sends — rather
 * than calling the tool functions, so a break in the transport wiring, the
 * loopback client or the auth pass-through shows up here.
 */

const PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

describe('MCP over Streamable HTTP', () => {
  let s: TestServer;
  beforeEach(() => {
    s = makeTestServer();
  });
  afterEach(() => s.db.close());

  /** POST one JSON-RPC message and parse the JSON response. */
  const rpc = async (
    body: Record<string, unknown>,
    opts: { query?: string; auth?: boolean } = {},
  ): Promise<{ status: number; message: JsonRpcResponse }> => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // The transport requires the client to accept both shapes.
      accept: 'application/json, text/event-stream',
    };
    if (opts.auth !== false) headers['x-test-user-id'] = 'user-1';
    const res = await s.app.request(`/mcp${opts.query ?? ''}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return {
      status: res.status,
      message: text ? (JSON.parse(text) as JsonRpcResponse) : ({} as JsonRpcResponse),
    };
  };

  const initialize = (): Promise<{ status: number; message: JsonRpcResponse }> =>
    rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    });

  test('initialize returns the GLM server identity and tool capability', async () => {
    const { status, message } = await initialize();
    expect(status).toBe(200);
    const result = message.result as {
      serverInfo: { name: string };
      capabilities: Record<string, unknown>;
    };
    expect(result.serverInfo.name).toBe('glm');
    expect(result.capabilities.tools).toBeDefined();
  });

  test('tools/list advertises the full GLM tool surface', async () => {
    await initialize();
    const { message } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = (message.result as { tools: Array<{ name: string; description: string }> }).tools;
    const names = tools.map((t) => t.name);

    expect(names).toContain('glm_create_node');
    expect(names).toContain('glm_update_node');
    expect(names).toContain('glm_delete_node');
    expect(names).toContain('glm_verify');
    expect(names).toHaveLength(12);
    // Descriptions travel to the model; an empty one is a silent regression.
    for (const t of tools) expect(t.description.length).toBeGreaterThan(0);
  });

  test('tools/call round-trips through the loopback client to the REST layer', async () => {
    await initialize();
    const { message } = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'glm_create_node',
        arguments: {
          workspace: 'ws-1',
          glm_id: 'glm:component.cart',
          stratum: 'component',
          title: 'Cart',
          body: { boundary: 'cart', runtime: 'es2022' },
        },
      },
    });

    const result = message.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("component 'glm:component.cart'");

    // The node really landed in the database, via the real POST /nodes route.
    const got = await s.request('GET', '/api/v1/workspaces/ws-1/nodes/glm:component.cart');
    expect(got.status).toBe(200);
  });

  test('the ?workspace= query supplies the default workspace', async () => {
    await initialize();
    const { message } = await rpc(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'glm_create_node',
          arguments: {
            glm_id: 'glm:component.implicit',
            stratum: 'component',
            title: 'Implicit',
            body: { boundary: 'b', runtime: 'r' },
          },
        },
      },
      { query: '?workspace=ws-1' },
    );

    expect((message.result as { isError?: boolean }).isError).toBeFalsy();
    expect(
      (await s.request('GET', '/api/v1/workspaces/ws-1/nodes/glm:component.implicit')).status,
    ).toBe(200);
  });

  test('an unauthenticated caller is rejected before reaching the protocol', async () => {
    const res = await s.app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  test('a failing tool reports the error through MCP rather than throwing', async () => {
    await initialize();
    const { message } = await rpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'glm_get_node',
        arguments: { workspace: 'ws-1', glm_id: 'glm:does.not.exist' },
      },
    });

    const result = message.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not found|404/i);
  });
});
