import type {
  NodeConstraint,
  NodeParameter,
  NodeRelationship,
  SekkeiNode,
  Stratum,
} from '../types.ts';
import { validateBody } from '../domain/node.ts';

/**
 * Six-gate sekkei verifier (spec §6.6, gate 2.b from v1.1.9).
 *
 * Pure functions. The caller loads the full workspace (nodes + supporting
 * rows) and hands it to each gate; nothing here reads the DB. Use the
 * runner (`runner.ts`) to compose the gates over a workspace and persist
 * the result into `verification_runs`.
 *
 * Each gate returns `{ name, passed, issues: string[] }`. An issue list of
 * length zero means the gate passed. The runner sums these into the
 * overall_pass boolean per the spec — any failed gate fails the run.
 */

export interface NodeRecord {
  node: SekkeiNode;
  parameters: NodeParameter[];
  constraints: NodeConstraint[];
  relationships: NodeRelationship[];
}

export interface GateResult {
  name: string;
  passed: boolean;
  issues: string[];
}

export interface VerifierInput {
  nodes: NodeRecord[];
  /** Optional brief: list of (glm_id, expected stratum) pairs that MUST exist. */
  brief?: Array<{ glmId: string; stratum: Stratum; label?: string }>;
}

export interface VerifierResult {
  gates: GateResult[];
  overallPass: boolean;
}

const ALLOWED_CHILDREN: Record<Stratum, Set<Stratum>> = {
  system: new Set(['system', 'capability'] as Stratum[]),
  capability: new Set(['component', 'interaction', 'spec'] as Stratum[]),
  component: new Set(['interaction', 'spec'] as Stratum[]),
  interaction: new Set(['spec'] as Stratum[]),
  spec: new Set(),
};

const VALID_REVISION_STATUS = new Set([
  'in_work',
  'in_review',
  'released',
  'superseded',
  'obsolete',
]);

const VALID_OVERRIDE_KIND = new Set(['net_new', 'derives-from', 'refines']);

const REQUIRED_SPEC_KINDS_PER_COMPONENT = ['functional', 'technical', 'acceptance', 'prompt'] as const;

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** Run every gate in order and aggregate the result. */
export function runGates(input: VerifierInput): VerifierResult {
  const gates: GateResult[] = [
    gate1Envelope(input.nodes),
    gate2StratumHierarchy(input.nodes),
    gate2bRoleConsistency(input.nodes),
    gate3ClosureCompleteness(input.nodes),
    gate4BriefCoverage(input.nodes, input.brief),
    gate5SpecCoverage(input.nodes),
    gate6SpecQuality(input.nodes),
  ];
  return { gates, overallPass: gates.every((g) => g.passed) };
}

// ---------------------------------------------------------------------------
// Gate 1: Envelope
// ---------------------------------------------------------------------------

export function gate1Envelope(nodes: NodeRecord[]): GateResult {
  const issues: string[] = [];
  for (const { node } of nodes) {
    if (!node.glmId) issues.push(`<no-id>: missing glm_id`);
    if (!node.title) issues.push(`${node.glmId}: missing title`);
    if (!VALID_REVISION_STATUS.has(node.revisionStatus)) {
      issues.push(`${node.glmId}: revision.status '${node.revisionStatus}' invalid`);
    }
    if (!VALID_OVERRIDE_KIND.has(node.overrideKind)) {
      issues.push(`${node.glmId}: override_kind '${node.overrideKind}' invalid`);
    }
    if (node.stratum === 'spec' && !node.specKind) {
      issues.push(`${node.glmId}: spec stratum requires spec_kind`);
    }
    const bodyResult = validateBody(node.stratum, node.body);
    if (!bodyResult.ok) {
      issues.push(`${node.glmId}: body invalid (${bodyResult.issues.join('; ')})`);
    }
  }
  return { name: '1.envelope', passed: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Gate 2: Stratum hierarchy
// ---------------------------------------------------------------------------

export function gate2StratumHierarchy(nodes: NodeRecord[]): GateResult {
  const issues: string[] = [];
  const byGlm = new Map<string, NodeRecord>(nodes.map((r) => [r.node.glmId, r]));
  for (const parent of nodes) {
    for (const rel of parent.relationships) {
      if (rel.kind !== 'composes-of') continue;
      const child = byGlm.get(rel.targetGlmId);
      if (!child) continue; // closure gate reports missing
      const allowed = ALLOWED_CHILDREN[parent.node.stratum];
      if (!allowed.has(child.node.stratum)) {
        issues.push(
          `STRATUM VIOLATION: ${parent.node.glmId} (${parent.node.stratum}) -> ${child.node.glmId} (${child.node.stratum}); allowed: ${[...allowed].join(', ')}`,
        );
      }
    }
  }
  return { name: '2.stratum_hierarchy', passed: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Gate 2.b: Role consistency (v1.1.9 system_role discriminator)
// ---------------------------------------------------------------------------

export function gate2bRoleConsistency(nodes: NodeRecord[]): GateResult {
  const issues: string[] = [];
  const byGlm = new Map<string, NodeRecord>(nodes.map((r) => [r.node.glmId, r]));
  const systems = nodes.filter((r) => r.node.stratum === 'system');
  if (systems.length === 0) {
    return { name: '2.b.role_consistency', passed: true, issues: [] };
  }

  const composedSystems = new Set<string>();
  for (const r of nodes) {
    for (const rel of r.relationships) {
      if (rel.kind !== 'composes-of') continue;
      const target = byGlm.get(rel.targetGlmId);
      if (target && target.node.stratum === 'system') {
        composedSystems.add(target.node.glmId);
      }
    }
  }

  let rootCount = 0;
  for (const r of systems) {
    const body = r.node.body as Record<string, unknown>;
    const role = r.node.systemRole ?? (body?.system_role as string | undefined);
    const isComposed = composedSystems.has(r.node.glmId);
    if (!role) {
      issues.push(`${r.node.glmId}: missing system_role`);
      continue;
    }
    if (role === 'root') {
      rootCount++;
      if (isComposed) {
        issues.push(`${r.node.glmId}: declares system_role=root but is composed-of by another System`);
      }
      if (!('acceptance_gate' in (body ?? {}))) {
        issues.push(`${r.node.glmId}: system_role=root requires body.acceptance_gate`);
      }
    } else if (role === 'subsystem') {
      if (!isComposed) {
        issues.push(`${r.node.glmId}: declares system_role=subsystem but is NOT composed-of by any System`);
      }
      if (body && body.dbom_ref !== undefined && body.dbom_ref !== null) {
        issues.push(`${r.node.glmId}: system_role=subsystem requires body.dbom_ref=null`);
      }
    } else if (role !== 'platform') {
      issues.push(`${r.node.glmId}: invalid system_role '${role}'`);
    }
  }
  if (rootCount !== 1) {
    issues.push(`cardinality error: expected exactly 1 root System; found ${rootCount}`);
  }
  return { name: '2.b.role_consistency', passed: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Gate 3: Closure completeness
// ---------------------------------------------------------------------------

const EXTERNAL_PREFIXES = ['pkg:', 'dep:', 'svc:', 'hw:'];

export function gate3ClosureCompleteness(nodes: NodeRecord[]): GateResult {
  const issues: string[] = [];
  const byGlm = new Set(nodes.map((r) => r.node.glmId));
  for (const r of nodes) {
    for (const rel of r.relationships) {
      const target = rel.targetGlmId;
      if (EXTERNAL_PREFIXES.some((p) => target.startsWith(p))) continue;
      if (!target.startsWith('glm:')) continue;
      if (!byGlm.has(target)) {
        issues.push(`${r.node.glmId} -> ${rel.kind} -> MISSING: ${target}`);
      }
    }
  }
  return { name: '3.closure_completeness', passed: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Gate 4: Brief coverage
// ---------------------------------------------------------------------------

export function gate4BriefCoverage(
  nodes: NodeRecord[],
  brief?: Array<{ glmId: string; stratum: Stratum; label?: string }>,
): GateResult {
  const issues: string[] = [];
  if (!brief || brief.length === 0) {
    return { name: '4.brief_coverage', passed: true, issues: [] };
  }
  const byGlm = new Map<string, NodeRecord>(nodes.map((r) => [r.node.glmId, r]));
  for (const req of brief) {
    const found = byGlm.get(req.glmId);
    if (!found) {
      issues.push(`MISSING ${req.label ?? req.glmId}: ${req.glmId}`);
      continue;
    }
    if (found.node.stratum !== req.stratum) {
      issues.push(
        `STRATUM MISMATCH for ${req.label ?? req.glmId}: expected ${req.stratum}, got ${found.node.stratum}`,
      );
    }
  }
  return { name: '4.brief_coverage', passed: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Gate 5: Spec coverage
// ---------------------------------------------------------------------------

export function gate5SpecCoverage(nodes: NodeRecord[]): GateResult {
  const issues: string[] = [];
  const components = nodes.filter((r) => r.node.stratum === 'component');
  const specsForComponent = new Map<string, Set<string>>();
  for (const comp of components) specsForComponent.set(comp.node.glmId, new Set());

  for (const r of nodes) {
    if (r.node.stratum !== 'spec') continue;
    const sk = r.node.specKind ?? '';
    if (!sk) continue;
    let best: string | null = null;
    for (const comp of components) {
      const cid = comp.node.glmId;
      if ((r.node.glmId.startsWith(`${cid}.spec`) || r.node.glmId.startsWith(`${cid}.spec_`))) {
        if (best === null || cid.length > best.length) best = cid;
      }
    }
    if (best) specsForComponent.get(best)?.add(sk);
  }

  for (const comp of components) {
    const present = specsForComponent.get(comp.node.glmId) ?? new Set();
    const missing = REQUIRED_SPEC_KINDS_PER_COMPONENT.filter((k) => !present.has(k));
    if (missing.length > 0) {
      issues.push(`${comp.node.glmId}: missing ${missing.join(', ')}`);
    }
  }
  return { name: '5.spec_coverage', passed: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Gate 6: Spec quality
// ---------------------------------------------------------------------------

export function gate6SpecQuality(nodes: NodeRecord[]): GateResult {
  const issues: string[] = [];
  for (const r of nodes) {
    if (r.node.stratum !== 'spec') continue;
    const sk = r.node.specKind ?? '';
    const body = r.node.body as Record<string, unknown>;
    if (sk === 'acceptance') {
      const hasV11 = 'deliverables' in body && 'verifier' in body;
      const hasLegacy = 'inspection_assertions' in body;
      if (!hasV11 && !hasLegacy) {
        issues.push(
          `${r.node.glmId}: acceptance lacks both v1.1 (deliverables+verifier) and legacy (inspection_assertions)`,
        );
      }
    }
    if (sk === 'prompt') {
      for (const key of ['context_bundle', 'outputs', 'verifier']) {
        if (!(key in body)) issues.push(`${r.node.glmId}: prompt missing body.${key}`);
      }
    }
  }
  return { name: '6.spec_quality', passed: issues.length === 0, issues };
}
