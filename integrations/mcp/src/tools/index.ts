import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GlmClient } from '../lib/glm-client.ts';
import type { ResolvedConfig } from '../lib/config.ts';
import { runStatus, StatusInputSchema } from './status.ts';
import { ListComponentsInputSchema, runListComponents } from './list-components.ts';
import { GetNodeInputSchema, runGetNode } from './get-node.ts';
import { GetComponentSpecInputSchema, runGetComponentSpec } from './get-component-spec.ts';

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

  server.registerTool(
    'glm_list_components',
    {
      title: 'List components in a GLM workspace',
      description:
        'Enumerate every component (stratum=component) in the workspace, ' +
        'returning one line per component: `glm_id — title (revisionStatus)`.',
      inputSchema: ListComponentsInputSchema,
    },
    async (args) => runListComponents(args, deps),
  );

  server.registerTool(
    'glm_get_node',
    {
      title: 'Get a GLM sekkei node by glm_id',
      description:
        'Fetch a single sekkei node, including its body, parameters, constraints, ' +
        'and outbound relationships. Output is a JSON code block.',
      inputSchema: GetNodeInputSchema,
    },
    async (args) => runGetNode(args, deps),
  );

  server.registerTool(
    'glm_get_component_spec',
    {
      title: 'Resolve a component generation spec',
      description:
        "Compose a component's full generation spec: its spec.prompt + " +
        'spec.acceptance, the resolved context bundle (every glm_id ref → that ' +
        "node's body), the outputs list, the hard-constraints suffix, and the " +
        "workspace's source_dir. Use this as the input for driving code generation.",
      inputSchema: GetComponentSpecInputSchema,
    },
    async (args) => runGetComponentSpec(args, deps),
  );
}
