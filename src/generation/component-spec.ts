import { createHash } from 'node:crypto';
import type { NodeRepository } from '../repository/node-repository.ts';
import type { WorkspaceRepository } from '../repository/workspace-repository.ts';
import type { SekkeiNode } from '../types.ts';

/**
 * Shared component-spec resolution.
 *
 * Extracted from `solo-generate.ts` so the MCP composite endpoint
 * (`GET /workspaces/:id/components/:glm_id/spec`) and the legacy
 * server-side `solo-generate` flow can both consume it without
 * duplication. Once the MCP fork retires `solo-generate.ts`
 * (Phase F), this module remains the authoritative source.
 *
 * Pure orchestration over repositories — no LLM calls, no file I/O.
 */

export class ComponentSpecError extends Error {
  public readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = 'ComponentSpecError';
    this.status = status;
  }
}

export interface PromptBody {
  context_bundle?: string[];
  outputs?: Array<{ path: string; description?: string }>;
  prompt_template?: string;
  verifier?: { command?: string; expect?: string };
}

export interface AcceptanceBody {
  verifier?: { command?: string; expect?: string };
}

export interface ContextBundle {
  text: string;
  bindingHash: string;
}

export interface ComponentSpecPayload {
  /** The component node itself. */
  component: SekkeiNode;
  /** `<component_glm_id>.spec.prompt` node. */
  specPrompt: SekkeiNode;
  /** `<component_glm_id>.spec.acceptance` node. */
  specAcceptance: SekkeiNode;
  /** Files Claude is expected to produce — from `specPrompt.body.outputs`. */
  outputs: Array<{ path: string; description?: string }>;
  /** Resolved context bundle: every glm_id ref → that node's body, joined as text. */
  contextBundle: ContextBundle;
  /** Constant prompt suffix enforcing the multi-file delimiter format. */
  hardConstraints: string;
  /** Workspace's source_dir for relative-path resolution; null if not set. */
  sourceDir: string | null;
  /** Convenience: the un-resolved prompt_template string from the spec.prompt body. */
  promptTemplate: string;
  /** Convenience: the acceptance verifier command (validated non-empty). */
  verifierCommand: string;
}

/**
 * Hard constraints appended to the LLM's system prompt. These define the
 * multi-file delimiter format the verifier expects. Surfaced as a constant
 * so the MCP composite endpoint can return it unchanged, and clients can
 * choose whether to embed it.
 */
export const HARD_CONSTRAINTS = `HARD CONSTRAINTS:
- Output ONLY file content. No prose explanation, no markdown fences.
- Begin every file with a header line: \`=== FILE: <path-from-outputs> ===\`
- Emit the files in the order listed in OUTPUTS below.
- Do NOT emit files not listed in OUTPUTS.
- Do NOT use absolute paths or '..' segments in file headers.
- After the last file, stop. Do not append commentary.`;

/** Bytes-soft-cap on resolved context bundle text — protects against runaway bundles. */
export const CONTEXT_BUNDLE_BYTE_CAP = 400_000;

/**
 * Compute the rolling SHA-256 of a sequence of per-file content hashes —
 * the `subject_digest` field on `provenance_events`. Order-sensitive: same
 * files in different order produce different aggregate digests.
 */
export function aggregateDigest(files: Array<{ sha256: string }>): string {
  if (files.length === 0) {
    return 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  }
  const h = createHash('sha256');
  for (const f of files) h.update(f.sha256);
  return `sha256:${h.digest('hex')}`;
}

export interface ResolveComponentSpecDeps {
  nodes: NodeRepository;
  workspaces: WorkspaceRepository;
}

/**
 * Compose a component's generation spec by resolving its child prompt +
 * acceptance nodes and rendering its context bundle. The caller (MCP route,
 * legacy solo-generate flow) decides what to do with the payload.
 */
export function resolveComponentSpec(
  deps: ResolveComponentSpecDeps,
  workspaceId: string,
  componentGlmId: string,
): ComponentSpecPayload {
  const workspace = deps.workspaces.findById(workspaceId);
  if (!workspace) {
    throw new ComponentSpecError(`workspace ${workspaceId} not found`, 404);
  }

  const componentFound = deps.nodes.findByGlmId(workspaceId, componentGlmId);
  if (!componentFound) {
    throw new ComponentSpecError(`component '${componentGlmId}' not found`, 404);
  }
  if (componentFound.node.stratum !== 'component') {
    throw new ComponentSpecError(
      `'${componentGlmId}' is stratum '${componentFound.node.stratum}', not 'component'`,
      422,
    );
  }

  const promptId = `${componentGlmId}.spec.prompt`;
  const promptFound = deps.nodes.findByGlmId(workspaceId, promptId);
  if (!promptFound) {
    throw new ComponentSpecError(`spec node '${promptId}' not found`, 422);
  }

  const acceptanceId = `${componentGlmId}.spec.acceptance`;
  const acceptanceFound = deps.nodes.findByGlmId(workspaceId, acceptanceId);
  if (!acceptanceFound) {
    throw new ComponentSpecError(`spec node '${acceptanceId}' not found`, 422);
  }

  const promptBody = promptFound.node.body as PromptBody;
  const acceptanceBody = acceptanceFound.node.body as AcceptanceBody;

  const outputs = Array.isArray(promptBody.outputs) ? promptBody.outputs : [];
  if (outputs.length === 0) {
    throw new ComponentSpecError(`spec.prompt for '${componentGlmId}' lists no outputs`, 422);
  }
  const verifierCommand = acceptanceBody.verifier?.command;
  if (!verifierCommand || verifierCommand.trim().length === 0) {
    throw new ComponentSpecError(
      `spec.acceptance for '${componentGlmId}' has no verifier.command`,
      422,
    );
  }

  const refs = Array.isArray(promptBody.context_bundle) ? promptBody.context_bundle : [];
  const contextBundle = buildContextBundle(deps.nodes, workspaceId, refs);

  return {
    component: componentFound.node,
    specPrompt: promptFound.node,
    specAcceptance: acceptanceFound.node,
    outputs,
    contextBundle,
    hardConstraints: HARD_CONSTRAINTS,
    sourceDir: workspace.sourceDir,
    promptTemplate: (promptBody.prompt_template ?? '').trim(),
    verifierCommand,
  };
}

/**
 * Resolve a context bundle: walk `refs`, look up each glm_id in the workspace,
 * stringify the matched node body, and concatenate with a `# <ref>` heading.
 *
 * External refs (`pkg:`, `dep:`, `svc:`, `hw:`) are skipped — they're not
 * resolvable from the sekkei DB. Missing refs render an inline `# ref
 * 'X' not found` marker so the LLM can see them.
 *
 * Returns the joined text plus a binding hash over the resolved content
 * hashes (used by provenance to bind a generation to its inputs).
 */
export function buildContextBundle(
  nodes: NodeRepository,
  workspaceId: string,
  refs: string[],
): ContextBundle {
  const blocks: string[] = [];
  const digests: string[] = [];
  let bytesUsed = 0;

  for (const ref of refs) {
    if (
      ref.startsWith('pkg:') ||
      ref.startsWith('dep:') ||
      ref.startsWith('svc:') ||
      ref.startsWith('hw:')
    ) {
      continue;
    }
    const found = nodes.findByGlmId(workspaceId, ref);
    if (!found) {
      blocks.push(`# ref '${ref}' not found in workspace; skipping`);
      continue;
    }
    const body = JSON.stringify(found.node.body, null, 2);
    const block = `# ${ref}\n${body}\n`;
    const blockBytes = Buffer.byteLength(block, 'utf8');
    if (bytesUsed + blockBytes > CONTEXT_BUNDLE_BYTE_CAP) {
      blocks.push(
        `# context bundle truncated at ${CONTEXT_BUNDLE_BYTE_CAP} bytes; omitting remaining refs`,
      );
      break;
    }
    bytesUsed += blockBytes;
    blocks.push(block);
    digests.push(found.node.contentHash);
  }

  const bindingHash =
    digests.length === 0
      ? 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
      : `sha256:${createHash('sha256').update(digests.join('\n')).digest('hex')}`;

  return { text: blocks.join('\n'), bindingHash };
}
