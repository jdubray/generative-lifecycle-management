import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GlmClient } from '../lib/glm-client.ts';
import type { ResolvedConfig } from '../lib/config.ts';
import { runStatus, StatusInputSchema } from './status.ts';

/**
 * Register every GLM tool against the provided MCP server instance. Kept
 * separate from `bin/glm-mcp.ts` so the registration is unit-testable
 * (a fake McpServer can record what was registered).
 */
export function registerTools(
  server: McpServer,
  deps: { client: GlmClient; config: ResolvedConfig },
): void {
  server.registerTool(
    'glm_status',
    {
      title: 'GLM workspace status',
      description:
        'Return a summary of the current GLM workspace: node counts by stratum, ' +
        'SCR counts by status, drift counts, and the last verifier run.',
      inputSchema: StatusInputSchema,
    },
    async (args) => runStatus(args, deps),
  );
}
