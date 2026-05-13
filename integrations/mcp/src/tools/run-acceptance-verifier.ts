import { z } from 'zod';
import type { GlmClient } from '../lib/glm-client.ts';
import type { ResolvedConfig } from '../lib/config.ts';
import type { ToolTextResult } from './status.ts';

/**
 * `glm_run_acceptance_verifier` — execute a component's sekkei-authored
 * `verifier.command` (from `spec.acceptance`) in the workspace's
 * source_dir. The command is resolved server-side from the sekkei, not
 * supplied by the caller, so this can't be used to run arbitrary shell.
 *
 * Returns a text block with the command, cwd, exit code, duration, and
 * (when present) stdout/stderr. Used by the /glm-generate flow after
 * Claude Code has written generated files.
 */

export const RunAcceptanceVerifierInputSchema = {
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

export interface RunAcceptanceVerifierInput {
  component_id: string;
  workspace?: string;
}

const TAIL_BYTES = 4000;

export async function runRunAcceptanceVerifier(
  input: RunAcceptanceVerifierInput,
  deps: { client: GlmClient; config: ResolvedConfig },
): Promise<ToolTextResult> {
  const workspace = input.workspace ?? deps.config.workspace;
  const result = await deps.client.runAcceptanceVerify(workspace, input.component_id);

  const lines: string[] = [];
  lines.push(`Acceptance verifier: ${result.exitCode === 0 ? 'PASS' : 'FAIL'}`);
  lines.push(`Component: ${input.component_id}`);
  lines.push(`Command:   ${result.command}`);
  lines.push(`Cwd:       ${result.cwd}`);
  lines.push(`Exit code: ${result.exitCode}`);
  lines.push(`Duration:  ${result.durationMs} ms`);

  if (result.stdout) {
    lines.push('');
    lines.push('Stdout:');
    lines.push(tail(result.stdout, TAIL_BYTES));
  }
  if (result.stderr) {
    lines.push('');
    lines.push('Stderr:');
    lines.push(tail(result.stderr, TAIL_BYTES));
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/**
 * Truncate to the final N bytes — for failing test output the tail is what
 * matters (where the error happened). A leading marker tells the reader
 * (LLM or human) that material was cut.
 */
function tail(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const buf = Buffer.from(s, 'utf8');
  const slice = buf.subarray(buf.length - maxBytes).toString('utf8');
  return `…(truncated to last ${maxBytes} bytes)\n${slice}`;
}
