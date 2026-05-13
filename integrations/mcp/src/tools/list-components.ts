import { z } from 'zod';
import type { GlmClient } from '../lib/glm-client.ts';
import type { ResolvedConfig } from '../lib/config.ts';
import type { ToolTextResult } from './status.ts';

/**
 * `glm_list_components` — enumerate every component in the workspace so
 * Claude Code can show the user a picker, or so it can iterate over
 * components programmatically (e.g. "verify each component in turn").
 *
 * Returns a one-line-per-component text block: `glmId — title (status)`.
 */

export const ListComponentsInputSchema = {
  workspace: z
    .string()
    .min(1)
    .optional()
    .describe('Workspace id or slug. Defaults to the workspace from ~/.glm/config.json.'),
} as const;

export interface ListComponentsInput {
  workspace?: string;
}

export async function runListComponents(
  input: ListComponentsInput,
  deps: { client: GlmClient; config: ResolvedConfig },
): Promise<ToolTextResult> {
  const workspace = input.workspace ?? deps.config.workspace;
  const { nodes } = await deps.client.listNodes(workspace, { stratum: 'component' });

  if (nodes.length === 0) {
    return { content: [{ type: 'text', text: '(no components in this workspace)' }] };
  }

  const lines = [`${nodes.length} component${nodes.length === 1 ? '' : 's'} in workspace ${workspace}:`, ''];
  for (const node of nodes) {
    const title = node.title || '(no title)';
    lines.push(`  ${node.glmId} — ${title} (${node.revisionStatus})`);
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
