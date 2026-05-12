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

function validateInteraction(b: Record<string, unknown>): ValidationResult {
  const issues: string[] = [];
  const contract = b.contract;
  if (typeof contract !== 'string') {
    issues.push('interaction.contract must be one of fsm | integration_adapter | schema_binding | event_flow');
    return { ok: false, issues };
  }
  switch (contract) {
    case 'fsm':
      if (!isStringArray(b.states)) issues.push('interaction(fsm).states must be string[]');
      if (!isStringArray(b.transitions)) issues.push('interaction(fsm).transitions must be string[]');
      break;
    case 'integration_adapter':
      if (!isStringArray(b.endpoints)) issues.push('interaction(integration_adapter).endpoints must be string[]');
      break;
    case 'schema_binding':
      if (!isPlainObject(b.schema)) issues.push('interaction(schema_binding).schema must be an object');
      break;
    case 'event_flow':
      if (typeof b.listener !== 'string' || b.listener.length === 0) {
        issues.push('interaction(event_flow).listener must be a non-empty string');
      }
      break;
    default:
      issues.push(`unknown interaction contract: ${contract}`);
  }
  return issues.length === 0
    ? { ok: true, body: b as NodeBody }
    : { ok: false, issues };
}

function validateSpec(b: Record<string, unknown>): ValidationResult {
  const issues: string[] = [];
  if (typeof b.spec_kind !== 'string' || b.spec_kind.length === 0) {
    issues.push('spec.spec_kind must be a non-empty string');
  }
  if (typeof b.content !== 'string' || b.content.length === 0) {
    issues.push('spec.content must be a non-empty string');
  }
  if (b.inspection_assertions !== undefined && !Array.isArray(b.inspection_assertions)) {
    issues.push('spec.inspection_assertions must be an array');
  }
  if (b.context_bundle !== undefined && !isStringArray(b.context_bundle)) {
    issues.push('spec.context_bundle must be string[]');
  }
  if (b.outputs !== undefined && !isStringArray(b.outputs)) {
    issues.push('spec.outputs must be string[]');
  }
  if (b.verifier !== undefined && typeof b.verifier !== 'string') {
    issues.push('spec.verifier must be a string');
  }
  return issues.length === 0
    ? { ok: true, body: b as NodeBody }
    : { ok: false, issues };
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
