import type { NodeRelationship, RelationshipKind, SekkeiNode } from '../types.ts';

/**
 * Where-Used traversal (spec §5.5).
 *
 * Inputs are passed in by the caller (the repository fetches all nodes +
 * relationships and hands them to this pure function). No I/O here.
 *
 * Conventions:
 *   - The "target" of where-used is a *glm_id*, since relationships address
 *     other nodes logically by that key (`target_glm_id`).
 *   - Direct dependents are sorted by relationship kind with `composes-of`
 *     first (AC-16), then by glm_id ascending for determinism.
 *   - Transitive consumers are a BFS from direct dependents *upward*, with
 *     each entry tagged by its depth (0 = direct, 1 = parent of direct, …).
 */

export interface NodeWithRels {
  node: SekkeiNode;
  relationships: NodeRelationship[];
}

export interface DirectDependent {
  source: SekkeiNode;
  kind: RelationshipKind;
  attributes: Record<string, unknown> | null;
}

export interface TransitiveConsumer {
  source: SekkeiNode;
  kind: RelationshipKind;
  depth: number;
  path: string[]; // glm_ids from target → consumer
}

export interface WhereUsedResult {
  target: string;
  direct: DirectDependent[];
  transitive: TransitiveConsumer[];
}

/** Nodes whose relationships point at `targetGlmId` by any kind. */
export function directDependents(targetGlmId: string, nodes: NodeWithRels[]): DirectDependent[] {
  const out: DirectDependent[] = [];
  for (const n of nodes) {
    for (const rel of n.relationships) {
      if (rel.targetGlmId === targetGlmId) {
        out.push({ source: n.node, kind: rel.kind, attributes: rel.attributes });
      }
    }
  }
  return sortDependents(out);
}

/** BFS upward from direct dependents. Each node appears at most once. */
export function transitiveConsumers(targetGlmId: string, nodes: NodeWithRels[]): TransitiveConsumer[] {
  const direct = directDependents(targetGlmId, nodes);
  if (direct.length === 0) return [];

  const visited = new Set<string>([targetGlmId]);
  const out: TransitiveConsumer[] = [];
  type Frame = { glmId: string; depth: number; path: string[]; kind: RelationshipKind };
  const queue: Frame[] = direct.map((d) => ({
    glmId: d.source.glmId,
    depth: 0,
    path: [targetGlmId, d.source.glmId],
    kind: d.kind,
  }));

  while (queue.length > 0) {
    const frame = queue.shift();
    if (!frame) break;
    if (visited.has(frame.glmId)) continue;
    visited.add(frame.glmId);

    const cur = nodes.find((n) => n.node.glmId === frame.glmId);
    if (!cur) continue;
    out.push({ source: cur.node, kind: frame.kind, depth: frame.depth, path: frame.path });

    const upstream = directDependents(frame.glmId, nodes);
    for (const u of upstream) {
      if (!visited.has(u.source.glmId)) {
        queue.push({
          glmId: u.source.glmId,
          depth: frame.depth + 1,
          path: [...frame.path, u.source.glmId],
          kind: u.kind,
        });
      }
    }
  }

  return out;
}

/** Combined direct + transitive query. */
export function whereUsed(targetGlmId: string, nodes: NodeWithRels[]): WhereUsedResult {
  return {
    target: targetGlmId,
    direct: directDependents(targetGlmId, nodes),
    transitive: transitiveConsumers(targetGlmId, nodes),
  };
}

/**
 * Estimated regeneration cost (spec §5.5 impact estimation model). Returns
 * the same shape the UI's variant impact table expects.
 */
export function estimateImpact(opts: {
  filesPerNode: number;
  hasOverride: boolean;
  inRollout: boolean;
  channel: 'canary' | 'stable' | 'experimental';
}): { mode: 'as_is' | 'with_override' | 'shadowed'; files: number; cacheMiss: number; tokens: number } {
  const { filesPerNode, hasOverride, inRollout, channel } = opts;
  const mode: 'as_is' | 'with_override' | 'shadowed' = hasOverride
    ? 'with_override'
    : inRollout
      ? 'as_is'
      : 'shadowed';

  const files = filesPerNode || 1;
  const cacheMiss = mode === 'shadowed' ? 0 : channel === 'experimental' ? 0.7 : 0.35;
  const tokens = Math.round(files * 1800 * (1 - 0.4 * (1 - cacheMiss)));
  return { mode, files, cacheMiss, tokens };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

const KIND_PRIORITY: Record<RelationshipKind, number> = {
  'composes-of': 0,
  'derives-from': 1,
  implements: 2,
  'depends-on': 3,
  generates: 4,
  'varies-from': 5,
};

function sortDependents(deps: DirectDependent[]): DirectDependent[] {
  return [...deps].sort((a, b) => {
    const ka = KIND_PRIORITY[a.kind] ?? 99;
    const kb = KIND_PRIORITY[b.kind] ?? 99;
    if (ka !== kb) return ka - kb;
    return a.source.glmId.localeCompare(b.source.glmId);
  });
}
