/**
 * Shared TypeScript types for GLM entities.
 *
 * Repository methods return values shaped by these types. Snake_case columns
 * in SQLite are mapped to camelCase fields here; the mapping happens in each
 * repository's `row → domain` function so the rest of the codebase never
 * sees raw DB rows.
 *
 * `body` is a typed union by `stratum`; the body shape is enforced both at
 * the DB layer (CHECK constraints on stratum + system_role / spec_kind) and
 * here in the type system.
 */

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export type IsoDateTime = string;
export type Sha256Hash = string; // 'sha256:<hex>'

// ---------------------------------------------------------------------------
// Users / Workspaces
// ---------------------------------------------------------------------------

export type UserRole = 'admin' | 'editor' | 'reviewer' | 'viewer';

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  createdAt: IsoDateTime;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  createdAt: IsoDateTime;
  /** Non-null when a git remote has been attached (Git Step 1). */
  gitRemote: string | null;
  /** Branch/ref to track, e.g. `refs/heads/next`. */
  gitRef: string | null;
  /** SHA of the last synced HEAD. */
  gitCommit: string | null;
  /** Absolute path to the local clone. */
  gitCloneDir: string | null;
  /** Forge type for PR automation. */
  gitForge: 'github' | 'gitlab' | null;
  /** When true, ECN commits are pushed immediately. */
  gitAutoPush: boolean;
}

export type WorkspaceMemberRole = 'owner' | 'maintainer' | 'editor' | 'reviewer' | 'viewer';

export interface WorkspaceMember {
  workspaceId: string;
  userId: string;
  role: WorkspaceMemberRole;
  joinedAt: IsoDateTime;
}

export interface WorkspaceConflict {
  id: string;
  workspaceId: string;
  localCommit: string;
  remoteCommit: string;
  status: 'open' | 'resolved';
  createdAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type Stratum = 'system' | 'capability' | 'component' | 'interaction' | 'spec';
export type RevisionStatus = 'in_work' | 'in_review' | 'released' | 'superseded' | 'obsolete';
export type OverrideKind = 'net_new' | 'derives-from' | 'refines';

export interface SystemBody {
  system_role: string;
  dbom_ref?: string | null;
  runtime?: string | null;
}

export interface CapabilityBody {
  user_value: string;
}

export interface ComponentBody {
  boundary: string;
  runtime: string;
}

export type InteractionBody =
  | { contract: 'fsm'; states: string[]; transitions: string[] }
  | { contract: 'integration_adapter'; endpoints: string[] }
  | { contract: 'schema_binding'; schema: Record<string, unknown> }
  | { contract: 'event_flow'; listener: string };

export interface SpecBody {
  spec_kind: string;
  content: string;
  inspection_assertions?: Array<{ id: string; kind: string; expression: string }>;
  context_bundle?: string[];
  outputs?: string[];
  verifier?: string;
}

export type NodeBody = SystemBody | CapabilityBody | ComponentBody | InteractionBody | SpecBody;

export interface GeneratorIdentity {
  llm: string;
  promptVersion?: string;
  toolChain?: string;
  [key: string]: unknown;
}

export interface SekkeiNode {
  id: string;
  workspaceId: string;
  glmId: string;
  stratum: Stratum;
  title: string;
  description: string;
  body: NodeBody;
  contentHash: Sha256Hash;
  revisionMajor: string;
  revisionIteration: number;
  revisionStatus: RevisionStatus;
  overrideKind: OverrideKind;
  derivesFromNodeId: string | null;
  systemRole: string | null;
  specKind: string | null;
  authoredBy: string;
  authoredAt: IsoDateTime;
  updatedAt: IsoDateTime;
  generatorIdentity: GeneratorIdentity | null;
}

export type NodeInsert = Omit<SekkeiNode, 'contentHash' | 'authoredAt' | 'updatedAt'> & {
  authoredAt?: IsoDateTime;
  updatedAt?: IsoDateTime;
};

// ---------------------------------------------------------------------------
// Supporting node tables
// ---------------------------------------------------------------------------

/**
 * JSON Schema type values accepted on a node parameter.
 *
 * v1.1 spec: parameter.schema is a full JSON Schema fragment; the
 * primitive types (string, integer, boolean, number, array, object, null)
 * are all valid. 'enum' is kept as a legacy alias for back-compat with
 * pre-v1.1 sekkeis that used type='enum' instead of decorating a primitive
 * type with the JSON Schema `enum` keyword. Migration 0005 widened the DB
 * CHECK to accept all of these.
 */
export type ParameterType =
  | 'string' | 'integer' | 'boolean' | 'number'
  | 'array' | 'object' | 'null'
  | 'enum';

/**
 * Where the parameter is bound in the resolution lifecycle.
 *
 * The v1.1 spec values name the STRATUM at which the parameter is
 * declared (visibility scope; descendants inherit). The pre-v1.1 values
 * name the LIFECYCLE PHASE at which it is bound (timing). Migration 0005
 * widened the DB CHECK to accept both sets; rows persisted before the
 * migration retain their workspace/variant/instance values.
 */
export type ParameterBindingScope =
  // v1.1 spec — stratum of declaration
  | 'system' | 'capability' | 'component' | 'interaction' | 'spec'
  // pre-v1.1 — lifecycle phase of binding
  | 'workspace' | 'variant' | 'instance';

export interface NodeParameter {
  nodeId: string;
  name: string;
  type: ParameterType;
  options: unknown[] | null;
  minValue: number | null;
  maxValue: number | null;
  defaultValue: unknown;
  bindingScope: ParameterBindingScope;
  ord: number;
}

export type ConstraintKind = 'invariant' | 'guard' | 'postcondition';
export type ConstraintSeverity = 'error' | 'warning';

export interface NodeConstraint {
  nodeId: string;
  ord: number;
  kind: ConstraintKind;
  expression: string;
  severity: ConstraintSeverity;
}

export type RelationshipKind =
  | 'composes-of'
  | 'depends-on'
  | 'derives-from'
  | 'implements'
  | 'generates'
  | 'varies-from';

export interface NodeRelationship {
  sourceNodeId: string;
  ord: number;
  kind: RelationshipKind;
  targetGlmId: string;
  attributes: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Operational tables
// ---------------------------------------------------------------------------

export interface ExternalDep {
  workspaceId: string;
  purl: string;
  role: string;
  license: string | null;
  notes: Record<string, unknown> | null;
}

export interface GeneratedArtifact {
  id: string;
  workspaceId: string;
  sourceNodeId: string;
  path: string;
  contentHash: Sha256Hash;
  generationHash: Sha256Hash;
  generatorIdentity: GeneratorIdentity;
  generatedAt: IsoDateTime;
}

export interface EditLock {
  nodeId: string;
  userId: string;
  acquiredAt: IsoDateTime;
  heartbeatAt: IsoDateTime;
}

export type ChangeLogOp = 'create' | 'update' | 'delete' | 'git-sync';

export interface ChangeLogEntry {
  id: number;
  workspaceId: string;
  nodeId: string | null;
  /** Null for system-originated entries (git-sync, startup reconciliation). */
  userId: string | null;
  op: ChangeLogOp;
  beforeContentHash: Sha256Hash | null;
  afterContentHash: Sha256Hash | null;
  ts: IsoDateTime;
}

export interface VerificationRun {
  id: string;
  workspaceId: string;
  ts: IsoDateTime;
  gateResults: Record<string, unknown>;
  overallPass: boolean;
}

export interface AuditEvent {
  id: string;
  workspaceId: string;
  userId: string;
  eventType: string;
  payload: Record<string, unknown>;
  ts: IsoDateTime;
}

// ---------------------------------------------------------------------------
// SCR / SCO
// ---------------------------------------------------------------------------

export type ScrClass = 'I' | 'II';
export type ScrStatus =
  | 'Draft'
  | 'Submitted'
  | 'Under Review'
  | 'Approved'
  | 'Returned'
  | 'Rejected'
  | 'Implemented'
  | 'Released';

export interface ScrDiffLine {
  line: string;
  kind: 'context' | 'add' | 'remove' | 'change';
}

export interface ScrImpact {
  variantsAffected: number;
  tokensEst: number;
  cacheMissCount: number;
}

export interface Scr {
  id: string;
  workspaceId: string;
  title: string;
  scrClass: ScrClass;
  status: ScrStatus;
  proposer: string;
  proposedAt: IsoDateTime;
  problem: string;
  diffYaml: ScrDiffLine[];
  targetNodes: string[];
  effectivity: string | null;
  returnReason: string | null;
  impact: ScrImpact | null;
  /** SHA of the ECN commit produced on `implement` (Git Step 3). */
  gitCommit: string | null;
  /** Feature branch name; kept for audit even after the branch is deleted. */
  gitBranch: string | null;
  /** Forge PR/MR URL when workspace.gitForge is set. */
  gitPrUrl: string | null;
}

export type ScrApprovalDecision = 'approve' | 'return' | 'reject' | 'pending';

export interface ScrApproval {
  scrId: string;
  who: string;
  decision: ScrApprovalDecision;
  decidedAt: IsoDateTime | null;
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

export type VariantChannel = 'canary' | 'stable' | 'experimental';
export type VariantPinPolicy = 'pin-on-release' | 'track-latest' | 'frozen';

export interface Variant {
  id: string;
  workspaceId: string;
  label: string;
  instance: string | null;
  channel: VariantChannel;
  pinPolicyDefault: VariantPinPolicy;
  /** Branch ref (`variants/<label>`); non-null after first publish. */
  gitRef: string | null;
  /** SHA of the most recent lock commit. */
  gitCommit: string | null;
  /** sha256 of the serialized sekkei.lock bytes. */
  closureHash: string | null;
  /** Always `sekkei.lock` for v1. */
  sekkeiLockPath: string | null;
}

export type VariantRolloutState =
  | 'Released'
  | 'Available-on-Channel'
  | 'Pinned-by-Variant'
  | 'Generated-for-Instance'
  | 'Deployed-to-dBOM';

export interface VariantRollout {
  variantId: string;
  nodeId: string;
  availableRev: string | null;
  pinRev: string | null;
  state: VariantRolloutState;
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

export type DriftStatus = 'Synced' | 'Hash-Drifted' | 'Live-Drifted' | 'Suspended';
export type DriftKind = 'none' | 'hash' | 'live_state';
export type DriftPolicy = 'auto-heal' | 'alert' | 'suspend';
/** How a realization change was classified during the git-based drift sweep (Git Step 6). */
export type DriftGitClassification = 'format' | 'spec_implied' | 'human_improvement' | 'hot_patch';

export interface DriftRecord {
  id: string;
  workspaceId: string;
  nodeId: string;
  file: string;
  status: DriftStatus;
  kind: DriftKind;
  desiredHash: Sha256Hash | null;
  observedHash: Sha256Hash | null;
  policy: DriftPolicy;
  detail: string | null;
  detectedAt: IsoDateTime;
  /** Git Step 6: HEAD SHA of the realization clone at sweep time. */
  realizationCommit: string | null;
  /** Git Step 6: HEAD SHA of the sekkei repo at sweep time. */
  specCommit: string | null;
  /** Git Step 6: how the realization change was classified. */
  classification: DriftGitClassification | null;
  /** Git Step 6: true when the classification can be auto-resolved (e.g. format-only). */
  autoResolvable: boolean;
}

// ---------------------------------------------------------------------------
// Reuse
// ---------------------------------------------------------------------------

export type ReuseStage =
  | 'Variant-Local'
  | 'Candidate-for-Promotion'
  | 'Promoted-to-Library'
  | 'Stewarded-by-Owner';

export interface ReuseCandidate {
  id: string;
  workspaceId: string;
  subtree: string;
  title: string;
  stage: ReuseStage;
  rationale: string;
  usages: number;
  invariantsHeldIn: number;
  steward: string | null;
}

// ---------------------------------------------------------------------------
// Rollout records (Git Step 8)
// ---------------------------------------------------------------------------

export type RolloutStatus = 'pending' | 'advanced' | 'blocked';

/**
 * Tracks node-by-node rollout progress for a specific release tag.
 * One row per (variant, node, release_tag) triple.
 */
export interface RolloutRecord {
  id: string;
  variantId: string;
  nodeId: string;
  /** content_hash of the node at the prior release; null for the first release. */
  fromRev: string | null;
  /** content_hash of the node at this release. */
  toRev: string | null;
  status: RolloutStatus;
  /** Operator-set pin for this rollout step; null means use variant default. */
  pinRev: string | null;
  releaseTag: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export type ProvenanceCache = 'hit' | 'miss';

export interface ProvenanceEvent {
  id: string;
  workspaceId: string;
  occurredAt: IsoDateTime;
  subjectFile: string;
  subjectDigest: Sha256Hash;
  sekkeiRoot: string;
  sekkeiRev: string;
  sekkeiLock: string;
  bindingHash: Sha256Hash;
  generatorLlm: string;
  generatorPromptVersion: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  cache: ProvenanceCache;
  signed: boolean;
  note: string | null;
}
