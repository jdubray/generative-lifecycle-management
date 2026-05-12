import { describe, expect, test } from 'bun:test';
import { loadDocs } from '../../../src/import/yaml-source.ts';

const SAMPLE = `id: kizo:dev.glm.identity.session
stratum: component
title: Session Cookie
revision: { major: A, iteration: 1, status: in_review }
provenance:
  derives_from: null
  override_kind: net_new
body:
  boundary: "Owns: cookies."
  runtime: in_process
`;

const MULTI = `$schema: https://puffin.dev/glm/v1/sekkei.schema.json
---
id: glm:component.a
stratum: component
title: A
body: { boundary: a, runtime: r }
---
id: glm:component.b
stratum: component
title: B
body: { boundary: b, runtime: r }
`;

describe('loadDocs — inline mode', () => {
  test('parses a single document', () => {
    const docs = loadDocs({
      kind: 'inline',
      documents: [{ filename: 'sekkei.yaml', content: SAMPLE }],
    });
    expect(docs.length).toBe(1);
    expect(docs[0]?.doc.id).toBe('kizo:dev.glm.identity.session');
    expect(docs[0]?.file).toBe('sekkei.yaml');
  });

  test('parses multi-document streams + drops $schema-only docs', () => {
    const docs = loadDocs({ kind: 'inline', documents: [{ filename: 'nodes.yaml', content: MULTI }] });
    expect(docs.length).toBe(2);
    expect(docs.map((d) => d.doc.id).sort()).toEqual(['glm:component.a', 'glm:component.b']);
  });

  test('drops files without id/stratum at top level', () => {
    const docs = loadDocs({
      kind: 'inline',
      documents: [{ filename: 'header.yaml', content: 'just: a comment\nnothing: here\n' }],
    });
    expect(docs).toEqual([]);
  });

  test('handles empty input gracefully', () => {
    expect(loadDocs({ kind: 'inline', documents: [] })).toEqual([]);
    expect(loadDocs({ kind: 'inline', documents: [{ filename: 'x', content: '' }] })).toEqual([]);
  });
});
