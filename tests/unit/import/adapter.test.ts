import { describe, expect, test } from 'bun:test';
import { adaptYamlNode, YamlAdapterError, type YamlNodeDoc } from '../../../src/import/adapter.ts';

const WS = 'ws-1';
const DBID = 'db-id-1';

function doc(over: Partial<YamlNodeDoc> = {}): YamlNodeDoc {
  return {
    id: 'kizo:dev.glm',
    stratum: 'system',
    title: 'GLM',
    revision: { major: 'A', iteration: 1, status: 'in_review' },
    provenance: {
      derives_from: null,
      override_kind: 'net_new',
      authored_by: 'glm-reverse-engineer@A.1',
      authored_at: '2026-05-11T00:00:00Z',
    },
    body: { system_role: 'root', acceptance_gate: 'A.0' },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// envelope mapping
// ---------------------------------------------------------------------------

describe('adaptYamlNode — envelope', () => {
  test('maps a system node into a NodeInput', () => {
    const r = adaptYamlNode(doc(), WS, DBID);
    expect(r.input.id).toBe(DBID);
    expect(r.input.workspaceId).toBe(WS);
    expect(r.input.glmId).toBe('kizo:dev.glm');
    expect(r.input.stratum).toBe('system');
    expect(r.input.title).toBe('GLM');
    expect(r.input.revisionMajor).toBe('A');
    expect(r.input.revisionIteration).toBe(1);
    expect(r.input.revisionStatus).toBe('in_review');
    expect(r.input.authoredBy).toBe('glm-reverse-engineer@A.1');
    expect(r.input.systemRole).toBe('root');
    expect(r.input.specKind).toBeNull();
    expect(r.derivesFromGlmId).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  test('rejects a doc missing `id`', () => {
    expect(() => adaptYamlNode({ ...doc(), id: '' } as YamlNodeDoc, WS, DBID)).toThrow(YamlAdapterError);
  });

  test('rejects an unknown stratum', () => {
    expect(() => adaptYamlNode(doc({ stratum: 'bogus' }), WS, DBID)).toThrow(YamlAdapterError);
  });

  test('falls back to glm_id when title is missing', () => {
    const r = adaptYamlNode(doc({ title: undefined }), WS, DBID);
    expect(r.input.title).toBe('kizo:dev.glm');
  });

  test('description defaults to empty string', () => {
    const r = adaptYamlNode(doc({ description: undefined }), WS, DBID);
    expect(r.input.description).toBe('');
  });
});

// ---------------------------------------------------------------------------
// override_kind mapping (the YAML/DB schema gap)
// ---------------------------------------------------------------------------

describe('adaptYamlNode — override_kind mapping', () => {
  test('with_override → derives-from', () => {
    const r = adaptYamlNode(
      doc({ provenance: { ...doc().provenance, override_kind: 'with_override' } }),
      WS,
      DBID,
    );
    expect(r.input.overrideKind).toBe('derives-from');
  });
  test('as_is → derives-from', () => {
    const r = adaptYamlNode(
      doc({ provenance: { ...doc().provenance, override_kind: 'as_is' } }),
      WS,
      DBID,
    );
    expect(r.input.overrideKind).toBe('derives-from');
  });
  test('extend → refines', () => {
    const r = adaptYamlNode(
      doc({ provenance: { ...doc().provenance, override_kind: 'extend' } }),
      WS,
      DBID,
    );
    expect(r.input.overrideKind).toBe('refines');
  });
  test('net_new passes through', () => {
    const r = adaptYamlNode(
      doc({ provenance: { ...doc().provenance, override_kind: 'net_new' } }),
      WS,
      DBID,
    );
    expect(r.input.overrideKind).toBe('net_new');
  });
  test('unknown override_kind defaults to net_new + warning', () => {
    const r = adaptYamlNode(
      doc({ provenance: { ...doc().provenance, override_kind: 'made-up' } }),
      WS,
      DBID,
    );
    expect(r.input.overrideKind).toBe('net_new');
    expect(r.warnings.join(' ')).toContain("unknown provenance.override_kind 'made-up'");
  });
});

// ---------------------------------------------------------------------------
// derives_from resolution marker
// ---------------------------------------------------------------------------

describe('adaptYamlNode — derives_from', () => {
  test('records the source glm_id for second-pass resolution', () => {
    const r = adaptYamlNode(
      doc({
        id: 'kizo:dev.glm.identity.api_token',
        stratum: 'component',
        body: { boundary: 'b', runtime: 'in_process' },
        provenance: {
          ...doc().provenance,
          derives_from: { id: 'kizo:dev.glm.identity', content_hash: 'sha256:abc' },
        },
      }),
      WS,
      DBID,
    );
    expect(r.derivesFromGlmId).toBe('kizo:dev.glm.identity');
    expect(r.input.derivesFromNodeId).toBeNull();
  });

  test('self-references are dropped', () => {
    const r = adaptYamlNode(
      doc({
        provenance: {
          ...doc().provenance,
          derives_from: { id: 'kizo:dev.glm', content_hash: 'sha256:zero' },
        },
      }),
      WS,
      DBID,
    );
    expect(r.derivesFromGlmId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stratum body shape
// ---------------------------------------------------------------------------

describe('adaptYamlNode — body shapes', () => {
  test('system body adds dbom_ref=null when missing', () => {
    const r = adaptYamlNode(doc({ body: { system_role: 'root' } }), WS, DBID);
    expect((r.input.body as Record<string, unknown>).dbom_ref).toBeNull();
  });

  test('system body preserves existing dbom_ref', () => {
    const r = adaptYamlNode(doc({ body: { system_role: 'subsystem', dbom_ref: null } }), WS, DBID);
    expect(r.input.systemRole).toBe('subsystem');
  });

  test('interaction body mirrors contract_kind into contract', () => {
    const r = adaptYamlNode(
      {
        id: 'kizo:dev.glm.foo.bar',
        stratum: 'interaction',
        title: 'fsm',
        revision: { major: 'A', iteration: 1, status: 'in_review' },
        provenance: { override_kind: 'net_new' },
        body: { contract_kind: 'fsm', contract_definition: { states: ['x'] } },
      } as YamlNodeDoc,
      WS,
      DBID,
    );
    const body = r.input.body as Record<string, unknown>;
    expect(body.contract).toBe('fsm');
    expect(body.contract_kind).toBe('fsm');
  });

  test('component without boundary/runtime emits warnings', () => {
    const r = adaptYamlNode(
      doc({ id: 'glm:component.x', stratum: 'component', body: {} }),
      WS,
      DBID,
    );
    const joined = r.warnings.join('\n');
    expect(joined).toContain('boundary');
    expect(joined).toContain('runtime');
  });

  test('capability without user_value emits warning', () => {
    const r = adaptYamlNode(
      doc({ id: 'glm:capability.x', stratum: 'capability', body: {} }),
      WS,
      DBID,
    );
    expect(r.warnings.join('\n')).toContain('user_value');
  });
});

// ---------------------------------------------------------------------------
// children: parameters / constraints / relationships
// ---------------------------------------------------------------------------

describe('adaptYamlNode — parameters', () => {
  test('unpacks schema.type / enum / min / max', () => {
    const r = adaptYamlNode(
      doc({
        parameters: [
          {
            name: 'pool_size',
            schema: { type: 'integer', minimum: 1, maximum: 100 },
            default: 4,
            binding_scope: 'system',
          },
          {
            name: 'channel',
            schema: { type: 'string', enum: ['canary', 'stable'] },
            default: 'stable',
            binding_scope: 'workspace',
          },
        ],
      }),
      WS,
      DBID,
    );
    expect(r.input.parameters).toEqual([
      {
        name: 'pool_size',
        type: 'integer',
        options: null,
        minValue: 1,
        maxValue: 100,
        defaultValue: 4,
        bindingScope: 'system', // stratum-axis values pass through (migration 0005)
        ord: 0,
      },
      {
        name: 'channel',
        type: 'string',
        options: ['canary', 'stable'],
        minValue: null,
        maxValue: null,
        defaultValue: 'stable',
        bindingScope: 'workspace',
        ord: 1,
      },
    ]);
  });

  test('unknown binding_scope defaults to workspace + warning', () => {
    const r = adaptYamlNode(
      doc({
        parameters: [{ name: 'x', schema: { type: 'string' }, binding_scope: 'galactic' }],
      }),
      WS,
      DBID,
    );
    expect(r.input.parameters?.[0]?.bindingScope).toBe('workspace');
    expect(r.warnings.join('\n')).toContain("binding_scope 'galactic'");
  });
});

describe('adaptYamlNode — constraints', () => {
  test('passes through invariant/warning cleanly', () => {
    const r = adaptYamlNode(
      doc({
        constraints: [
          { kind: 'invariant', expression: 'multi_user == true', severity: 'error' },
          { kind: 'invariant', expression: 'pool_size >= 4', severity: 'warning' },
        ],
      }),
      WS,
      DBID,
    );
    expect(r.input.constraints).toEqual([
      { ord: 0, kind: 'invariant', expression: 'multi_user == true', severity: 'error' },
      { ord: 1, kind: 'invariant', expression: 'pool_size >= 4', severity: 'warning' },
    ]);
  });

  test('unknown constraint kind coerces to invariant + warning', () => {
    const r = adaptYamlNode(
      doc({ constraints: [{ kind: 'magic', expression: 'x', severity: 'error' }] }),
      WS,
      DBID,
    );
    expect(r.input.constraints?.[0]?.kind).toBe('invariant');
    expect(r.warnings.join('\n')).toContain("kind 'magic'");
  });
});

describe('adaptYamlNode — relationships', () => {
  test('renames target → targetGlmId and assigns ord', () => {
    const r = adaptYamlNode(
      doc({
        relationships: [
          { kind: 'composes-of', target: 'kizo:dev.glm.identity', attributes: { find_number: '1.0' } },
          { kind: 'depends-on', target: 'pkg:npm/hono@4', attributes: { role: 'http_framework' } },
        ],
      }),
      WS,
      DBID,
    );
    expect(r.input.relationships?.[0]).toEqual({
      ord: 0,
      kind: 'composes-of',
      targetGlmId: 'kizo:dev.glm.identity',
      attributes: { find_number: '1.0' },
    });
    expect(r.input.relationships?.[1]?.targetGlmId).toBe('pkg:npm/hono@4');
  });

  test('unknown relationship kind coerces to depends-on + warning', () => {
    const r = adaptYamlNode(
      doc({ relationships: [{ kind: 'unrelated', target: 'glm:x' }] }),
      WS,
      DBID,
    );
    expect(r.input.relationships?.[0]?.kind).toBe('depends-on');
    expect(r.warnings.join('\n')).toContain("kind 'unrelated'");
  });
});

// ---------------------------------------------------------------------------
// revision + authored_at normalization
// ---------------------------------------------------------------------------

describe('adaptYamlNode — revision/timestamp normalization', () => {
  test('unknown revision.status defaults to in_work + warning', () => {
    const r = adaptYamlNode(
      doc({ revision: { major: 'A', iteration: 0, status: 'speculative' } }),
      WS,
      DBID,
    );
    expect(r.input.revisionStatus).toBe('in_work');
    expect(r.warnings.join('\n')).toContain("revision.status 'speculative'");
  });

  test('missing authored_at falls back to epoch', () => {
    const r = adaptYamlNode(
      doc({ provenance: { ...doc().provenance, authored_at: undefined } }),
      WS,
      DBID,
    );
    expect(r.input.authoredAt).toBe('1970-01-01T00:00:00.000Z');
  });

  test('iso authored_at is normalized to ms-precision', () => {
    const r = adaptYamlNode(
      doc({ provenance: { ...doc().provenance, authored_at: '2026-05-11T00:00:00Z' } }),
      WS,
      DBID,
    );
    expect(r.input.authoredAt).toBe('2026-05-11T00:00:00.000Z');
  });
});
