import { z } from 'zod';
import type { GlmClient } from '../lib/glm-client.ts';
import type { ResolvedConfig } from '../lib/config.ts';
import { applyJsonPatch, type JsonPatchOp } from '../lib/json-patch.ts';
import type { ToolTextResult } from './status.ts';

/**
 * `glm_apply_patch` — apply an RFC-6902 JSON Patch to a node's body.
 *
 * The MCP server does the GET → patch → PUT dance, bracketed by an edit
 * lock acquire/release. The patch is computed locally in this process,
 * then the resulting body is sent back via the existing PUT route.
 *
 * Lock semantics:
 *   - Acquire before PUT (server returns 423 if held by another user).
 *   - Always release in a finally, even on PUT failure, so a transient
 *     server error doesn't leave the node uneditable.
 *
 * Supported ops: add, remove, replace, move. (See lib/json-patch.ts.)
 */

const JsonPatchOpSchema = z.object({
  op: z.enum(['add', 'remove', 'replace', 'move']),
  path: z.string(),
  value: z.unknown().optional(),
  from: z.string().optional(),
});

export const ApplyPatchInputSchema = {
  glm_id: z.string().min(1).describe('Sekkei glm_id of the node to patch.'),
  ops: z
    .array(JsonPatchOpSchema)
    .min(1)
    .describe('JSON-Patch ops to apply to the node body. RFC 6902 add/remove/replace/move.'),
  workspace: z.string().min(1).optional().describe('Workspace id or slug.'),
} as const;

export interface ApplyPatchInput {
  glm_id: string;
  ops: JsonPatchOp[];
  workspace?: string;
}

export async function runApplyPatch(
  input: ApplyPatchInput,
  deps: { client: GlmClient; config: ResolvedConfig },
): Promise<ToolTextResult> {
  const workspace = input.workspace ?? deps.config.workspace;

  // 1. Fetch the current node so we know what to patch.
  const current = await deps.client.getNode(workspace, input.glm_id);
  const beforeHash = current.node.contentHash;

  // 2. Apply the patch in-memory. JsonPatchError surfaces with a clear
  //    message including the offending op + JSON Pointer.
  const patchedBody = applyJsonPatch(current.node.body, input.ops);
  if (typeof patchedBody !== 'object' || patchedBody === null || Array.isArray(patchedBody)) {
    throw new Error('patched body is not a plain object — node bodies must be {…}');
  }

  // 3. Acquire the edit lock, PUT, release. Release runs in finally so a
  //    failure doesn't strand the lock.
  await deps.client.acquireLock(workspace, input.glm_id);
  let updated;
  try {
    updated = await deps.client.updateNodeBody(workspace, input.glm_id, patchedBody as Record<string, unknown>);
  } finally {
    try {
      await deps.client.releaseLock(workspace, input.glm_id);
    } catch {
      // best-effort; an orphaned lock will TTL out on the server.
    }
  }

  const lines: string[] = [];
  lines.push(`Patched ${updated.glmId}`);
  lines.push(`  ops applied:       ${input.ops.length}`);
  lines.push(`  contentHash before: ${beforeHash}`);
  lines.push(`  contentHash after:  ${updated.contentHash}`);
  lines.push(`  revision:           ${updated.revisionMajor}.${updated.revisionIteration}  (${updated.revisionStatus})`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
