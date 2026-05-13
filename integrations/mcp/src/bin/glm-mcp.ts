#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveConfig } from '../lib/config.ts';
import { GlmClient } from '../lib/glm-client.ts';
import { registerTools } from '../tools/index.ts';
import { VERSION } from '../lib/version.ts';

/**
 * Stdio MCP server entry point. Claude Code launches this binary when the
 * user has an `mcpServers.glm` entry in `.claude/settings.json`. The MCP
 * transport speaks newline-delimited JSON over stdin/stdout — therefore
 * NOTHING in this process may write to stdout except the MCP framing.
 * All diagnostics go to stderr.
 */

async function main(): Promise<void> {
  const config = resolveConfig();
  const client = new GlmClient({ baseUrl: config.baseUrl, token: config.token });

  const server = new McpServer({ name: 'glm-mcp', version: VERSION });
  registerTools(server, { client, config });

  // Hand stdio to the MCP transport. After this awaits, the process stays
  // alive until the host (Claude Code) closes the pipe.
  await server.connect(new StdioServerTransport());
  process.stderr.write(`glm-mcp ${VERSION} ready (baseUrl=${config.baseUrl})\n`);
}

main().catch((err) => {
  process.stderr.write(`glm-mcp: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
