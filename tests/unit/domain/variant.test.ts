import { describe, expect, test } from 'bun:test';
import { contentHash } from '../../../src/domain/content-hash.ts';
import { type ResolverNode, resolve } from '../../../src/domain/variant.ts';
import type {
  ExternalDep,
  GeneratorIdentity,
  NodeConstraint,
  NodeParameter,
  NodeRelationship,
  SekkeiNode,
} from '../../../src/types.ts';

function mkNode(
  glmId: string,
  body: object,
  overrides: Partial<SekkeiNode> = {},
): SekkeiNode {
  return {
    id: `id-${glmId}`,
    workspaceId: 'ws-1',
    glmId,
    stratum: 'component',
    title: glmId,
    description: '',
    body: body as SekkeiNode['body'],
    contentHash: contentHash(body),
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

function rnode(
  glmId: string,
  body: object,
  opts: {
    parameters?: NodeParameter[];
    constraints?: NodeConstraint[];
    relationships?: NodeRelationship[];
    overrides?: Partial<SekkeiNode>;
  } = {},
): ResolverNode {
  return {
    node: mkNode(glmId, body, opts.overrides),
    parameters: opts.parameters ?? [],
    constraints: opts.constraints ?? [],
    relationships: opts.relationships ?? [],
  };
}

const GENERATOR: GeneratorIdentity = {
  llm: 'claude-sonnet-4-6',
  promptVersion: 'sha256:abc',
  toolChain: 'sha256:def',
};

describe('resolve — happy path', () => {
  test('walks closure across composes-of and pins every node in the lock', () => {
    const child = rnode('glm:component.child', { boundary: 'b', runtime: 'r' });
    const root = rnode('glm:component.root', { boundary: 'b', runtime: 'r' }, {
      relationships: [
        { sourceNodeId: 'id-glm:component.root', ord: 0, kind: 'composes-of', targetGlmId: 'glm:component.child', attributes: null },
      ],
    });

    const r = resolve({
      rootGlmId: 'glm:component.root',
      nodes: [root, child],
      externalDeps: [],
      binding: {},
      generatorIdentity: GENERATOR,
    });

    expect(r.overall.passed).toBe(true);
    expect(r.closure.length).toBe(2);
    expect(r.lock.nodes.map((n) => n.glm_id).sort()).toEqual(
      ['glm:component.child', 'glm:component.root'].sort(),
    );
    expect(r.lock.for_sekkei).toBe('glm:component.root');
    for (const entry of r.lock.nodes) {
      expect(entry.content_hash.startsWith('sha256:')).toBe(true);
      expect(entry.revision).toBe('A.0');
    }
  });

  test('AC-14: cache key section always shows all five hashes', () => {
    const root = rnode('glm:component.x', { boundary: 'b', runtime: 'r' });
    const r = resolve({
      rootGlmId: 'glm:component.x',
      nodes: [root],
      externalDeps: [],
      binding: {},
      generatorIdentity: GENERATOR,
    });
    expect(r.hashes.closureHash).toContain('sha256:');
    expect(r.hashes.bindingHash).toContain('sha256:');
    expect(r.hashes.designHash).toContain('sha256:');
    expect(r.hashes.generatorIdentityHash).toContain('sha256:');
    expect(r.hashes.generationHash).toContain('sha256:');
  });
});

describe('resolve — parameters', () => {
  test('defaults are applied to missing bindings', () => {
    const root = rnode('glm:component.cap', { boundary: 'b', runtime: 'r' }, {
      parameters: [
        {
          nodeId: 'id-glm:component.cap',
          name: 'multi_user',
          type: 'boolean',
          options: null,
          minValue: null,
          maxValue: null,
          defaultValue: true,
          bindingScope: 'workspace',
          ord: 0,
        },
      ],
    });
    const r = resolve({
      rootGlmId: 'glm:component.cap',
      nodes: [root],
      externalDeps: [],
      binding: {},
      generatorIdentity: GENERATOR,
    });
    expect(r.steps.parameterBinding.ok).toBe(true);
    expect(r.resolvedBinding.multi_user).toBe(true);
  });

  test('a missing parameter without a default fails step 2 (and skips constraints)', () => {
    const root = rnode('glm:component.cap', { boundary: 'b', runtime: 'r' }, {
      parameters: [
        {
          nodeId: 'id-glm:component.cap',
          name: 'must_set',
          type: 'string',
          options: null,
          minValue: null,
          maxValue: null,
          defaultValue: null,
          bindingScope: 'workspace',
          ord: 0,
        },
      ],
    });
    const r = resolve({
      rootGlmId: 'glm:component.cap',
      nodes: [root],
      externalDeps: [],
      binding: {},
      generatorIdentity: GENERATOR,
    });
    expect(r.steps.parameterBinding.ok).toBe(false);
    expect(r.overall.passed).toBe(false);
    expect(r.overall.failedAtStep).toBe(2);
  });
});

describe('resolve — constraints (AC-12)', () => {
  test('a constraint with severity=error makes resolution fail', () => {
    const root = rnode('glm:component.cap', { boundary: 'b', runtime: 'r' }, {
      parameters: [
        {
          nodeId: 'id-glm:component.cap',
          name: 'filter_value',
          type: 'string',
          options: null,
          minValue: null,
          maxValue: null,
          defaultValue: 'archive',
          bindingScope: 'workspace',
          ord: 0,
        },
      ],
      constraints: [
        {
          nodeId: 'id-glm:component.cap',
          ord: 0,
          kind: 'invariant',
          expression: "filter_value in ['all', 'active', 'completed']",
          severity: 'error',
        },
      ],
    });
    const r = resolve({
      rootGlmId: 'glm:component.cap',
      nodes: [root],
      externalDeps: [],
      binding: {},
      generatorIdentity: GENERATOR,
    });
    expect(r.overall.passed).toBe(false);
    expect(r.overall.failedAtStep).toBe(3);
    const failed = r.constraints.filter((c) => !c.passed && c.severity === 'error');
    expect(failed.length).toBe(1);
  });

  test('warning-severity constraint failures do not fail overall', () => {
    const root = rnode('glm:component.cap', { boundary: 'b', runtime: 'r' }, {
      parameters: [
        {
          nodeId: 'id-glm:component.cap',
          name: 'pool_size',
          type: 'integer',
          options: null,
          minValue: null,
          maxValue: null,
          defaultValue: 2,
          bindingScope: 'workspace',
          ord: 0,
        },
      ],
      constraints: [
        {
          nodeId: 'id-glm:component.cap',
          ord: 0,
          kind: 'invariant',
          expression: 'pool_size >= 4',
          severity: 'warning',
        },
      ],
    });
    const r = resolve({
      rootGlmId: 'glm:component.cap',
      nodes: [root],
      externalDeps: [],
      binding: {},
      generatorIdentity: GENERATOR,
    });
    expect(r.overall.passed).toBe(true);
    expect(r.constraints[0]?.passed).toBe(false);
  });
});

describe('resolve — external dependency pins', () => {
  test('depends-on relationships are mapped to PURL pins', () => {
    const deps: ExternalDep[] = [
      { workspaceId: 'ws-1', purl: 'pkg:npm/hono@4.6', role: 'web', license: 'MIT', notes: null },
      { workspaceId: 'ws-1', purl: 'pkg:npm/zod@3', role: 'validation', license: 'MIT', notes: null },
    ];
    const root = rnode('glm:component.api', { boundary: 'b', runtime: 'r' }, {
      relationships: [
        { sourceNodeId: 'id-glm:component.api', ord: 0, kind: 'depends-on', targetGlmId: 'pkg:npm/hono@4.6', attributes: null },
      ],
    });
    const r = resolve({
      rootGlmId: 'glm:component.api',
      nodes: [root],
      externalDeps: deps,
      binding: {},
      generatorIdentity: GENERATOR,
    });
    expect(r.externalDepPins.length).toBe(1);
    expect(r.externalDepPins[0]?.purl).toBe('pkg:npm/hono@4.6');
  });
});

describe('resolve — AC-11 / AC-13', () => {
  test('AC-11: changing a parameter produces a different binding hash', () => {
    const root = rnode('glm:component.cap', { boundary: 'b', runtime: 'r' }, {
      parameters: [
        {
          nodeId: 'id-glm:component.cap',
          name: 'x',
          type: 'string',
          options: null,
          minValue: null,
          maxValue: null,
          defaultValue: 'a',
          bindingScope: 'workspace',
          ord: 0,
        },
      ],
    });
    const r1 = resolve({
      rootGlmId: 'glm:component.cap',
      nodes: [root],
      externalDeps: [],
      binding: { x: 'a' },
      generatorIdentity: GENERATOR,
    });
    const r2 = resolve({
      rootGlmId: 'glm:component.cap',
      nodes: [root],
      externalDeps: [],
      binding: { x: 'b' },
      generatorIdentity: GENERATOR,
    });
    expect(r1.hashes.bindingHash).not.toBe(r2.hashes.bindingHash);
    expect(r1.hashes.generationHash).not.toBe(r2.hashes.generationHash);
  });

  test('AC-13: sekkei.lock includes for_sekkei + pinned nodes with id/revision/content_hash', () => {
    const root = rnode('glm:system.web', { system_role: 'browser-resident SPA' }, {
      overrides: { stratum: 'system', systemRole: 'browser-resident SPA' },
    });
    const r = resolve({
      rootGlmId: 'glm:system.web',
      nodes: [root],
      externalDeps: [],
      binding: {},
      generatorIdentity: GENERATOR,
    });
    expect(r.lock.for_sekkei).toBe('glm:system.web');
    expect(r.lock.nodes[0]).toEqual({
      glm_id: 'glm:system.web',
      revision: 'A.0',
      content_hash: r.closure[0]?.node.contentHash ?? '',
    });
  });
});

describe('resolve — missing root', () => {
  test('returns a failing step-1 result with no closure', () => {
    const r = resolve({
      rootGlmId: 'glm:missing',
      nodes: [],
      externalDeps: [],
      binding: {},
      generatorIdentity: GENERATOR,
    });
    expect(r.overall.passed).toBe(false);
    expect(r.overall.failedAtStep).toBe(1);
    expect(r.closure.length).toBe(0);
  });
});
