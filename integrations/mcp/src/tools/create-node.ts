import { z } from 'zod';
import type { GlmClient } from '../lib/glm-client.ts';
import type { ResolvedConfig } from '../lib/config.ts';
import type { ToolTextResult } from './status.ts';

/**
 * `glm_create_node` — author one sekkei node (envelope + body + edges) directly
 * from the Claude Code session. This is the in-session authoring primitive: the
 * model and the user shape the sekkei conversationally, and each call writes a
 * node to the server, which publishes a `node.changed` event so an open GLM
 * dashboard reflects it in near-real-time.
 *
 * Tool inputs are snake_case (the MCP convention here); they are mapped to the
 * server's camelCase node shape. Revision defaults (major A, status in_work,
 * override net_new) are applied server-side when omitted.
 */

const RelationshipSchema = z.object({
  kind: z
    .enum(['composes-of', 'depends-on', 'derives-from', 'implements', 'generates', 'varies-from'])
    .describe('Edge kind. Use composes-of for parent->child hierarchy.'),
  target_glm_id: z.string().min(1).describe('Target node glm_id or PURL (e.g. pkg:npm/hono@4).'),
  ord: z.number().int().optional().describe('Order among siblings; defaults to array index.'),
  attributes: z.record(z.any()).nullable().optional().describe('Edge attributes, e.g. {find_number: "1.0"}.'),
});

export const CreateNodeInputSchema = {
  workspace: z
    .string()
    .min(1)
    .optional()
    .describe('Workspace id or slug. Defaults to the workspace from ~/.glm/config.json.'),
  glm_id: z.string().min(1).describe('The node id, e.g. acme:web.shop.cart.cart_manager.'),
  stratum: z
    .enum(['system', 'capability', 'component', 'interaction', 'spec'])
    .describe('Where the node sits in the hierarchy.'),
  title: z.string().min(1).describe('Short human label.'),
  description: z.string().optional().describe('What the node IS and IS NOT responsible for.'),
  body: z
    .record(z.any())
    .describe('Stratum-specific body object (see docs/sekkei-authoring.md §5/§6).'),
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
    .describe('Outbound edges. composes-of wires the parent->child tree.'),
  parameters: z.array(z.record(z.any())).optional().describe('Declared parameters (see §7).'),
  constraints: z.array(z.record(z.any())).optional().describe('CEL constraints (see §8).'),
  revision_major: z.string().optional().describe('ASME Y14.35 letter; defaults to A.'),
  revision_status: z
    .enum(['in_work', 'in_review', 'released', 'superseded', 'obsolete'])
    .optional()
    .describe('Defaults to in_work.'),
  override_kind: z
    .enum(['as_is', 'with_override', 'extend', 'net_new'])
    .optional()
    .describe('Inheritance op; defaults to net_new.'),
} as const;

export interface CreateNodeInput {
  workspace?: string;
  glm_id: string;
  stratum: 'system' | 'capability' | 'component' | 'interaction' | 'spec';
  title: string;
  description?: string;
  body: Record<string, unknown>;
  spec_kind?: 'functional' | 'technical' | 'schema' | 'business_rule' | 'acceptance' | 'prompt' | null;
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
  override_kind?: string;
}

export async function runCreateNode(
  input: CreateNodeInput,
  deps: { client: GlmClient; config: ResolvedConfig },
): Promise<ToolTextResult> {
  const workspace = input.workspace ?? deps.config.workspace;
  const node = await deps.client.createNode(workspace, {
    glmId: input.glm_id,
    stratum: input.stratum,
    title: input.title,
    description: input.description,
    body: input.body,
    revisionMajor: input.revision_major,
    revisionStatus: input.revision_status,
    overrideKind: input.override_kind,
    systemRole: input.system_role,
    specKind: input.spec_kind,
    relationships: input.relationships?.map((r, i) => ({
      kind: r.kind,
      targetGlmId: r.target_glm_id,
      ord: r.ord ?? i,
      attributes: r.attributes ?? null,
    })),
    parameters: input.parameters,
    constraints: input.constraints,
  });
  const edgeCount = input.relationships?.length ?? 0;
  return {
    content: [
      {
        type: 'text',
        text:
          `Created ${node.stratum} '${node.glmId}' (rev ${node.revisionMajor}.${node.revisionIteration}, ` +
          `${edgeCount} edge${edgeCount === 1 ? '' : 's'}, ${node.contentHash}).`,
      },
    ],
  };
}
