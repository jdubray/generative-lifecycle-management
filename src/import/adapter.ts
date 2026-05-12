import type { NodeInput } from '../repository/node-repository.ts';
import type { OverrideKind, RevisionStatus, Stratum } from '../types.ts';

/**
 * Pure transformation from a parsed YAML sekkei document into our
 * `NodeInput` shape (plus the un-resolved `derivesFromGlmId` that the
 * importer's second pass turns into a foreign key).
 *
 * The YAML on disk (`./sekkei/`) was reverse-engineered against an earlier,
 * speculative schema (`kizo:` ids, nested `provenance` envelope, richer
 * `body.contract_kind` for interactions). This adapter is the seam where
 * that schema flexes into ours. It is intentionally permissive on shape —
 * unknown body fields pass through into `body_json` so a re-export can
 * round-trip them.
 *
 * Pure: no I/O, no DB access, no randomness. The importer feeds it parsed
 * `yaml.parseAllDocuments(...)` output one node at a time.
 */

export interface YamlNodeDoc {
  id: string;
  stratum: string;
  title?: string;
  description?: string;
  revision?: { major?: string; iteration?: number; status?: string };
  provenance?: {
    derives_from?: { id?: string; content_hash?: string } | null;
    override_kind?: string;
    authored_by?: string;
    authored_at?: string;
  };
  body?: Record<string, unknown>;
  parameters?: YamlParameter[];
  constraints?: YamlConstraint[];
  relationships?: YamlRelationship[];
}

export interface YamlParameter {
  name: string;
  schema?: { type?: string; enum?: unknown[]; minimum?: number; maximum?: number };
  type?: string; // some files inline type instead of nesting under .schema
  default?: unknown;
  binding_scope?: string;
}

export interface YamlConstraint {
  kind?: string;
  expression?: string;
  severity?: string;
}

export interface YamlRelationship {
  kind?: string;
  target?: string;
  attributes?: Record<string, unknown>;
}

export interface AdaptedNode {
  input: NodeInput;
  /**
   * The glm_id this node's `derives_from.id` points at, if any. The
   * importer resolves this to a `derives_from_node_id` foreign key in a
   * second pass once every node is inserted.
   */
  derivesFromGlmId: string | null;
  warnings: string[];
}

const STRATA: ReadonlySet<Stratum> = new Set([
  'system',
  'capability',
  'component',
  'interaction',
  'spec',
] as const);

const REVISION_STATUSES: ReadonlySet<RevisionStatus> = new Set([
  'in_work',
  'in_review',
  'released',
  'superseded',
  'obsolete',
] as const);

/** YAML override_kind vocabulary → our enum (CHECK on `nodes.override_kind`). */
const OVERRIDE_KIND_MAP: Record<string, OverrideKind> = {
  net_new: 'net_new',
  // The reverse-engineered sekkei uses these v1.1 override kinds; our DB
  // enum is narrower. The mapping is loss-free: `with_override` and
  // `as_is` both originate via a `derives-from` lineage edge that the
  // YAML expresses explicitly elsewhere; `extend` is a refinement.
  with_override: 'derives-from',
  as_is: 'derives-from',
  extend: 'refines',
  refines: 'refines',
  'derives-from': 'derives-from',
};

/**
 * Accepted parameter `binding_scope` values.
 *
 * v1.1 spec values name the STRATUM at which the parameter is declared
 * (system|capability|component|interaction|spec) — visibility scope. The
 * older realization values (workspace|variant|instance) name the LIFECYCLE
 * PHASE at which the value is bound. Migration 0005 widened the DB CHECK
 * to accept both sets; the importer passes both through unchanged.
 */
const VALID_BINDING_SCOPES = new Set([
  // v1.1 spec (specification/sekkei.schema.json)
  'system', 'capability', 'component', 'interaction', 'spec',
  // pre-v1.1 lifecycle-phase values, kept for back-compat with already-stored rows
  'workspace', 'variant', 'instance',
]);

/**
 * Accepted JSON Schema `type` values for a parameter. Migration 0005
 * widened the DB CHECK from {string,integer,boolean,enum} to include the
 * remaining JSON Schema primitive types (number, array, object, null) so
 * v1.1 sekkeis that use richer parameter shapes import without coercion.
 */
const VALID_PARAMETER_TYPES = new Set([
  'string', 'integer', 'boolean', 'number', 'array', 'object', 'null', 'enum',
]);

const PROVENANCE_DEFAULT_AUTHORED_AT = '1970-01-01T00:00:00.000Z';

export class YamlAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YamlAdapterError';
  }
}

/**
 * Adapt one YAML node into a `NodeInput`. `dbId` is the row id the importer
 * has chosen (preserved across re-imports by the orchestrator looking up
 * `findByGlmId` first).
 */
export function adaptYamlNode(
  doc: YamlNodeDoc,
  workspaceId: string,
  dbId: string,
): AdaptedNode {
  const warnings: string[] = [];

  if (!doc || typeof doc !== 'object') {
    throw new YamlAdapterError('YAML document is not a mapping');
  }
  if (typeof doc.id !== 'string' || doc.id.length === 0) {
    throw new YamlAdapterError('YAML document missing `id`');
  }
  if (!STRATA.has(doc.stratum as Stratum)) {
    throw new YamlAdapterError(
      `YAML document ${doc.id}: unknown stratum '${doc.stratum}'`,
    );
  }

  const stratum = doc.stratum as Stratum;
  const revisionMajor = String(doc.revision?.major ?? 'A');
  const revisionIteration = Number.isFinite(doc.revision?.iteration ?? NaN)
    ? Number(doc.revision?.iteration)
    : 0;
  const revisionStatusRaw = String(doc.revision?.status ?? 'in_work');
  const revisionStatus = (REVISION_STATUSES.has(revisionStatusRaw as RevisionStatus)
    ? revisionStatusRaw
    : ((): RevisionStatus => {
        warnings.push(`${doc.id}: unknown revision.status '${revisionStatusRaw}' — defaulting to in_work`);
        return 'in_work';
      })()) as RevisionStatus;

  const overrideKindRaw = doc.provenance?.override_kind ?? 'net_new';
  const overrideKind = OVERRIDE_KIND_MAP[overrideKindRaw];
  if (!overrideKind) {
    warnings.push(
      `${doc.id}: unknown provenance.override_kind '${overrideKindRaw}' — defaulting to net_new`,
    );
  }

  // YAML stores derives_from as { id, content_hash } or null. We resolve the
  // glm_id → db row id in the importer's second pass; for now record the
  // glm_id to look up (skipping self-references).
  let derivesFromGlmId: string | null = null;
  const dfId = doc.provenance?.derives_from?.id;
  if (typeof dfId === 'string' && dfId.length > 0 && dfId !== doc.id) {
    derivesFromGlmId = dfId;
  }

  const body = normalizeBody(stratum, doc.body ?? {}, doc.id, warnings);

  // System/spec discriminators (DB CHECKs require these be null otherwise).
  const systemRole =
    stratum === 'system'
      ? typeof body.system_role === 'string' && body.system_role.length > 0
        ? body.system_role
        : 'root' // YAML occasionally omits; root is the safe default
      : null;
  if (stratum === 'system' && (!body.system_role || typeof body.system_role !== 'string')) {
    body.system_role = systemRole;
  }
  // spec_kind: v1.1.1 moved this to the TOP-LEVEL on spec nodes (was nested
  // in body in the legacy v1.0 §C.8 draft). Read top-level first; fall back
  // to body.spec_kind for v1.0-shaped sekkeis still in the wild. Warn on
  // legacy form so authors migrate when they touch the file.
  const docAny = doc as Record<string, unknown>;
  const topLevelSpecKind =
    typeof docAny.spec_kind === 'string' && (docAny.spec_kind as string).length > 0
      ? (docAny.spec_kind as string)
      : null;
  const legacyBodySpecKind =
    typeof body.spec_kind === 'string' && body.spec_kind.length > 0
      ? body.spec_kind
      : null;
  if (stratum === 'spec' && topLevelSpecKind === null && legacyBodySpecKind !== null) {
    warnings.push(
      `${doc.id}: spec_kind found in body (legacy v1.0 shape); migrate to top-level per v1.1.1`,
    );
  }
  const specKind =
    stratum === 'spec' ? topLevelSpecKind ?? legacyBodySpecKind : null;
  // Non-spec nodes that accidentally carry spec_kind would fail the DB CHECK;
  // surface the conflict as a warning rather than silently dropping.
  if (stratum !== 'spec' && (topLevelSpecKind !== null || legacyBodySpecKind !== null)) {
    warnings.push(
      `${doc.id}: stratum=${stratum} carries spec_kind — ignored (DB CHECK forbids it on non-spec nodes)`,
    );
  }

  const input: NodeInput = {
    id: dbId,
    workspaceId,
    glmId: doc.id,
    stratum,
    title: typeof doc.title === 'string' && doc.title.length > 0 ? doc.title : doc.id,
    description: typeof doc.description === 'string' ? doc.description : '',
    body,
    revisionMajor,
    revisionIteration,
    revisionStatus,
    overrideKind: overrideKind ?? 'net_new',
    derivesFromNodeId: null, // resolved in pass 2
    systemRole,
    specKind,
    authoredBy: doc.provenance?.authored_by ?? 'imported',
    authoredAt: normalizeIso(doc.provenance?.authored_at) ?? PROVENANCE_DEFAULT_AUTHORED_AT,
    generatorIdentity: null,
    parameters: (doc.parameters ?? []).map((p, i) => adaptParameter(p, i, doc.id, warnings)),
    constraints: (doc.constraints ?? []).map((c, i) => adaptConstraint(c, i, doc.id, warnings)),
    relationships: (doc.relationships ?? []).map((r, i) => adaptRelationship(r, i, doc.id, warnings)),
  };

  return { input, derivesFromGlmId, warnings };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Stratum-aware body cleanup. We do NOT call `assertValidBody` here because
 * the reverse-engineered YAML carries richer body shapes (e.g. interaction
 * bodies use `contract_kind` with structured `contract_definition`) than
 * the v1 `InteractionBody` type union accepts. Phase 2 verifier failures on
 * gate 1 (envelope) are an accepted trade-off — see the importer's summary.
 */
function normalizeBody(
  stratum: Stratum,
  raw: Record<string, unknown>,
  glmId: string,
  warnings: string[],
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...raw };
  if (stratum === 'interaction') {
    // Reverse-engineered YAML uses `contract_kind`; our v1 `validateInteraction`
    // expects `contract`. Mirror under both keys so a future stricter
    // validator that reads `contract` will see the discriminator.
    if (typeof body.contract_kind === 'string' && typeof body.contract !== 'string') {
      body.contract = body.contract_kind;
    }
  }
  if (stratum === 'system' && body.dbom_ref === undefined) {
    // Subsystem invariant in gate 2.b expects `dbom_ref` to be present (null is fine).
    body.dbom_ref = null;
  }
  if (stratum === 'capability' && typeof body.user_value !== 'string') {
    warnings.push(`${glmId}: capability body missing user_value`);
  }
  if (stratum === 'component') {
    if (typeof body.boundary !== 'string') warnings.push(`${glmId}: component body missing boundary`);
    if (typeof body.runtime !== 'string') warnings.push(`${glmId}: component body missing runtime`);
  }
  return body;
}

function adaptParameter(
  yaml: YamlParameter,
  ord: number,
  glmId: string,
  warnings: string[],
) {
  const inferredType = yaml.schema?.type ?? yaml.type ?? 'string';
  // v1.1 spec accepts the full JSON Schema type set (string, integer,
  // boolean, number, array, object, null) plus the 'enum' decorator used
  // by older sekkeis. Migration 0005 widened the DB CHECK to match. If we
  // still see an unknown value, coerce to string and warn — but the
  // common cases that used to coerce (array, number, object) now pass.
  const type = VALID_PARAMETER_TYPES.has(inferredType) ? inferredType : 'string';
  if (type !== inferredType) {
    warnings.push(`${glmId}.parameters[${ord}]: unknown type '${inferredType}' — coerced to string`);
  }
  const options =
    yaml.schema?.enum && Array.isArray(yaml.schema.enum) ? (yaml.schema.enum as unknown[]) : null;
  const min = typeof yaml.schema?.minimum === 'number' ? yaml.schema.minimum : null;
  const max = typeof yaml.schema?.maximum === 'number' ? yaml.schema.maximum : null;
  // binding_scope: accept both the v1.1 stratum names (system|capability|
  // component|interaction|spec) and the pre-v1.1 lifecycle-phase names
  // (workspace|variant|instance). Migration 0005 widened the DB CHECK
  // to accept both. Pass through unchanged; downstream code that cares
  // about the lifecycle-phase axis (variant resolution) should map at the
  // point of use, not at the point of import.
  const bindingRaw = yaml.binding_scope ?? 'workspace';
  const bindingScope = VALID_BINDING_SCOPES.has(bindingRaw) ? bindingRaw : 'workspace';
  if (bindingScope !== bindingRaw) {
    warnings.push(
      `${glmId}.parameters[${ord}]: unknown binding_scope '${bindingRaw}' — defaulting to workspace`,
    );
  }
  return {
    name: yaml.name,
    // Widened union to match VALID_PARAMETER_TYPES; node_parameters table
    // accepts these after migration 0005.
    type: type as
      | 'string' | 'integer' | 'boolean' | 'number' | 'array' | 'object' | 'null' | 'enum',
    options,
    minValue: min,
    maxValue: max,
    defaultValue: yaml.default ?? null,
    bindingScope,
    ord,
  };
}

function adaptConstraint(yaml: YamlConstraint, ord: number, glmId: string, warnings: string[]) {
  const kind = yaml.kind ?? 'invariant';
  if (kind !== 'invariant' && kind !== 'guard' && kind !== 'postcondition') {
    warnings.push(`${glmId}.constraints[${ord}]: unknown kind '${kind}' — coerced to invariant`);
  }
  const severity = yaml.severity ?? 'error';
  return {
    ord,
    kind: (kind === 'invariant' || kind === 'guard' || kind === 'postcondition'
      ? kind
      : 'invariant') as 'invariant' | 'guard' | 'postcondition',
    expression: yaml.expression ?? '',
    severity: (severity === 'error' || severity === 'warning' ? severity : 'error') as
      | 'error'
      | 'warning',
  };
}

const RELATIONSHIP_KINDS = new Set([
  'composes-of',
  'depends-on',
  'derives-from',
  'implements',
  'generates',
  'varies-from',
]);

function adaptRelationship(
  yaml: YamlRelationship,
  ord: number,
  glmId: string,
  warnings: string[],
) {
  const kind = yaml.kind ?? 'composes-of';
  if (!RELATIONSHIP_KINDS.has(kind)) {
    warnings.push(`${glmId}.relationships[${ord}]: unknown kind '${kind}' — coerced to depends-on`);
  }
  return {
    ord,
    kind: (RELATIONSHIP_KINDS.has(kind) ? kind : 'depends-on') as
      | 'composes-of'
      | 'depends-on'
      | 'derives-from'
      | 'implements'
      | 'generates'
      | 'varies-from',
    targetGlmId: yaml.target ?? '',
    attributes: yaml.attributes ?? null,
  };
}

function normalizeIso(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
