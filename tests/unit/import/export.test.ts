import { describe, expect, test } from 'bun:test';
import { exportNodes, safeGlmId } from '../../../src/import/export.ts';
import { contentHash } from '../../../src/domain/content-hash.ts';
import type { NodeWithChildren } from '../../../src/repository/node-repository.ts';
import type { SekkeiNode } from '../../../src/types.ts';

function mkRow(over: Partial<SekkeiNode> = {}, opts: Partial<NodeWithChildren> = {}): NodeWithChildren {
  const body = over.body ?? { boundary: 'b', runtime: 'r' };
  const node: SekkeiNode = {
    id: 'db-1',
    workspaceId: 'ws-1',
    glmId: 'kizo:dev.glm.identity.session',
    stratum: 'component',
    title: 'Session Cookie',
    description: 'signed cookie module',
    body: body as SekkeiNode['body'],
    contentHash: contentHash(body),
    revisionMajor: 'A',
    revisionIteration: 1,
    revisionStatus: 'in_review',
    overrideKind: 'net_new',
    derivesFromNodeId: null,
    systemRole: null,
    specKind: null,
    authoredBy: 'alice@example.com',
    authoredAt: '2026-05-11T00:00:00.000Z',
    updatedAt: '2026-05-11T00:00:00.000Z',
    generatorIdentity: null,
    ...over,
  };
  return {
    node,
    parameters: opts.parameters ?? [],
    constraints: opts.constraints ?? [],
    relationships: opts.relationships ?? [],
  };
}

describe('safeGlmId', () => {
  test('escapes colons for Windows-safe filenames', () => {
    expect(safeGlmId('kizo:dev.glm.identity.session')).toBe('kizo__dev.glm.identity.session');
  });
});

describe('exportNodes', () => {
  test('writes one YAML doc per node, under nodes/<stratum>/<safeId>.yaml', () => {
    const docs = exportNodes([
      mkRow({ glmId: 'kizo:dev.glm', stratum: 'system', body: { system_role: 'root' } }),
      mkRow(),
    ]);
    expect(docs.map((d) => d.filename)).toEqual([
      'nodes/system/kizo__dev.glm.yaml',
      'nodes/component/kizo__dev.glm.identity.session.yaml',
    ]);
    expect(docs[0]?.content).toContain('id: kizo:dev.glm');
    expect(docs[0]?.content).toContain('stratum: system');
    expect(docs[1]?.content).toContain('boundary: b');
  });

  test('drops empty parameters/constraints/relationships from the document', () => {
    const docs = exportNodes([mkRow()]);
    expect(docs[0]?.content).not.toContain('parameters:');
    expect(docs[0]?.content).not.toContain('constraints:');
    expect(docs[0]?.content).not.toContain('relationships:');
  });

  test('includes children when present', () => {
    const docs = exportNodes([
      mkRow(
        {},
        {
          parameters: [
            {
              nodeId: 'db-1',
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
          constraints: [
            { nodeId: 'db-1', ord: 0, kind: 'invariant', expression: 'x == "a"', severity: 'error' },
          ],
          relationships: [
            {
              sourceNodeId: 'db-1',
              ord: 0,
              kind: 'depends-on',
              targetGlmId: 'pkg:npm/hono@4',
              attributes: { role: 'http' },
            },
          ],
        },
      ),
    ]);
    const yaml = docs[0]?.content ?? '';
    expect(yaml).toContain('parameters:');
    expect(yaml).toContain('constraints:');
    expect(yaml).toContain('relationships:');
    expect(yaml).toContain('pkg:npm/hono@4');
  });
});
