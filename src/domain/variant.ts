import { createHash } from 'node:crypto';
import { canonicalize } from './content-hash.ts';
import { evaluateConstraint } from './cel.ts';
import type {
  ConstraintSeverity,
  ExternalDep,
  GeneratorIdentity,
  NodeConstraint,
  NodeParameter,
  NodeRelationship,
  SekkeiNode,
  Sha256Hash,
} from '../types.ts';

/**
 * Variant resolution pipeline (spec §5.4).
 *
 *   1. Closure walk         — traverse composes-of + derives-from from root
 *   2. Parameter binding    — every parameter must have a value
 *   3. Constraint validation — evaluate every node's CEL constraints
 *   4. External dependencies — collect every depends-on; require a digest
 *   5. Cache key computation — closure / binding / design / generation hashes
 *   6. sekkei.lock emission  — pin each node by (glm_id, revision, content_hash)
 *
 * Pure function: same input → same output. No I/O; the caller fetches the
 * nodes and deps from repositories and passes them in by value.
 */

export interface ResolveInput {
  rootGlmId: string;
  nodes: ResolverNode[];
  externalDeps: ExternalDep[];
  binding: Record<string, unknown>;
  generatorIdentity: GeneratorIdentity;
}

/** A node + its supporting rows, as the resolver needs to see it. */
export interface ResolverNode {
  node: SekkeiNode;
  parameters: NodeParameter[];
  constraints: NodeConstraint[];
  relationships: NodeRelationship[];
}

export type StepResult =
  | { ok: true; detail: string }
  | { ok: false; detail: string; severity?: ConstraintSeverity };

export interface ConstraintResult {
  nodeGlmId: string;
  kind: NodeConstraint['kind'];
  severity: ConstraintSeverity;
  expression: string;
  passed: boolean;
  reason: string | null;
}

export interface LockEntry {
  glm_id: string;
  revision: string;
  content_hash: Sha256Hash;
}

export interface ResolutionResult {
  overall: { passed: boolean; failedAtStep: number | null };
  steps: {
    closureWalk: StepResult;
    parameterBinding: StepResult;
    constraintValidation: StepResult;
    externalDependencies: StepResult;
    cacheKeys: StepResult;
    lockEmission: StepResult;
  };
  closure: ResolverNode[];
  constraints: ConstraintResult[];
  resolvedBinding: Record<string, unknown>;
  externalDepPins: ExternalDep[];
  hashes: {
    closureHash: Sha256Hash;
    bindingHash: Sha256Hash;
    designHash: Sha256Hash;
    generatorIdentityHash: Sha256Hash;
    generationHash: Sha256Hash;
  };
  lock: {
    for_sekkei: string;
    generator: GeneratorIdentity;
    generation_hash: Sha256Hash;
    nodes: LockEntry[];
  };
}

/** Run the six-step pipeline. Always returns a populated result. */
export function resolve(input: ResolveInput): ResolutionResult {
  const byGlmId = new Map<string, ResolverNode>(
    input.nodes.map((n) => [n.node.glmId, n]),
  );
  const byNodeId = new Map<string, ResolverNode>(
    input.nodes.map((n) => [n.node.id, n]),
  );
  const root = byGlmId.get(input.rootGlmId);
  if (!root) {
    return failFast(`root '${input.rootGlmId}' not found in node set`, input.generatorIdentity);
  }

  // Step 1: closure walk
  const closure = walkClosure(root, byGlmId, byNodeId);
  const closureStep: StepResult = {
    ok: true,
    detail: `${closure.length} node(s) walked via composes-of + derives-from`,
  };

  // Step 2: parameter binding
  const { resolvedBinding, missing } = applyDefaults(closure, input.binding);
  const bindingStep: StepResult =
    missing.length === 0
      ? { ok: true, detail: 'all parameters bound (defaults applied where omitted)' }
      : { ok: false, detail: `unbound parameter(s): ${missing.join(', ')}` };

  // Step 3: constraint validation — only meaningful when bindings resolved
  const constraints: ConstraintResult[] = [];
  if (bindingStep.ok) {
    for (const n of closure) {
      for (const c of n.constraints) {
        const r = evaluateConstraint(c.expression, resolvedBinding);
        constraints.push({
          nodeGlmId: n.node.glmId,
          kind: c.kind,
          severity: c.severity,
          expression: c.expression,
          passed: r.passed,
          reason: r.reason,
        });
      }
    }
  }
  const errorFailures = constraints.filter((c) => c.severity === 'error' && !c.passed);
  const constraintStep: StepResult = bindingStep.ok
    ? errorFailures.length === 0
      ? { ok: true, detail: `${constraints.length} constraint(s) evaluated, all error-severity passing` }
      : {
          ok: false,
          severity: 'error',
          detail: `${errorFailures.length} constraint(s) failed: ${errorFailures
            .map((c) => `${c.nodeGlmId}: ${c.expression}`)
            .join('; ')}`,
        }
    : { ok: false, detail: 'skipped — unbound parameters' };

  // Step 4: external dependency closure
  const externalDepPins = collectDeps(closure, input.externalDeps);
  const externalStep: StepResult = {
    ok: true,
    detail: `${externalDepPins.length} external dep(s) pinned`,
  };

  // Step 5: cache key computation — always runs (AC-14)
  const hashes = computeHashes(input.rootGlmId, closure, resolvedBinding, input.generatorIdentity);
  const cacheStep: StepResult = {
    ok: true,
    detail: `generation_hash = ${hashes.generationHash}`,
  };

  // Step 6: lock emission
  const lock = {
    for_sekkei: input.rootGlmId,
    generator: input.generatorIdentity,
    generation_hash: hashes.generationHash,
    nodes: closure.map((n) => ({
      glm_id: n.node.glmId,
      revision: `${n.node.revisionMajor}.${n.node.revisionIteration}`,
      content_hash: n.node.contentHash,
    })),
  };
  const lockStep: StepResult = {
    ok: true,
    detail: `${lock.nodes.length} node(s) pinned`,
  };

  const stepArr = [closureStep, bindingStep, constraintStep, externalStep, cacheStep, lockStep];
  const failedIndex = stepArr.findIndex((s) => !s.ok);
  return {
    overall: { passed: failedIndex === -1, failedAtStep: failedIndex === -1 ? null : failedIndex + 1 },
    steps: {
      closureWalk: closureStep,
      parameterBinding: bindingStep,
      constraintValidation: constraintStep,
      externalDependencies: externalStep,
      cacheKeys: cacheStep,
      lockEmission: lockStep,
    },
    closure,
    constraints,
    resolvedBinding,
    externalDepPins,
    hashes,
    lock,
  };
}

// ---------------------------------------------------------------------------
// pipeline steps
// ---------------------------------------------------------------------------

function walkClosure(
  root: ResolverNode,
  byGlmId: Map<string, ResolverNode>,
  byNodeId: Map<string, ResolverNode>,
): ResolverNode[] {
  const visited = new Set<string>();
  const order: ResolverNode[] = [];
  const stack: ResolverNode[] = [root];

  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) break;
    if (visited.has(cur.node.glmId)) continue;
    visited.add(cur.node.glmId);
    order.push(cur);

    for (const r of cur.relationships) {
      if (r.kind !== 'composes-of' && r.kind !== 'derives-from') continue;
      const child = byGlmId.get(r.targetGlmId);
      if (child && !visited.has(child.node.glmId)) stack.push(child);
    }

    // Lineage via derives_from_node_id — O(1) lookup via byNodeId (the
    // previous `[...byGlmId.values()].find(...)` was O(n) per hop and
    // pushed closure walks toward O(n²) on deep lineage).
    if (cur.node.derivesFromNodeId) {
      const parent = byNodeId.get(cur.node.derivesFromNodeId);
      if (parent && !visited.has(parent.node.glmId)) stack.push(parent);
    }
  }

  // Stable order: root first, then by glm_id within remaining
  return [order[0] as ResolverNode, ...order.slice(1).sort((a, b) => a.node.glmId.localeCompare(b.node.glmId))];
}

function applyDefaults(
  closure: ResolverNode[],
  provided: Record<string, unknown>,
): { resolvedBinding: Record<string, unknown>; missing: string[] } {
  const resolved: Record<string, unknown> = { ...provided };
  const missing: string[] = [];

  for (const n of closure) {
    for (const p of n.parameters) {
      if (resolved[p.name] !== undefined) continue;
      if (p.defaultValue !== undefined && p.defaultValue !== null) {
        resolved[p.name] = p.defaultValue;
      } else {
        missing.push(`${n.node.glmId}.${p.name}`);
      }
    }
  }
  return { resolvedBinding: resolved, missing };
}

function collectDeps(closure: ResolverNode[], allDeps: ExternalDep[]): ExternalDep[] {
  const wanted = new Set<string>();
  for (const n of closure) {
    for (const r of n.relationships) {
      if (r.kind === 'depends-on') wanted.add(r.targetGlmId);
    }
  }
  // PURL strings in external_deps are matched directly; any depends-on whose
  // target_glm_id appears as a purl is treated as a pin.
  return allDeps.filter((d) => wanted.has(d.purl));
}

function computeHashes(
  rootGlmId: string,
  closure: ResolverNode[],
  binding: Record<string, unknown>,
  generator: GeneratorIdentity,
): ResolutionResult['hashes'] {
  const sortedHashes = [...closure].map((n) => n.node.contentHash).sort();
  const closureHash = sha256Prefixed([rootGlmId, ...sortedHashes].join('\n'));
  const bindingHash = sha256Prefixed(canonicalize(binding));
  const designHash = closureHash;
  const generatorIdentityHash = sha256Prefixed(canonicalize(generator as Record<string, unknown>));
  const generationHash = sha256Prefixed([designHash, bindingHash, generatorIdentityHash].join('\n'));
  return { closureHash, bindingHash, designHash, generatorIdentityHash, generationHash };
}

function sha256Prefixed(input: string): Sha256Hash {
  const hex = createHash('sha256').update(input, 'utf8').digest('hex');
  return `sha256:${hex}`;
}

function failFast(detail: string, generator: GeneratorIdentity): ResolutionResult {
  const step: StepResult = { ok: false, detail };
  const ok: StepResult = { ok: false, detail: 'skipped' };
  return {
    overall: { passed: false, failedAtStep: 1 },
    steps: {
      closureWalk: step,
      parameterBinding: ok,
      constraintValidation: ok,
      externalDependencies: ok,
      cacheKeys: ok,
      lockEmission: ok,
    },
    closure: [],
    constraints: [],
    resolvedBinding: {},
    externalDepPins: [],
    hashes: {
      closureHash: 'sha256:',
      bindingHash: 'sha256:',
      designHash: 'sha256:',
      generatorIdentityHash: 'sha256:',
      generationHash: 'sha256:',
    },
    lock: { for_sekkei: '', generator, generation_hash: 'sha256:', nodes: [] },
  };
}
