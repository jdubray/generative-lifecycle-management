import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Hono } from 'hono';
import { Hono as HonoCtor } from 'hono';
import { GlmClient } from '../../../integrations/mcp/src/lib/glm-client.ts';
import { registerTools } from '../../../integrations/mcp/src/tools/index.ts';
import { type AppEnv, requirePrincipal } from '../middleware/auth.ts';

/**
 * MCP over Streamable HTTP, served by the GLM server itself.
 *
 * The stdio MCP server (`integrations/mcp`) has to be launched as a
 * subprocess with a path to this repository, which means it only works for a
 * Claude Code session whose cwd *is* this repo. The GLM server is already a
 * long-running process on a known port, so serving MCP from it removes both
 * the subprocess and the path: a client anywhere on the machine points at
 * `http://localhost:<port>/mcp` and is done.
 *
 * Stateless: one `McpServer` + transport per request, no session id, JSON
 * responses rather than SSE. Sekkei authoring is a sequence of independent
 * tool calls with all state in SQLite, so there is nothing to keep between
 * requests, and statelessness means no session table to leak or expire.
 *
 * The tool implementations are reused verbatim from `integrations/mcp` — the
 * same twelve tools, the same tested request shapes. They speak to GLM over
 * HTTP, so this route hands them a `GlmClient` whose `fetch` dispatches back
 * into this same Hono app rather than out over a socket: no network hop, and
 * the caller's `Authorization` header rides along so the tools act as the
 * principal who called them, with the same RBAC as any other request.
 */

/** Query param (or `GLM_WORKSPACE`) naming the workspace tools default to. */
const WORKSPACE_PARAM = 'workspace';

/**
 * Origin the loopback client builds URLs against. Never resolved over the
 * network — `fetch` strips it and dispatches into the app directly — but the
 * client needs some absolute base to construct request URLs from.
 */
const LOOPBACK_ORIGIN = 'http://glm.internal';

export interface McpRouteOptions {
  /**
   * Returns the fully-built app, for the loopback client. A getter rather
   * than the app itself because the route is mounted while that app is still
   * being constructed.
   */
  getApp: () => Hono<AppEnv>;
}

export function mcpRoutes(opts: McpRouteOptions): Hono<AppEnv> {
  const app = new HonoCtor<AppEnv>();

  app.all('/mcp', async (c) => {
    // Authenticate before touching the protocol: an unauthenticated caller
    // should get a plain 401, not an MCP-shaped error.
    requirePrincipal(c);

    const authorization = c.req.header('authorization');
    const workspace = c.req.query(WORKSPACE_PARAM) ?? process.env.GLM_WORKSPACE ?? '';

    // Whatever proved who the caller is has to ride along on the loopback, or
    // every tool call arrives at the REST layer anonymous. `identify()`
    // accepts a bearer token, a session cookie, or the test header, so all
    // three are forwarded rather than just the one this deployment happens to
    // use.
    const forwarded: Record<string, string> = {};
    for (const name of ['authorization', 'cookie', 'x-test-user-id']) {
      const value = c.req.header(name);
      if (value) forwarded[name] = value;
    }

    const client = new GlmClient({
      baseUrl: LOOPBACK_ORIGIN,
      token: readBearer(authorization),
      fetch: (async (url: string | URL, init?: RequestInit) => {
        const path = String(url).replace(LOOPBACK_ORIGIN, '');
        const headers = new Headers(init?.headers);
        for (const [name, value] of Object.entries(forwarded)) headers.set(name, value);
        return opts.getApp().request(path, { ...init, headers });
      }) as unknown as typeof fetch,
    });

    const server = new McpServer({ name: 'glm', version: SERVER_VERSION });
    registerTools(server, {
      client,
      config: {
        port: 0,
        workspace,
        token: readBearer(authorization) ?? '',
        baseUrl: client.baseUrl,
      },
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } finally {
      // Per-request server and transport: close both so nothing accumulates
      // across calls. `close()` on an already-closed transport is a no-op.
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  return app;
}

const SERVER_VERSION = '0.1.0';

/** `Authorization: Bearer <token>` → `<token>`. */
function readBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}
