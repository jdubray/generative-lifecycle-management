import { z } from 'zod';
import type { ResolvedConfig } from '../lib/config.ts';
import type { GlmClient } from '../lib/glm-client.ts';
import type { ToolTextResult } from './status.ts';

/**
 * `glm_delete_node` — retire a sekkei node, or remove it outright.
 *
 * Two modes, because they solve different problems:
 *
 *   - soft (default): marks `revision_status = obsolete` and keeps the row, so
 *     history and any inbound edges survive. This is retirement — the node was
 *     real and its record still matters.
 *
 *   - hard: deletes the row and sweeps every edge pointing at it. Needed when a
 *     node should never have existed, because a retained row keeps its
 *     UNIQUE(workspace_id, glm_id) and UNIQUE(workspace_id, content_hash)
 *     claims, and re-authoring the same node would collide with both.
 */

export const DeleteNodeInputSchema = {
  workspace: z
    .string()
    .min(1)
    .optional()
    .describe('Workspace id or slug. Defaults to the workspace from ~/.glm/config.json.'),
  glm_id: z.string().min(1).describe('The glm_id of the node to delete.'),
  hard: z
    .boolean()
    .optional()
    .describe(
      'false (default) marks the node obsolete and keeps the row. true removes it entirely ' +
        'and deletes every edge pointing at it, freeing the glm_id for re-authoring. ' +
        'Irreversible — prefer the default unless the node was created in error.',
    ),
} as const;

export interface DeleteNodeInput {
  workspace?: string;
  glm_id: string;
  hard?: boolean;
}

export async function runDeleteNode(
  input: DeleteNodeInput,
  deps: { client: GlmClient; config: ResolvedConfig },
): Promise<ToolTextResult> {
  const workspace = input.workspace ?? deps.config.workspace;
  const hard = input.hard === true;
  const result = await deps.client.deleteNode(workspace, input.glm_id, { hard });

  const swept = result.inboundEdgesRemoved ?? 0;
  const text = hard
    ? `Hard-deleted '${input.glm_id}' — row removed, ${swept} inbound edge${swept === 1 ? '' : 's'} swept. The glm_id is free to re-author.`
    : `Marked '${input.glm_id}' ${result.revisionStatus ?? 'obsolete'} — the row and its edges are retained. Pass hard=true to remove it outright.`;

  return { content: [{ type: 'text', text }] };
}
