import { describe, expect, test } from 'bun:test';
import {
  directDependents,
  estimateImpact,
  type NodeWithRels,
  transitiveConsumers,
  whereUsed,
} from '../../../src/domain/relationships.ts';
import type { NodeRelationship, RelationshipKind, SekkeiNode } from '../../../src/types.ts';

function mkNode(glmId: string, overrides: Partial<SekkeiNode> = {}): SekkeiNode {
  return {
    id: `id-${glmId}`,
    workspaceId: 'ws-1',
    glmId,
    stratum: 'component',
    title: glmId,
    description: '',
    body: { boundary: 'b', runtime: 'r' },
    contentHash: 'sha256:0',
    revisionMajor: 'A',
    revisionIteration: 0,
    revisionStatus: 'in_work',
    overrideKind: 'net_new',
    derivesFromNodeId: null,
    systemRole: null,
    specKind: null,
    authoredBy: 'alice',
    authoredAt: '2026-05-11T00:00:00.000Z',
    updatedAt: '2026-05-11T00:00:00.000Z',
    generatorIdentity: null,
    ...overrides,
  };
}

function rel(sourceGlm: string, targetGlm: string, kind: RelationshipKind, ord = 0): NodeRelationship {
  return { sourceNodeId: `id-${sourceGlm}`, ord, kind, targetGlmId: targetGlm, attributes: null };
}

function n(glmId: string, rels: NodeRelationship[] = []): NodeWithRels {
  return { node: mkNode(glmId), relationships: rels };
}

describe('directDependents', () => {
  test('finds all nodes whose relationships point at target', () => {
    const nodes = [
      n('a', [rel('a', 'target', 'composes-of')]),
      n('b', [rel('b', 'target', 'depends-on')]),
      n('c', [rel('c', 'unrelated', 'composes-of')]),
    ];
    const deps = directDependents('target', nodes);
    expect(deps.map((d) => d.source.glmId).sort()).toEqual(['a', 'b']);
  });

  test('AC-16: composes-of is listed first among direct dependents', () => {
    const nodes = [
      n('z-depends', [rel('z-depends', 'target', 'depends-on')]),
      n('a-composes', [rel('a-composes', 'target', 'composes-of')]),
      n('m-implements', [rel('m-implements', 'target', 'implements')]),
    ];
    const deps = directDependents('target', nodes);
    expect(deps[0]?.kind).toBe('composes-of');
    expect(deps.map((d) => d.source.glmId)).toEqual(['a-composes', 'm-implements', 'z-depends']);
  });
});

describe('transitiveConsumers', () => {
  test('walks BFS upward from direct dependents', () => {
    // A composes-of target; B composes-of A; C composes-of B
    const nodes = [
      n('target'),
      n('a', [rel('a', 'target', 'composes-of')]),
      n('b', [rel('b', 'a', 'composes-of')]),
      n('c', [rel('c', 'b', 'composes-of')]),
    ];
    const transitive = transitiveConsumers('target', nodes);
    const map = new Map(transitive.map((t) => [t.source.glmId, t.depth]));
    expect(map.get('a')).toBe(0);
    expect(map.get('b')).toBe(1);
    expect(map.get('c')).toBe(2);
  });

  test('does not revisit nodes (cycles tolerated)', () => {
    const nodes = [
      n('target'),
      n('a', [rel('a', 'target', 'composes-of'), rel('a', 'b', 'depends-on')]),
      n('b', [rel('b', 'a', 'depends-on')]),
    ];
    const transitive = transitiveConsumers('target', nodes);
    const glms = transitive.map((t) => t.source.glmId);
    expect(new Set(glms).size).toBe(glms.length);
  });

  test('AC-17: empty result when no consumer references the target', () => {
    const nodes = [n('lonely')];
    expect(transitiveConsumers('target', nodes)).toEqual([]);
    expect(directDependents('target', nodes)).toEqual([]);
  });
});

describe('whereUsed', () => {
  test('returns target id + direct + transitive together', () => {
    const nodes = [
      n('target'),
      n('a', [rel('a', 'target', 'composes-of')]),
    ];
    const r = whereUsed('target', nodes);
    expect(r.target).toBe('target');
    expect(r.direct.length).toBe(1);
    expect(r.transitive.length).toBe(1);
  });
});

describe('estimateImpact', () => {
  test('shadowed nodes have zero cache miss', () => {
    const r = estimateImpact({ filesPerNode: 3, hasOverride: false, inRollout: false, channel: 'stable' });
    expect(r.mode).toBe('shadowed');
    expect(r.cacheMiss).toBe(0);
  });
  test('with_override mode wins over inRollout', () => {
    const r = estimateImpact({ filesPerNode: 2, hasOverride: true, inRollout: true, channel: 'canary' });
    expect(r.mode).toBe('with_override');
  });
  test('experimental channel has higher cache miss probability than stable', () => {
    const exp = estimateImpact({ filesPerNode: 1, hasOverride: false, inRollout: true, channel: 'experimental' });
    const sta = estimateImpact({ filesPerNode: 1, hasOverride: false, inRollout: true, channel: 'stable' });
    expect(exp.cacheMiss).toBeGreaterThan(sta.cacheMiss);
  });
});
