import { describe, expect, test } from 'bun:test';
import { contentHash } from '../../../src/domain/content-hash.ts';
import {
  gate1Envelope,
  gate2bRoleConsistency,
  gate2StratumHierarchy,
  gate3ClosureCompleteness,
  gate4BriefCoverage,
  gate5SpecCoverage,
  gate6SpecQuality,
  runGates,
  type NodeRecord,
} from '../../../src/verifier/gates.ts';
import type { NodeRelationship, SekkeiNode, Stratum } from '../../../src/types.ts';

interface MkOpts {
  body?: object;
  stratum?: Stratum;
  systemRole?: string | null;
  specKind?: string | null;
  revisionStatus?: SekkeiNode['revisionStatus'];
  overrideKind?: SekkeiNode['overrideKind'];
  derivesFromNodeId?: string | null;
}

function mkNode(glmId: string, opts: MkOpts = {}): SekkeiNode {
  const stratum = opts.stratum ?? 'component';
  const body =
    opts.body ??
    (stratum === 'system'
      ? { system_role: opts.systemRole ?? 'root', acceptance_gate: 'A.0' }
      : stratum === 'capability'
        ? { user_value: 'value' }
        : stratum === 'component'
          ? { boundary: glmId, runtime: 'es2022' }
          : stratum === 'interaction'
            ? { contract: 'fsm', states: ['a'], transitions: ['x:a→a'] }
            : { spec_kind: opts.specKind ?? 'functional', content: 'do the thing' });
  return {
    id: `id-${glmId}`,
    workspaceId: 'ws-1',
    glmId,
    stratum,
    title: glmId,
    description: '',
    body: body as SekkeiNode['body'],
    contentHash: contentHash(body),
    revisionMajor: 'A',
    revisionIteration: 0,
    revisionStatus: opts.revisionStatus ?? 'in_work',
    overrideKind: opts.overrideKind ?? 'net_new',
    derivesFromNodeId: opts.derivesFromNodeId ?? null,
    systemRole: stratum === 'system' ? (opts.systemRole ?? 'root') : null,
    specKind: stratum === 'spec' ? (opts.specKind ?? 'functional') : null,
    authoredBy: 'alice@example.com',
    authoredAt: '2026-05-11T00:00:00.000Z',
    updatedAt: '2026-05-11T00:00:00.000Z',
    generatorIdentity: null,
  };
}

function record(node: SekkeiNode, relationships: NodeRelationship[] = []): NodeRecord {
  return { node, parameters: [], constraints: [], relationships };
}

function rel(source: string, target: string, kind: NodeRelationship['kind']): NodeRelationship {
  return { sourceNodeId: `id-${source}`, ord: 0, kind, targetGlmId: target, attributes: null };
}

// ---------------------------------------------------------------------------
// Gate 1 — envelope
// ---------------------------------------------------------------------------

describe('gate 1 — envelope', () => {
  test('passes for a clean component', () => {
    const r = gate1Envelope([record(mkNode('glm:component.x'))]);
    expect(r.passed).toBe(true);
  });

  test('fails when override_kind is bogus', () => {
    const r = gate1Envelope([
      record(mkNode('glm:component.x', { overrideKind: 'invalid' as never })),
    ]);
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.includes('override_kind'))).toBe(true);
  });

  test('fails when a spec node has no spec_kind', () => {
    const node = mkNode('glm:component.x.spec1', { stratum: 'spec', specKind: 'functional' });
    // Force specKind null after construction
    const broken: SekkeiNode = { ...node, specKind: null };
    const r = gate1Envelope([record(broken)]);
    expect(r.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gate 2 — stratum hierarchy
// ---------------------------------------------------------------------------

describe('gate 2 — stratum hierarchy', () => {
  test('component composes-of interaction is allowed', () => {
    const records = [
      record(mkNode('glm:component.x'), [rel('glm:component.x', 'glm:interaction.y', 'composes-of')]),
      record(mkNode('glm:interaction.y', { stratum: 'interaction' })),
    ];
    expect(gate2StratumHierarchy(records).passed).toBe(true);
  });

  test('component composes-of capability is rejected', () => {
    const records = [
      record(mkNode('glm:component.x'), [rel('glm:component.x', 'glm:capability.y', 'composes-of')]),
      record(mkNode('glm:capability.y', { stratum: 'capability' })),
    ];
    const r = gate2StratumHierarchy(records);
    expect(r.passed).toBe(false);
    expect(r.issues[0]).toContain('STRATUM VIOLATION');
  });
});

// ---------------------------------------------------------------------------
// Gate 2.b — role consistency
// ---------------------------------------------------------------------------

describe('gate 2.b — role consistency', () => {
  test('exactly one root system with acceptance_gate passes', () => {
    const root = mkNode('glm:system.web', { stratum: 'system', systemRole: 'root' });
    expect(gate2bRoleConsistency([record(root)]).passed).toBe(true);
  });

  test('a root system that is composed-of by another System fails', () => {
    const outer = mkNode('glm:system.outer', { stratum: 'system', systemRole: 'root' });
    const inner = mkNode('glm:system.inner', {
      stratum: 'system',
      systemRole: 'root',
    });
    const records = [
      record(outer, [rel('glm:system.outer', 'glm:system.inner', 'composes-of')]),
      record(inner),
    ];
    const r = gate2bRoleConsistency(records);
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.includes('IS composed-of') || i.includes('is composed-of'))).toBe(true);
  });

  test('a subsystem that is not composed-of any system fails', () => {
    const sub = mkNode('glm:system.sub', {
      stratum: 'system',
      systemRole: 'subsystem',
      body: { system_role: 'subsystem', dbom_ref: null },
    });
    const r = gate2bRoleConsistency([record(sub)]);
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.includes('NOT composed-of'))).toBe(true);
  });

  test('cardinality error when zero root systems', () => {
    const sub = mkNode('glm:system.sub', {
      stratum: 'system',
      systemRole: 'subsystem',
      body: { system_role: 'subsystem', dbom_ref: null },
    });
    const r = gate2bRoleConsistency([record(sub)]);
    expect(r.issues.some((i) => i.includes('expected exactly 1 root'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gate 3 — closure
// ---------------------------------------------------------------------------

describe('gate 3 — closure completeness', () => {
  test('passes when every glm: target resolves', () => {
    const records = [
      record(mkNode('glm:component.x'), [rel('glm:component.x', 'glm:component.y', 'depends-on')]),
      record(mkNode('glm:component.y')),
    ];
    expect(gate3ClosureCompleteness(records).passed).toBe(true);
  });

  test('fails on a dangling reference', () => {
    const records = [
      record(mkNode('glm:component.x'), [rel('glm:component.x', 'glm:component.missing', 'depends-on')]),
    ];
    const r = gate3ClosureCompleteness(records);
    expect(r.passed).toBe(false);
  });

  test('external prefixes are ignored', () => {
    const records = [
      record(mkNode('glm:component.x'), [rel('glm:component.x', 'pkg:npm/hono@4.6', 'depends-on')]),
    ];
    expect(gate3ClosureCompleteness(records).passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gate 4 — brief coverage
// ---------------------------------------------------------------------------

describe('gate 4 — brief coverage', () => {
  test('passes when no brief is configured', () => {
    expect(gate4BriefCoverage([record(mkNode('glm:component.x'))]).passed).toBe(true);
  });

  test('fails when a required node is missing', () => {
    const r = gate4BriefCoverage([], [{ glmId: 'glm:capability.payment', stratum: 'capability' }]);
    expect(r.passed).toBe(false);
  });

  test('fails when stratum does not match', () => {
    const records = [record(mkNode('glm:capability.payment', { stratum: 'component' }))];
    const r = gate4BriefCoverage(records, [
      { glmId: 'glm:capability.payment', stratum: 'capability' },
    ]);
    expect(r.passed).toBe(false);
    expect(r.issues[0]).toContain('STRATUM MISMATCH');
  });
});

// ---------------------------------------------------------------------------
// Gate 5 — spec coverage
// ---------------------------------------------------------------------------

describe('gate 5 — spec coverage', () => {
  test('component with all four spec_kinds passes', () => {
    const comp = mkNode('glm:component.x');
    const specs = ['functional', 'technical', 'acceptance', 'prompt'].map((kind) =>
      record(
        mkNode(`glm:component.x.spec_${kind}`, {
          stratum: 'spec',
          specKind: kind,
          body:
            kind === 'acceptance'
              ? { spec_kind: kind, content: 'a', deliverables: [], verifier: 'cmd' }
              : kind === 'prompt'
                ? { spec_kind: kind, content: 'p', context_bundle: [], outputs: [], verifier: 'cmd' }
                : { spec_kind: kind, content: 'x' },
        }),
      ),
    );
    expect(gate5SpecCoverage([record(comp), ...specs]).passed).toBe(true);
  });

  test('component missing prompt fails', () => {
    const comp = mkNode('glm:component.x');
    const specs = ['functional', 'technical', 'acceptance'].map((kind) =>
      record(mkNode(`glm:component.x.spec_${kind}`, { stratum: 'spec', specKind: kind })),
    );
    const r = gate5SpecCoverage([record(comp), ...specs]);
    expect(r.passed).toBe(false);
    expect(r.issues[0]).toContain('prompt');
  });
});

// ---------------------------------------------------------------------------
// Gate 6 — spec quality
// ---------------------------------------------------------------------------

describe('gate 6 — spec quality', () => {
  test('acceptance with deliverables+verifier passes', () => {
    const node = mkNode('glm:component.x.spec_acceptance', {
      stratum: 'spec',
      specKind: 'acceptance',
      body: { spec_kind: 'acceptance', content: 'a', deliverables: [], verifier: 'cmd' },
    });
    expect(gate6SpecQuality([record(node)]).passed).toBe(true);
  });

  test('acceptance without either v1.1 or legacy fields fails', () => {
    const node = mkNode('glm:component.x.spec_acceptance', {
      stratum: 'spec',
      specKind: 'acceptance',
      body: { spec_kind: 'acceptance', content: 'a' },
    });
    expect(gate6SpecQuality([record(node)]).passed).toBe(false);
  });

  test('prompt missing context_bundle fails', () => {
    const node = mkNode('glm:component.x.spec_prompt', {
      stratum: 'spec',
      specKind: 'prompt',
      body: { spec_kind: 'prompt', content: 'p', outputs: [], verifier: 'cmd' },
    });
    expect(gate6SpecQuality([record(node)]).passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

describe('runGates', () => {
  test('every gate present in result.gates', () => {
    const r = runGates({ nodes: [] });
    expect(r.gates.map((g) => g.name).sort()).toEqual(
      [
        '1.envelope',
        '2.b.role_consistency',
        '2.stratum_hierarchy',
        '3.closure_completeness',
        '4.brief_coverage',
        '5.spec_coverage',
        '6.spec_quality',
      ].sort(),
    );
  });

  test('overallPass is false when any gate fails', () => {
    const r = runGates({
      nodes: [
        record(mkNode('glm:component.x'), [rel('glm:component.x', 'glm:missing', 'depends-on')]),
      ],
    });
    expect(r.overallPass).toBe(false);
  });
});
