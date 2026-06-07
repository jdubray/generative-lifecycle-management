import { z } from 'zod';
import type { GlmClient } from '../lib/glm-client.ts';
import type { ResolvedConfig } from '../lib/config.ts';

/**
 * Tool implementation for `glm_status`. Pure function — easy to unit-test
 * by passing a fake GlmClient. The MCP wiring lives in `tools/index.ts`.
 *
 * Returns the workspace summary as a single text block. Claude Code displays
 * tool text content directly, so JSON.stringify-with-indent is the right
 * shape for now; future polish could format the counts in a more readable
 * way.
 */

export const StatusInputSchema = {
  workspace: z
    .string()
    .min(1)
    .optional()
    .describe('Workspace id or slug. Defaults to the workspace from ~/.glm/config.json.'),
} as const;

export interface StatusInput {
  workspace?: string;
}

export interface ToolTextResult {
  content: Array<{ type: 'text'; text: string }>;
}

export async function runStatus(
  input: StatusInput,
  deps: { client: GlmClient; config: ResolvedConfig },
): Promise<ToolTextResult> {
  const workspace = input.workspace ?? deps.config.workspace;
  const summary = await deps.client.getWorkspaceSummary(workspace);

  // Render a compact, human-readable summary; LLMs handle this fine and humans
  // skimming the tool output find it easier than raw JSON.
  const lines: string[] = [];
  lines.push(`Workspace: ${summary.workspace.slug} (${summary.workspace.id})`);
  lines.push(`Name:      ${summary.workspace.name}`);
  lines.push('');
  lines.push(`Nodes by stratum (${summary.nodes.total} total):`);
  for (const [stratum, count] of Object.entries(summary.nodes.byStratum)) {
    lines.push(`  ${stratum.padEnd(12)} ${count}`);
  }
  lines.push('');
  lines.push(`SCRs by status (${summary.scrs.active} active):`);
  for (const [status, count] of Object.entries(summary.scrs.byStatus)) {
    lines.push(`  ${status.padEnd(12)} ${count}`);
  }
  if (summary.verifier) {
    lines.push('');
    lines.push('Last verifier run:');
    lines.push(`  passed: ${summary.verifier.overallPass}`);
    lines.push(`  ran at: ${summary.verifier.ts}`);
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
