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
  const fenced = /^\s*```(?:yaml|yml)?\s*\n([\s\S]*?)\n\s*```\s*$/;
  const m = text.match(fenced);
  return m && m[1] !== undefined ? m[1] : text;
}
