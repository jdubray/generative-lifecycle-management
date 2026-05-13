import { z } from 'zod';
import type { GlmClient } from '../lib/glm-client.ts';
import type { ResolvedConfig } from '../lib/config.ts';
import type { ToolTextResult } from './status.ts';

/**
 * `glm_record_generation` — close the loop on an MCP-driven generation.
 *
 * Called by Claude Code after it has written the generated files locally
 * and confirmed `glm_run_acceptance_verifier` passed. Inserts a provenance
 * row + audit row on the server so the generation is observable in the UI
 * and recoverable from the DB.
 *
 * The file `sha256`s and `bytes` are computed client-side (by Claude Code)
 * since the server never sees the generated content. The `bindingHash` is
 * the snapshot the LLM was generating against — pass it back so provenance
 * binds to the exact inputs that drove generation.
 */

const FileEntrySchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/i, 'must be `sha256:<64 hex chars>`'),
  bytes: z.number().int().nonnegative(),
});

export const RecordGenerationInputSchema = {
  component_id: z.string().min(1).describe('Component glm_id that was generated.'),
  files: z
    .array(FileEntrySchema)
    .min(1)
    .describe('Per-file content hashes. One entry per file Claude Code wrote.'),
  verifier_exit_code: z
    .number()
    .int()
    .describe('Exit code from glm_run_acceptance_verifier. 0 = pass.'),
  binding_hash: z
    .string()
    .optional()
    .describe(
      'sha256:... from the context bundle returned by glm_get_component_spec. ' +
        'When omitted the server uses the current binding hash (less precise).',
    ),
  generator_identity: z
    .string()
    .optional()
    .describe('Identifier for the model + tooling used, e.g. `claude-code/sonnet-4-6`.'),
  duration_ms: z.number().nonnegative().optional().describe('Wall time of the generation.'),
  note: z.string().optional().describe('Free-form provenance note.'),
  workspace: z.string().min(1).optional().describe('Workspace id or slug.'),
} as const;

export interface RecordGenerationInput {
  component_id: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  verifier_exit_code: number;
  binding_hash?: string;
  generator_identity?: string;
  duration_ms?: number;
  note?: string;
  workspace?: string;
}

export async function runRecordGeneration(
  input: RecordGenerationInput,
  deps: { client: GlmClient; config: ResolvedConfig },
): Promise<ToolTextResult> {
  const workspace = input.workspace ?? deps.config.workspace;
  const provenance = await deps.client.recordGeneration(workspace, {
    componentId: input.component_id,
    files: input.files,
    verifierExitCode: input.verifier_exit_code,
    bindingHash: input.binding_hash,
    generatorIdentity: input.generator_identity,
    durationMs: input.duration_ms,
    note: input.note ?? null,
  });

  const lines: string[] = [];
  lines.push(`Recorded provenance ${provenance.id}`);
  lines.push(`  workspace:           ${provenance.workspaceId}`);
  lines.push(`  component:           ${provenance.sekkeiRoot}`);
  lines.push(`  files:               ${input.files.length}`);
  lines.push(`  subject digest:      ${provenance.subjectDigest}`);
  lines.push(`  binding hash:        ${provenance.bindingHash}`);
  lines.push(`  sekkei revision:     ${provenance.sekkeiRev}`);
  lines.push(`  prompt version:      ${provenance.generatorPromptVersion}`);
  lines.push(`  generator:           ${provenance.generatorLlm}`);
  lines.push(`  duration:            ${provenance.durationMs} ms`);
  lines.push(`  occurred at:         ${provenance.occurredAt}`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
