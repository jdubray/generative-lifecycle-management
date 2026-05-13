import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GlmClient } from '../lib/glm-client.ts';
import type { ResolvedConfig } from '../lib/config.ts';
import { runStatus, StatusInputSchema } from './status.ts';
import { ListComponentsInputSchema, runListComponents } from './list-components.ts';
import { GetNodeInputSchema, runGetNode } from './get-node.ts';
import { GetComponentSpecInputSchema, runGetComponentSpec } from './get-component-spec.ts';
import { runVerify, VerifyInputSchema } from './verify.ts';
import {
  RunAcceptanceVerifierInputSchema,
  runRunAcceptanceVerifier,
} from './run-acceptance-verifier.ts';
import { RecordGenerationInputSchema, runRecordGeneration } from './record-generation.ts';
import { ApplyPatchInputSchema, runApplyPatch } from './apply-patch.ts';

/**
 * Register every GLM tool against the provided MCP server instance. Kept
 * separate from `bin/glm-mcp.ts` so the registration is unit-testable
 * (a fake McpServer can record what was registered).
 */
export function registerTools(
  server: McpServer,
  deps: { client: GlmClient; config: ResolvedConfig },
): void {
  server.registerTool(
    'glm_status',
    {
      title: 'GLM workspace status',
      description:
        'Return a summary of the current GLM workspace: node counts by stratum, ' +
        'SCR counts by status, drift counts, and the last verifier run.',
      inputSchema: StatusInputSchema,
    },
    async (args) => runStatus(args, deps),
  );

  server.registerTool(
    'glm_list_components',
    {
      title: 'List components in a GLM workspace',
      description:
        'Enumerate every component (stratum=component) in the workspace, ' +
        'returning one line per component: `glm_id — title (revisionStatus)`.',
      inputSchema: ListComponentsInputSchema,
    },
    async (args) => runListComponents(args, deps),
  );

  server.registerTool(
    'glm_get_node',
    {
      title: 'Get a GLM sekkei node by glm_id',
      description:
        'Fetch a single sekkei node, including its body, parameters, constraints, ' +
        'and outbound relationships. Output is a JSON code block.',
      inputSchema: GetNodeInputSchema,
    },
    async (args) => runGetNode(args, deps),
  );

  server.registerTool(
    'glm_get_component_spec',
    {
      title: 'Resolve a component generation spec',
      description:
        "Compose a component's full generation spec: its spec.prompt + " +
        'spec.acceptance, the resolved context bundle (every glm_id ref → that ' +
        "node's body), the outputs list, the hard-constraints suffix, and the " +
        "workspace's source_dir. Use this as the input for driving code generation.",
      inputSchema: GetComponentSpecInputSchema,
    },
    async (args) => runGetComponentSpec(args, deps),
  );

  server.registerTool(
    'glm_verify',
    {
      title: 'Run the 7-gate sekkei verifier',
      description:
        'Run the workspace verifier (envelope, stratum hierarchy, role consistency, ' +
        'closure completeness, brief coverage, spec coverage, spec quality). ' +
        'Returns overall pass/fail plus per-gate detail with issues. Pure code, no LLM.',
      inputSchema: VerifyInputSchema,
    },
    async (args) => runVerify(args, deps),
  );

  server.registerTool(
    'glm_run_acceptance_verifier',
    {
      title: 'Run a component acceptance verifier',
      description:
        "Execute the component's sekkei-authored verifier.command (from " +
        'spec.acceptance) via the platform shell, with cwd = workspace source_dir. ' +
        'Used after code generation to confirm the produced files pass the ' +
        "component's tests. Returns exit code + stdout/stderr (tail-truncated).",
      inputSchema: RunAcceptanceVerifierInputSchema,
    },
    async (args) => runRunAcceptanceVerifier(args, deps),
  );

  server.registerTool(
    'glm_record_generation',
    {
      title: 'Record a completed MCP-driven generation',
      description:
        'Attest that Claude Code generated the listed files for a component, ' +
        'and that the acceptance verifier returned `verifier_exit_code`. Inserts ' +
        'a provenance row + audit row on the server so the generation appears in ' +
        'the UI and can be diffed against future regenerations. Returns the ' +
        'inserted provenance.',
      inputSchema: RecordGenerationInputSchema,
    },
    async (args) => runRecordGeneration(args, deps),
  );

  server.registerTool(
    'glm_apply_patch',
    {
      title: 'Apply an RFC-6902 JSON Patch to a sekkei node body',
      description:
        'Patch a node body with one or more JSON-Patch ops (add / remove / replace / move). ' +
        "The MCP server fetches the current node, applies the patch locally, " +
        'acquires the edit lock, PUTs the new body, and releases the lock. ' +
        'Used by refine flows when Claude knows what to change but rewriting the ' +
        'whole body would be wasteful.',
      inputSchema: ApplyPatchInputSchema,
    },
    async (args) => runApplyPatch(args, deps),
  );
}
