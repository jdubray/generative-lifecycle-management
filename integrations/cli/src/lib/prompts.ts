/**
 * Vibe-design prompt assembly (UC-01).
 *
 * The system prompt is built at runtime from three sources:
 *
 *   1. A small in-file scaffold that frames Claude's role.
 *   2. `docs/sekkei-authoring.md` — the authoring skill from the main repo.
 *      This is the "skill" referenced in docs/solo-mode-spec.md §4.1.
 *   3. (Optional) `specification/sekkei.schema.json` — the JSON Schema that
 *      the emitted YAML must validate against.
 *
 * The user-turn prompt is built from the developer's `--namespace`, `--stack`,
 * and `--description` inputs.
 *
 * Output is plain text suitable for `claude --print --system-prompt-file <f>`.
 */

const VIBE_SCAFFOLD = `You are a sekkei author operating under the GLM methodology.
Your output MUST be valid YAML conforming to the sekkei specification.

OPERATING MODE: one-shot generation. Treat the user message as a complete
authoring brief — there is no interactive channel. Do not request
clarifications, do not ask follow-up questions, do not output any meta-
commentary about the brief. Make reasonable assumptions and proceed.
The authoring skill's §1 elicitation steps DO NOT APPLY in this mode;
infer the answers from the user's description.

The authoring skill that follows is loaded VERBATIM as your reference. Apply
every section in order. Do not deviate from the conventions in §10.`;

const VIBE_HARD_CONSTRAINTS = `HARD CONSTRAINTS:
- Output ONLY YAML. No prose, no markdown fences.
- Every node must have: id, stratum, title, revision, provenance, relationships, body.
- Every Component must have spec nodes for: functional, technical, schema, business_rule, acceptance, prompt.
- Acceptance specs must list deliverables[] with a verifier.command.
- Prompt specs must list context_bundle[] and outputs[].
- IDs must follow the convention: <org>:<project>.<capability>.<component>[.spec.<kind>]
- Use multi-document YAML (\`---\` separators) to emit every node in one response.`;

export interface VibeSystemPromptInput {
  authoringSkill: string;
  schemaJson?: string;
}

export function buildVibeSystemPrompt(input: VibeSystemPromptInput): string {
  const parts: string[] = [VIBE_SCAFFOLD, '\n\n--- AUTHORING SKILL ---\n', input.authoringSkill];
  if (input.schemaJson && input.schemaJson.trim().length > 0) {
    parts.push('\n\n--- SEKKEI JSON SCHEMA ---\n', input.schemaJson);
  }
  parts.push('\n\n', VIBE_HARD_CONSTRAINTS, '\n');
  return parts.join('');
}

export interface VibeUserPromptInput {
  namespace: string;
  stack: string;
  description: string;
}

export function buildVibeUserPrompt(input: VibeUserPromptInput): string {
  return `Design a sekkei for the following system.

Namespace prefix: ${input.namespace}
Stack: ${input.stack}
Description:
${input.description}

Produce a complete sekkei YAML starting with the root System node.
Use multi-document YAML (\`---\` separators) to emit all nodes in one response.
`;
}

/**
 * Strip an outer markdown code fence (```yaml … ``` or ``` … ```) if the
 * model ignored the "no fences" constraint. Tolerant of trailing newlines.
 * Returns the original text unchanged if it doesn't match a single outer fence.
 */
export function stripCodeFences(text: string): string {
  // Accept any single-word language tag (yaml, yml, json, ts, …) or none.
  const fenced = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n\s*```\s*$/;
  const m = text.match(fenced);
  return m && m[1] !== undefined ? m[1] : text;
}

// ---------------------------------------------------------------------------
// UC-05 — refine a single node via JSON-Patch
// ---------------------------------------------------------------------------

const REFINE_SCAFFOLD = `You are refining one node of an existing sekkei. Your output MUST be a
JSON array of RFC-6902 JSON-Patch operations targeting the node's \`body\`.

OPERATING MODE: one-shot generation. Treat the refinement instruction as a
complete brief. Do not request clarifications. Make reasonable assumptions
and proceed.

SUPPORTED OPS: add, remove, replace, move.

ALLOWED ROOT: every operation's \`path\` MUST address something under the
node body (e.g. \`/behaviors/2\`, \`/data_shapes/User/properties/email\`).
Do NOT touch the node's envelope fields: id, stratum, revision, provenance,
relationships, parameters, constraints.`;

const REFINE_RULES = `HARD CONSTRAINTS:
- Output ONLY a JSON array of patch ops. No prose, no markdown fences.
- Every op object must have \`op\` and \`path\`; \`add\` / \`replace\` also need \`value\`; \`move\` also needs \`from\`.
- Paths use RFC-6902 JSON Pointer syntax: \`/\`-separated, \`~0\` for \`~\`, \`~1\` for \`/\`.
- Array append uses \`/-\` as the last segment.
- Never refactor unrelated fields. Make the minimal set of ops the instruction implies.`;

export interface RefineSystemPromptInput {
  authoringSkill: string;
}

export function buildRefineSystemPrompt(input: RefineSystemPromptInput): string {
  return [REFINE_SCAFFOLD, '\n\n--- AUTHORING SKILL (reference) ---\n', input.authoringSkill, '\n\n', REFINE_RULES, '\n'].join('');
}

export interface RefineUserPromptInput {
  glmId: string;
  stratum: string;
  /** Full node YAML the developer is editing — id + envelope + body. */
  nodeYaml: string;
  /** Optional ancestor context (system / capability body summaries). */
  ancestorSummary?: string;
  /** The developer's refinement request. */
  instruction: string;
}

export function buildRefineUserPrompt(input: RefineUserPromptInput): string {
  const lines: string[] = [
    `Refine the body of node '${input.glmId}' (stratum: ${input.stratum}).`,
    '',
    'Current node:',
    input.nodeYaml,
  ];
  if (input.ancestorSummary && input.ancestorSummary.trim().length > 0) {
    lines.push('');
    lines.push('Ancestor context:');
    lines.push(input.ancestorSummary);
  }
  lines.push('');
  lines.push('Refinement instruction:');
  lines.push(input.instruction);
  lines.push('');
  lines.push('Output ONLY a JSON array of RFC-6902 JSON-Patch operations targeting `body`.');
  return lines.join('\n');
}

/**
 * Parse Claude's response into a JSON-Patch array. Tolerant of:
 *   - Outer markdown fences (```json … ```)
 *   - Leading / trailing whitespace
 *   - Optional `{"patch": [...]}` wrapping that some models emit
 */
export function parseJsonPatchResponse(text: string): unknown {
  const stripped = stripCodeFences(text).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new Error(
      `claude response is not valid JSON: ${(err as Error).message}. Raw: ${stripped.slice(0, 200)}…`,
    );
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { patch?: unknown }).patch)) {
    return (parsed as { patch: unknown[] }).patch;
  }
  throw new Error(`claude response is not a JSON-Patch array (got ${typeof parsed})`);
}

// ---------------------------------------------------------------------------
// UC-04 — reverse-engineer an existing codebase
// ---------------------------------------------------------------------------

const REVERSE_SCAFFOLD = `You are reverse-engineering an existing codebase into a sekkei.
Your output MUST be valid YAML conforming to the sekkei specification.

OPERATING MODE: one-shot generation. Treat the user message as a complete
authoring brief — there is no interactive channel. Do not request
clarifications, do not ask follow-up questions, do not output any meta-
commentary. Make reasonable assumptions and proceed. The authoring skill's
§1 elicitation steps DO NOT APPLY in this mode; infer the answers from the
codebase listing and file excerpts.

The authoring skill that follows is loaded VERBATIM as your reference. Apply
sections §10.1 through §10.7 strictly.`;

const REVERSE_RULES = `REVERSE-ENGINEERING RULES:
- Read FSM states VERBATIM from source (§10.3). Do not invent states.
- Component boundaries must reflect what the code ACTUALLY OWNS (§10.2).
- Emit a complete sekkei with all 6 spec kinds per Component.
- Use override_kind: net_new for every node (this is a first-time authoring).
- Output ONLY YAML. No prose, no markdown fences.
- Use multi-document YAML (\`---\` separators) to emit every node in one response.`;

export interface ReverseSystemPromptInput {
  authoringSkill: string;
  schemaJson?: string;
}

export function buildReverseEngineerSystemPrompt(input: ReverseSystemPromptInput): string {
  const parts: string[] = [REVERSE_SCAFFOLD, '\n\n--- AUTHORING SKILL ---\n', input.authoringSkill];
  if (input.schemaJson && input.schemaJson.trim().length > 0) {
    parts.push('\n\n--- SEKKEI JSON SCHEMA ---\n', input.schemaJson);
  }
  parts.push('\n\n', REVERSE_RULES, '\n');
  return parts.join('');
}

export interface ReverseUserPromptInput {
  namespace: string;
  rootDir: string;
  /** Pre-formatted tree text (one entry per line). */
  fileTree: string;
  excerpts: Array<{ path: string; content: string; truncated: boolean; totalLines: number }>;
  /** Optional free-form hint from the developer. */
  hint?: string;
}

export function buildReverseEngineerUserPrompt(input: ReverseUserPromptInput): string {
  const lines: string[] = [];
  lines.push(`Reverse-engineer a sekkei for the codebase rooted at ${input.rootDir}.`);
  lines.push('');
  lines.push(`Namespace prefix: ${input.namespace}`);
  if (input.hint && input.hint.trim().length > 0) {
    lines.push('');
    lines.push('Author hint:');
    lines.push(input.hint.trim());
  }
  lines.push('');
  lines.push('CODEBASE STRUCTURE:');
  lines.push(input.fileTree);
  lines.push('');
  lines.push('KEY FILES (excerpts):');
  for (const ex of input.excerpts) {
    lines.push('');
    lines.push(`=== ${ex.path}${ex.truncated ? ` (truncated; first ${ex.content.split(/\r?\n/).length} of ${ex.totalLines} lines)` : ''} ===`);
    lines.push(ex.content);
  }
  lines.push('');
  lines.push(
    'Produce a complete sekkei YAML starting with the root System node. ' +
      'Use multi-document YAML (`---` separators) to emit every node in one response.',
  );
  return lines.join('\n');
}
