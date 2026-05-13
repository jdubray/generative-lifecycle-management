import { z } from 'zod';
import type { GlmClient } from '../lib/glm-client.ts';
import type { ResolvedConfig } from '../lib/config.ts';
import type { ToolTextResult } from './status.ts';

/**
 * `glm_get_node` — fetch a single sekkei node by its glm_id. Returns the
 * full `NodeWithChildren` payload as a JSON code block so Claude can parse
 * it back if needed. The bulk of the useful content lives in `node.body`,
 * which is shape-dependent on stratum (see docs/sekkei-authoring.md).
 */

export const GetNodeInputSchema = {
  glm_id: z.string().min(1).describe('Sekkei glm_id, e.g. `acme:web.shop.cart.cart_manager`.'),
  workspace: z
    .string()
    .min(1)
    .optional()
    .describe('Workspace id or slug. Defaults to the workspace from ~/.glm/config.json.'),
} as const;

export interface GetNodeInput {
  glm_id: string;
  workspace?: string;
}

export async function runGetNode(
  input: GetNodeInput,
  deps: { client: GlmClient; config: ResolvedConfig },
): Promise<ToolTextResult> {
  const workspace = input.workspace ?? deps.config.workspace;
  const result = await deps.client.getNode(workspace, input.glm_id);

  // Render as a single JSON block. Claude handles JSON tool outputs well,
  // and this preserves all the fields (body shape varies by stratum).
  const text = '```json\n' + JSON.stringify(result, null, 2) + '\n```';
  return { content: [{ type: 'text', text }] };
}
