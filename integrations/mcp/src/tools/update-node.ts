import { z } from 'zod';
import type { ResolvedConfig } from '../lib/config.ts';
import type { GlmClient } from '../lib/glm-client.ts';
import type { ToolTextResult } from './status.ts';

/**
 * `glm_update_node` — revise an existing sekkei node in place: envelope,
 * body, and the graph wiring.
 *
 * `glm_create_node` can only ever add, and `glm_apply_patch` reaches only into
 * `body`. Neither can fix a mis-wired edge, move a node, or correct a stratum,
 * which left an authoring session that made a structural mistake with no way
 * out: re-creating collides with UNIQUE(workspace_id, glm_id). This tool closes
 * that gap.
 *
 * Omitted fields keep their stored values — including relationships,
 * parameters and constraints, which are replaced wholesale only when supplied.
 * Pass `new_glm_id` to rename (and thereby re-home) a node.
 */

const RelationshipSchema = z.object({
  kind: z
    .enum(['composes-of', 'depends-on', 'derives-from', 'implements', 'generates', 'varies-from'])
    .describe('Edge kind. Use composes-of for parent->child hierarchy.'),
  target_glm_id: z.string().min(1).describe('Target node glm_id or PURL (e.g. pkg:npm/hono@4).'),
  ord: z.number().int().optional().describe('Order among siblings; defaults to array index.'),
  attributes: z
    .record(z.any())
    .nullable()
    .optional()
    .describe('Edge attributes, e.g. {find_number: "1.0"}.'),
});

export const UpdateNodeInputSchema = {
  workspace: z
    .string()
    .min(1)
    .optional()
    .describe('Workspace id or slug. Defaults to the workspace from ~/.glm/config.json.'),
  glm_id: z.string().min(1).describe('The glm_id of the node to update.'),
  new_glm_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Rename the node to this glm_id. Note that gate 5 attributes specs to components ' +
        'by dotted prefix, so renaming is how a spec is re-homed onto a component.',
    ),
  title: z.string().min(1).optional().describe('Short human label.'),
  description: z.string().optional().describe('What the node IS and IS NOT responsible for.'),
  body: z
    .record(z.any())
    .optional()
    .describe('Replacement stratum-specific body (see docs/sekkei-authoring.md §5/§6).'),
  stratum: z
    .enum(['system', 'capability', 'component', 'interaction', 'spec'])
    .optional()
    .describe('Correct the stratum. The body must match the new stratum.'),
  spec_kind: z
    .enum(['functional', 'technical', 'schema', 'business_rule', 'acceptance', 'prompt'])
    .nullable()
    .optional()
    .describe('Required when stratum=spec; null otherwise.'),
  system_role: z
    .enum(['root', 'subsystem'])
    .nullable()
    .optional()
    .describe('Required when stratum=system (root | subsystem).'),
  relationships: z
    .array(RelationshipSchema)
    .optional()
    .describe(
      'REPLACES every outbound edge on this node. Omit to keep the existing edges; ' +
        'pass [] to clear them. composes-of is directed parent->child and lives on the parent.',
    ),
  parameters: z
    .array(z.record(z.any()))
    .optional()
    .describe('REPLACES declared parameters. Omit to keep them.'),
  constraints: z
    .array(z.record(z.any()))
    .optional()
    .describe('REPLACES CEL constraints. Omit to keep them.'),
  revision_major: z.string().optional().describe('ASME Y14.35 letter.'),
  revision_status: z
    .enum(['in_work', 'in_review', 'released', 'superseded', 'obsolete'])
    .optional()
    .describe('Revision status.'),
} as const;

export interface UpdateNodeInput {
  workspace?: string;
  glm_id: string;
  new_glm_id?: string;
  title?: string;
  description?: string;
  body?: Record<string, unknown>;
  stratum?: 'system' | 'capability' | 'component' | 'interaction' | 'spec';
  spec_kind?:
    | 'functional'
    | 'technical'
    | 'schema'
    | 'business_rule'
    | 'acceptance'
    | 'prompt'
    | null;
  system_role?: 'root' | 'subsystem' | null;
  relationships?: Array<{
    kind: string;
    target_glm_id: string;
    ord?: number;
    attributes?: Record<string, unknown> | null;
  }>;
  parameters?: Array<Record<string, unknown>>;
  constraints?: Array<Record<string, unknown>>;
  revision_major?: string;
  revision_status?: string;
}

export async function runUpdateNode(
  input: UpdateNodeInput,
  deps: { client: GlmClient; config: ResolvedConfig },
): Promise<ToolTextResult> {
  const workspace = input.workspace ?? deps.config.workspace;

  // Build the patch from present keys only: a key set to `undefined` would be
  // dropped by JSON.stringify anyway, but being explicit keeps "omitted means
  // keep" true at this layer rather than by accident downstream.
  const patch: Record<string, unknown> = {};
  if (input.new_glm_id !== undefined) patch.glmId = input.new_glm_id;
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.body !== undefined) patch.body = input.body;
  if (input.stratum !== undefined) patch.stratum = input.stratum;
  if (input.spec_kind !== undefined) patch.specKind = input.spec_kind;
  if (input.system_role !== undefined) patch.systemRole = input.system_role;
  if (input.revision_major !== undefined) patch.revisionMajor = input.revision_major;
  if (input.revision_status !== undefined) patch.revisionStatus = input.revision_status;
  if (input.parameters !== undefined) patch.parameters = input.parameters;
  if (input.constraints !== undefined) patch.constraints = input.constraints;
  if (input.relationships !== undefined) {
    patch.relationships = input.relationships.map((r, i) => ({
      kind: r.kind,
      targetGlmId: r.target_glm_id,
      ord: r.ord ?? i,
      attributes: r.attributes ?? null,
    }));
  }

  // The lock is advisory but the server enforces it against *other* holders, so
  // take it for the duration of the write, exactly as glm_apply_patch does.
  await deps.client.acquireLock(workspace, input.glm_id);
  let node: Awaited<ReturnType<GlmClient['updateNode']>> | undefined;
  try {
    node = await deps.client.updateNode(workspace, input.glm_id, patch);
  } finally {
    // Release by whatever glm_id the node answers to now: a rename makes the
    // original id a 404, which would strand the lock until it expires.
    await deps.client.releaseLock(workspace, node?.glmId ?? input.glm_id).catch(() => {
      /* a failed release must not mask a write error; the lock times out anyway */
    });
  }

  const changed = Object.keys(patch);
  const renamed = input.new_glm_id ? ` (renamed from ${input.glm_id})` : '';
  return {
    content: [
      {
        type: 'text',
        text:
          `Updated ${node.stratum} '${node.glmId}'${renamed} — ` +
          `${changed.length === 0 ? 'no fields changed' : `set ${changed.join(', ')}`}. ` +
          `Now rev ${node.revisionMajor}.${node.revisionIteration}, ${node.contentHash}.`,
      },
    ],
  };
}
