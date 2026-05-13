import type { NodeBody, Stratum } from '../types.ts';

/**
 * Stratum-aware body validation. Each stratum has a distinct YAML body shape
 * (spec §3.2). The DB CHECK constraint enforces the `stratum`/`system_role`/
 * `spec_kind` discriminator; this module enforces the *contents* of `body`.
 *
 * Validation is **structural only** — it does not evaluate constraints or
 * resolve relationships. That work belongs in `variant.ts` and
 * `relationships.ts`. Validators here are pure: same body → same result.
 */

export class NodeBodyValidationError extends Error {
  public readonly stratum: Stratum;
  public readonly issues: readonly string[];
  constructor(stratum: Stratum, issues: readonly string[]) {
    super(`invalid ${stratum} body: ${issues.join('; ')}`);
    this.name = 'NodeBodyValidationError';
    this.stratum = stratum;
    this.issues = issues;
  }
}

export type ValidationResult =
  | { ok: true; body: NodeBody }
  | { ok: false; issues: string[] };

/** Validate a body against the schema for `stratum`. Returns a tagged result. */
export function validateBody(stratum: Stratum, body: unknown): ValidationResult {
  if (!isPlainObject(body)) {
    return { ok: false, issues: ['body must be an object'] };
  }
  switch (stratum) {
    case 'system':
      return validateSystem(body);
    case 'capability':
      return validateCapability(body);
    case 'component':
      return validateComponent(body);
    case 'interaction':
      return validateInteraction(body);
    case 'spec':
      return validateSpec(body);
  }
}

/** Throwing wrapper: succeeds silently or raises `NodeBodyValidationError`. */
export function assertValidBody(stratum: Stratum, body: unknown): NodeBody {
  const r = validateBody(stratum, body);
  if (!r.ok) throw new NodeBodyValidationError(stratum, r.issues);
  return r.body;
}

// ---------------------------------------------------------------------------
// per-stratum validators
// ---------------------------------------------------------------------------

function validateSystem(b: Record<string, unknown>): ValidationResult {
  const issues: string[] = [];
  if (typeof b.system_role !== 'string' || b.system_role.length === 0) {
    issues.push('system.system_role must be a non-empty string');
  }
  if (b.dbom_ref !== undefined && b.dbom_ref !== null && typeof b.dbom_ref !== 'string') {
    issues.push('system.dbom_ref must be a string or null');
  }
  if (b.runtime !== undefined && b.runtime !== null && typeof b.runtime !== 'string') {
    issues.push('system.runtime must be a string or null');
  }
  return issues.length === 0
    ? { ok: true, body: b as NodeBody }
    : { ok: false, issues };
}

function validateCapability(b: Record<string, unknown>): ValidationResult {
  const issues: string[] = [];
  if (typeof b.user_value !== 'string' || b.user_value.length === 0) {
    issues.push('capability.user_value must be a non-empty string');
  }
  return issues.length === 0
    ? { ok: true, body: b as NodeBody }
    : { ok: false, issues };
}

function validateComponent(b: Record<string, unknown>): ValidationResult {
  const issues: string[] = [];
  if (typeof b.boundary !== 'string' || b.boundary.length === 0) {
    issues.push('component.boundary must be a non-empty string');
  }
  if (typeof b.runtime !== 'string' || b.runtime.length === 0) {
    issues.push('component.runtime must be a non-empty string');
  }
  return issues.length === 0
    ? { ok: true, body: b as NodeBody }
    : { ok: false, issues };
}

/**
 * Two body shapes are accepted (both documented in docs/sekkei-authoring.md):
 *
 *   Rich (default per the authoring skill §5.4):
 *     contract_kind: fsm | integration_adapter | schema_binding | event_flow
 *     contract_definition: { … }      // shape varies by kind
 *
 *   Legacy flat (early v1 spec):
 *     contract: fsm
 *     states: string[]
 *     transitions: string[]            // for fsm
 *     endpoints: string[]              // for integration_adapter
 *     schema: object                   // for schema_binding
 *     listener: string                 // for event_flow
 *
 * The rich form is open-shaped — per-kind subfield rules belong in gate 6
 * (spec quality), not here. Envelope validation only checks the discriminator.
 */
const INTERACTION_KINDS = new Set(['fsm', 'integration_adapter', 'schema_binding', 'event_flow']);

function validateInteraction(b: Record<string, unknown>): ValidationResult {
  const issues: string[] = [];

  const richKind = typeof b.contract_kind === 'string' ? b.contract_kind : undefined;
  const flatKind = typeof b.contract === 'string' ? b.contract : undefined;
  const kind = richKind ?? flatKind;

  if (!kind) {
    issues.push(
      'interaction body must have contract_kind or contract ' +
        '(one of: fsm, integration_adapter, schema_binding, event_flow)',
    );
    return { ok: false, issues };
  }
  if (!INTERACTION_KINDS.has(kind)) {
    issues.push(
      `interaction.${richKind !== undefined ? 'contract_kind' : 'contract'} '${kind}' unknown ` +
        `(must be one of: fsm, integration_adapter, schema_binding, event_flow)`,
    );
    return { ok: false, issues };
  }

  // Strict subfield validation only for the legacy flat form. The rich form
  // (contract_kind) places details under `contract_definition` and may carry
  // additional fields like `actions`, `naps`, `reactors`, `invariants` —
  // those are validated by downstream gates / generation logic, not here.
  if (richKind === undefined && flatKind !== undefined) {
    switch (flatKind) {
      case 'fsm':
        if (!isStringArray(b.states)) issues.push('interaction(fsm).states must be string[]');
        if (!isStringArray(b.transitions)) {
          issues.push('interaction(fsm).transitions must be string[]');
        }
        break;
      case 'integration_adapter':
        if (!isStringArray(b.endpoints)) {
          issues.push('interaction(integration_adapter).endpoints must be string[]');
        }
        break;
      case 'schema_binding':
        if (!isPlainObject(b.schema)) {
          issues.push('interaction(schema_binding).schema must be an object');
        }
        break;
      case 'event_flow':
        if (typeof b.listener !== 'string' || b.listener.length === 0) {
          issues.push('interaction(event_flow).listener must be a non-empty string');
        }
        break;
    }
  } else if (richKind !== undefined && b.contract_definition !== undefined) {
    // Optional sanity check — when present, contract_definition must be an object.
    if (!isPlainObject(b.contract_definition)) {
      issues.push('interaction.contract_definition (when present) must be an object');
    }
  }

  return issues.length === 0
    ? { ok: true, body: b as NodeBody }
    : { ok: false, issues };
}

/**
 * Spec body validation is a thin envelope check. The authoring skill (§6) defines
 * six spec_kinds with distinct body shapes (functional → behaviors[], technical →
 * implementation, schema → data_shapes, business_rule → rules[], acceptance →
 * deliverables[] + verifier, prompt → context_bundle + outputs + prompt_template +
 * verifier). Per-kind subfield requirements are enforced by gate 6 (spec quality),
 * not here. This function only enforces:
 *   - spec_kind is present and non-empty
 *   - well-known optional fields, when present, have the expected types
 *
 * Both `verifier: "bun test"` (string) and `verifier: { command, expect }`
 * (object) are accepted. Both `outputs: ["src/foo.ts"]` and
 * `outputs: [{ path: "src/foo.ts", description: "…" }]` are accepted.
 */
function validateSpec(b: Record<string, unknown>): ValidationResult {
  const issues: string[] = [];
  if (typeof b.spec_kind !== 'string' || b.spec_kind.length === 0) {
    issues.push('spec.spec_kind must be a non-empty string');
  }
  if (b.content !== undefined && typeof b.content !== 'string') {
    issues.push('spec.content (when present) must be a string');
  }
  if (b.inspection_assertions !== undefined && !Array.isArray(b.inspection_assertions)) {
    issues.push('spec.inspection_assertions must be an array');
  }
  if (b.context_bundle !== undefined && !isStringArray(b.context_bundle)) {
    issues.push('spec.context_bundle must be string[]');
  }
  if (b.outputs !== undefined && !isValidOutputs(b.outputs)) {
    issues.push('spec.outputs must be string[] or Array<{ path: string, … }>');
  }
  if (b.verifier !== undefined && !isValidVerifier(b.verifier)) {
    issues.push('spec.verifier must be a string or an object with a `command` field');
  }
  return issues.length === 0
    ? { ok: true, body: b as NodeBody }
    : { ok: false, issues };
}

function isValidOutputs(v: unknown): boolean {
  if (!Array.isArray(v)) return false;
  return v.every(
    (x) => typeof x === 'string' || (isPlainObject(x) && typeof x.path === 'string'),
  );
}

function isValidVerifier(v: unknown): boolean {
  if (typeof v === 'string') return true;
  if (isPlainObject(v) && typeof v.command === 'string' && v.command.length > 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}
