import { z } from 'zod';
import type { GlmClient } from '../lib/glm-client.ts';
import type { ResolvedConfig } from '../lib/config.ts';
import type { ToolTextResult } from './status.ts';

/**
 * `glm_get_component_spec` — the load-bearing tool for `/glm-generate`.
 *
 * Returns the resolved generation spec for a component: its spec.prompt,
 * spec.acceptance, the resolved context bundle (every glm_id ref → that
 * node's body), the outputs list, the hard-constraints suffix, and the
 * workspace's source_dir. Claude Code uses this payload to drive generation
 * locally, then calls `glm_record_generation` to attest the result.
 *
 * The output is structured text with clearly-labeled sections so the LLM
 * can follow it without parsing JSON. The full `prompt_template` and
 * `context_bundle.text` are included verbatim — they're the authoritative
 * guidance.
 */

export const GetComponentSpecInputSchema = {
  component_id: z
    .string()
    .min(1)
    .describe('Component glm_id, e.g. `petco:web.shop.cart.cart_manager`.'),
  workspace: z
    .string()
    .min(1)
    .optional()
    .describe('Workspace id or slug. Defaults to the workspace from ~/.glm/config.json.'),
} as const;

export interface GetComponentSpecInput {
  component_id: string;
  workspace?: string;
}

export async function runGetComponentSpec(
  input: GetComponentSpecInput,
  deps: { client: GlmClient; config: ResolvedConfig },
): Promise<ToolTextResult> {
  const workspace = input.workspace ?? deps.config.workspace;
  const spec = await deps.client.getComponentSpec(workspace, input.component_id);

  const sections: string[] = [];

  sections.push(`# Component: ${spec.component.glmId}`);
  sections.push(`Title: ${spec.component.title}`);
  if (spec.sourceDir) {
    sections.push(`Source dir: ${spec.sourceDir}`);
  } else {
    sections.push(
      `Source dir: (not set — Claude should ask the user where to write files, or refuse)`,
    );
  }
  sections.push('');

  sections.push(`## Outputs (${spec.outputs.length} files)`);
  for (const o of spec.outputs) {
    sections.push(`  - ${o.path}${o.description ? ` — ${o.description}` : ''}`);
  }
  sections.push('');

  sections.push('## Verifier');
  sections.push(`  command: ${spec.verifierCommand}`);
  sections.push('');

  sections.push('## Prompt template');
  sections.push(spec.promptTemplate || '(none)');
  sections.push('');

  sections.push('## Context bundle');
  sections.push(spec.contextBundle.text || '(empty)');
  sections.push('');

  sections.push('## Hard constraints');
  sections.push(spec.hardConstraints);
  sections.push('');

  sections.push('## Spec metadata');
  sections.push(`  binding_hash:           ${spec.contextBundle.bindingHash}`);
  sections.push(`  component_content_hash: ${spec.component.contentHash}`);
  sections.push(`  prompt_content_hash:    ${spec.specPrompt.contentHash}`);
  sections.push(`  acceptance_content_hash:${spec.specAcceptance.contentHash}`);

  return { content: [{ type: 'text', text: sections.join('\n') }] };
}
