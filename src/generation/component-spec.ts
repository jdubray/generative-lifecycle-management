import { createHash } from 'node:crypto';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import type { NodeRepository } from '../repository/node-repository.ts';
import type { WorkspaceRepository } from '../repository/workspace-repository.ts';
import type { NodeRelationship, SekkeiNode } from '../types.ts';

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
- After the last file, stop. Do not append commentary.
- Do NOT emit \`as unknown as\`, \`as any\`, \`@ts-ignore\`, or \`@ts-expect-error\`. If types do not align, fix the types rather than suppressing the error.
- In acceptance tests, mock every collaborator using its real exported interface type (e.g. \`const mock: RealServiceType = { ... }\`), never an inline shape or \`any\`.`;

/** Bytes-soft-cap on resolved context bundle text — protects against runaway bundles. */
export const CONTEXT_BUNDLE_BYTE_CAP = 400_000;

// ---------------------------------------------------------------------------
// Prompt assembly (shared by server-side solo-generate and CLI client-side
// generate)
// ---------------------------------------------------------------------------

/**
 * Compose the system prompt sent to Claude for a component generation.
 * Concatenates `prompt_template`, the resolved context bundle text, the
 * outputs list, and the hard-constraints suffix. The result is what the
 * server used to write to `--system-prompt-file`; client-side callers can
 * either write it to a file too, or pass it via `--system-prompt`.
 */
export function buildSystemPrompt(
  promptBody: PromptBody,
  contextBundleText: string,
  outputs: Array<{ path: string; description?: string }>,
): string {
  const tpl = (promptBody.prompt_template ?? '').trim();
  const outputBlock = outputs
    .map((o) => `  - path: ${o.path}\n    description: ${o.description ?? ''}`)
    .join('\n');
  return [tpl, '', 'CONTEXT BUNDLE:', contextBundleText, '', 'OUTPUTS to produce:', outputBlock, '', HARD_CONSTRAINTS].join(
    '\n',
  );
}

/**
 * Compose the user-turn message sent to Claude. Names the component
 * being generated and re-lists the expected output paths so the model
 * can't drift even if the system prompt is long.
 */
export function buildUserPrompt(
  component: { glmId: string; title: string },
  outputs: Array<{ path: string; description?: string }>,
): string {
  return [
    `Generate the implementation of component '${component.glmId}' (${component.title}).`,
    `Produce exactly ${outputs.length} file${outputs.length === 1 ? '' : 's'}:`,
    ...outputs.map((o) => `  - ${o.path}`),
    '',
    'Each file must start with `=== FILE: <path> ===` on its own line.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Multi-file response parsing
// ---------------------------------------------------------------------------

const FILE_HEADER_RE = /^===\s*FILE:\s*(.+?)\s*===\s*$/;

export interface ParsedFile {
  path: string;
  content: string;
}

/**
 * Parse Claude's multi-file response. Claude emits each file as a block
 * prefixed by `=== FILE: <path> ===\n`. We split on those headers, validate
 * that every path appears in `expectedPaths`, and ensure every file ends
 * with a newline.
 *
 * Throws `ComponentSpecError(422)` when:
 *   - no headers were emitted (model produced prose),
 *   - an emitted path is not in the expected set.
 */
export function parseMultiFileResponse(stdout: string, expectedPaths: string[]): ParsedFile[] {
  const lines = stdout.split(/\r?\n/);
  const files: ParsedFile[] = [];
  let current: { path: string; lines: string[] } | null = null;

  for (const line of lines) {
    const m = line.match(FILE_HEADER_RE);
    if (m) {
      if (current) files.push({ path: current.path, content: current.lines.join('\n') });
      current = { path: (m[1] ?? '').trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) files.push({ path: current.path, content: current.lines.join('\n') });

  if (files.length === 0) {
    throw new ComponentSpecError(
      'Claude response contained no `=== FILE: <path> ===` markers. ' +
        'Did the model emit prose instead of the multi-file format?',
      422,
    );
  }

  const expectedSet = new Set(expectedPaths.map(normalize));
  for (const f of files) {
    const normalized = normalize(f.path);
    if (!expectedSet.has(normalized)) {
      throw new ComponentSpecError(
        `Claude emitted unexpected file path '${f.path}'. ` +
          `Expected one of: ${[...expectedSet].join(', ')}`,
        422,
      );
    }
  }

  return files.map((f) => ({
    path: f.path,
    content: f.content.endsWith('\n') ? f.content : `${f.content}\n`,
  }));
}

// ---------------------------------------------------------------------------
// Path-safety helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a Claude-emitted file path against the workspace's `source_dir`,
 * rejecting absolute paths, parent-traversal segments, and any resolved
 * target outside the base. Used by both server-side and CLI-side
 * generation flows to write files safely.
 */
export function resolveSafePath(baseDir: string, candidate: string): string {
  if (isAbsolute(candidate)) {
    throw new ComponentSpecError(`output path '${candidate}' must be relative`, 422);
  }
  if (candidate.includes('..')) {
    throw new ComponentSpecError(`output path '${candidate}' must not contain '..'`, 422);
  }
  const baseAbs = resolve(baseDir);
  const target = resolve(baseAbs, candidate);
  if (target !== baseAbs && !target.startsWith(baseAbs + sep)) {
    throw new ComponentSpecError(`output path '${candidate}' escapes source_dir`, 422);
  }
  return target;
}

// ---------------------------------------------------------------------------
// Aggregate file digest
// ---------------------------------------------------------------------------

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

  // P2-A: automatically inject the functional + schema specs of every component
  // this one depends-on or composes-of, so the model sees the real interface
  // contracts rather than guessing them. Sibling refs are resolved from the
  // component node's relationship edges; they complement (never replace) the
  // explicit context_bundle refs in the sekkei.
  const siblingRefs = resolveSiblingInterfaceRefs(componentFound.relationships);
  const contextBundle = buildContextBundle(deps.nodes, workspaceId, refs, siblingRefs);

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
 * `siblingRefs` (optional) are appended after the explicit refs under a
 * distinct `DEPENDENCY INTERFACES` header. They are resolved the same way
 * but missing siblings are silently omitted (not every dependency has a
 * spec.functional / spec.schema yet).
 *
 * Returns the joined text plus a binding hash over ALL resolved content
 * hashes — explicit refs first, then sibling refs.
 */
export function buildContextBundle(
  nodes: NodeRepository,
  workspaceId: string,
  refs: string[],
  siblingRefs: string[] = [],
): ContextBundle {
  const blocks: string[] = [];
  const digests: string[] = [];
  let bytesUsed = 0;

  const appendRef = (ref: string, missingAllowed: boolean): boolean => {
    if (
      ref.startsWith('pkg:') ||
      ref.startsWith('dep:') ||
      ref.startsWith('svc:') ||
      ref.startsWith('hw:')
    ) {
      return true;
    }
    const found = nodes.findByGlmId(workspaceId, ref);
    if (!found) {
      if (!missingAllowed) blocks.push(`# ref '${ref}' not found in workspace; skipping`);
      return true;
    }
    const body = JSON.stringify(found.node.body, null, 2);
    const block = `# ${ref}\n${body}\n`;
    const blockBytes = Buffer.byteLength(block, 'utf8');
    if (bytesUsed + blockBytes > CONTEXT_BUNDLE_BYTE_CAP) {
      blocks.push(`# context bundle truncated at ${CONTEXT_BUNDLE_BYTE_CAP} bytes; omitting remaining refs`);
      return false; // signal: stop iteration
    }
    bytesUsed += blockBytes;
    blocks.push(block);
    digests.push(found.node.contentHash);
    return true;
  };

  for (const ref of refs) {
    if (!appendRef(ref, false)) break;
  }

  // Sibling interface section — only emitted when there are resolvable siblings.
  if (siblingRefs.length > 0) {
    const siblingBlocks: string[] = [];
    const saved = { bytesUsed, digestLen: digests.length };
    for (const ref of siblingRefs) {
      const before = blocks.length;
      if (!appendRef(ref, true)) break;
      if (blocks.length > before) siblingBlocks.push(blocks[blocks.length - 1]!);
    }
    // Only emit the header if at least one sibling resolved.
    if (siblingBlocks.length > 0) {
      // Insert the header before the sibling blocks in the output array.
      const insertAt = blocks.length - siblingBlocks.length;
      blocks.splice(insertAt, 0, '# DEPENDENCY INTERFACES (auto-resolved from depends-on / composes-of edges):');
      void saved;
    }
  }

  const bindingHash =
    digests.length === 0
      ? 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
      : `sha256:${createHash('sha256').update(digests.join('\n')).digest('hex')}`;

  return { text: blocks.join('\n'), bindingHash };
}

/**
 * Derive the sibling interface spec glm_ids from a component's relationship
 * edges. For each `depends-on` or `composes-of` target we request the
 * `spec.functional` and `spec.schema` nodes of that component. The caller
 * passes these to `buildContextBundle` as `siblingRefs`; missing ones are
 * silently omitted there (the dependency may not yet have those spec kinds).
 */
export function resolveSiblingInterfaceRefs(relationships: NodeRelationship[]): string[] {
  const refs: string[] = [];
  for (const rel of relationships) {
    if (rel.kind !== 'depends-on' && rel.kind !== 'composes-of') continue;
    const target = rel.targetGlmId;
    // Skip external refs — they have no spec nodes in the sekkei DB.
    if (
      target.startsWith('pkg:') ||
      target.startsWith('dep:') ||
      target.startsWith('svc:') ||
      target.startsWith('hw:')
    ) continue;
    refs.push(`${target}.spec.functional`);
    refs.push(`${target}.spec.schema`);
  }
  // De-duplicate in case the same target appears in multiple relationship kinds.
  return [...new Set(refs)];
}
