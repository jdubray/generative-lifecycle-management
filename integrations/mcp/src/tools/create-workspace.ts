import { z } from 'zod';
import type { GlmClient } from '../lib/glm-client.ts';
import type { ResolvedConfig } from '../lib/config.ts';
import type { ToolTextResult } from './status.ts';

/**
 * `glm_create_workspace` — create a new, empty workspace to author a sekkei
 * into. The companion to `glm_create_node`: bootstrap the workspace, then
 * author nodes node-by-node. Lets a Claude Code session start a brand-new
 * project entirely in-session, with no `glm vibe` / `claude -p` subprocess.
 */

export const CreateWorkspaceInputSchema = {
  slug: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,63}$/, 'slug must match ^[a-z][a-z0-9-]{0,63}$')
    .describe('Workspace slug — lowercase, starts with a letter, [a-z0-9-], <=64 chars.'),
  name: z
    .string()
    .min(1)
    .optional()
    .describe('Human-readable workspace name. Defaults to the slug.'),
} as const;

export interface CreateWorkspaceInput {
  slug: string;
  name?: string;
}

export async function runCreateWorkspace(
  input: CreateWorkspaceInput,
  deps: { client: GlmClient; config: ResolvedConfig },
): Promise<ToolTextResult> {
  const ws = await deps.client.createWorkspace(input.slug, input.name);
  return {
    content: [
      {
        type: 'text',
        text:
          `Created workspace '${ws.slug}' (id ${ws.id}).\n` +
          `Author nodes into it with glm_create_node (pass workspace: "${ws.slug}").`,
      },
    ],
  };
}
