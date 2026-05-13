import { z } from 'zod';
import type { GlmClient } from '../lib/glm-client.ts';
import type { ResolvedConfig } from '../lib/config.ts';
import type { ToolTextResult } from './status.ts';

/**
 * `glm_verify` — run the workspace's 7-gate sekkei verifier and render the
 * result. Each gate is a pure-code check on the sekkei structure (envelope,
 * stratum hierarchy, role consistency, closure completeness, brief coverage,
 * spec coverage, spec quality). No LLM involved.
 *
 * Returns a text block summarizing overall pass/fail plus a per-gate
 * breakdown with issue counts; full issue text appears for any failing gate.
 */

export const VerifyInputSchema = {
  workspace: z
    .string()
    .min(1)
    .optional()
    .describe('Workspace id or slug. Defaults to the workspace from ~/.glm/config.json.'),
} as const;

export interface VerifyInput {
  workspace?: string;
}

export async function runVerify(
  input: VerifyInput,
  deps: { client: GlmClient; config: ResolvedConfig },
): Promise<ToolTextResult> {
  const workspace = input.workspace ?? deps.config.workspace;
  const run = await deps.client.runVerifier(workspace);

  const gates = run.gateResults.gates;
  const passed = gates.filter((g) => g.passed).length;
  const failed = gates.filter((g) => !g.passed);

  const lines: string[] = [];
  lines.push(`Verifier run ${run.id}`);
  lines.push(`Workspace:  ${workspace}`);
  lines.push(`Result:     ${run.overallPass ? 'PASS' : 'FAIL'}  (${passed}/${gates.length} gates)`);
  lines.push(`Completed:  ${run.ts}`);
  lines.push('');

  for (const g of gates) {
    const mark = g.passed ? 'PASS' : 'FAIL';
    lines.push(`[${mark}] ${g.name}${g.issues.length ? `  (${g.issues.length} issue${g.issues.length === 1 ? '' : 's'})` : ''}`);
  }

  if (failed.length > 0) {
    lines.push('');
    lines.push('Failure detail:');
    for (const g of failed) {
      lines.push(`  ${g.name}:`);
      for (const issue of g.issues) {
        lines.push(`    - ${issue}`);
      }
    }
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
