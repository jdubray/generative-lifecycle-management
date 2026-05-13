import { describe, expect, test } from 'bun:test';
import {
  assertValidBody,
  NodeBodyValidationError,
  validateBody,
} from '../../../src/domain/node.ts';

describe('validateBody — system', () => {
  test('accepts a well-formed system body', () => {
    const r = validateBody('system', { system_role: 'browser-resident SPA' });
    expect(r.ok).toBe(true);
  });
  test('rejects when system_role is missing', () => {
    const r = validateBody('system', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toContain('system_role');
  });
});

describe('validateBody — capability', () => {
  test('accepts a non-empty user_value', () => {
    expect(validateBody('capability', { user_value: 'pay' }).ok).toBe(true);
  });
  test('rejects an empty user_value', () => {
    expect(validateBody('capability', { user_value: '' }).ok).toBe(false);
  });
});

describe('validateBody — component', () => {
  test('requires both boundary and runtime', () => {
    expect(validateBody('component', { boundary: 'browser DOM', runtime: 'es2022' }).ok).toBe(true);
    const r = validateBody('component', { boundary: 'browser DOM' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.includes('runtime'))).toBe(true);
  });
});

describe('validateBody — interaction (legacy flat form)', () => {
  test('fsm requires states and transitions', () => {
    expect(
      validateBody('interaction', { contract: 'fsm', states: ['a'], transitions: ['x:y'] }).ok,
    ).toBe(true);
    expect(validateBody('interaction', { contract: 'fsm', states: ['a'] }).ok).toBe(false);
  });
  test('integration_adapter requires endpoints array', () => {
    expect(
      validateBody('interaction', { contract: 'integration_adapter', endpoints: ['/x'] }).ok,
    ).toBe(true);
  });
  test('unknown contract is reported', () => {
    const r = validateBody('interaction', { contract: 'mystery' });
    expect(r.ok).toBe(false);
  });
});

describe('validateBody — interaction (rich form from docs/sekkei-authoring.md §5.4)', () => {
  test('fsm with contract_kind + nested contract_definition (states as objects) is accepted', () => {
    const body = {
      contract_kind: 'fsm',
      contract_definition: {
        pc: 'status',
        pc0: 'idle',
        states: [
          { id: 'idle', terminal: false, transitions: ['START'] },
          { id: 'running', terminal: false, transitions: ['DONE'] },
          { id: 'done', terminal: true, transitions: [] },
        ],
        actions: { START: ['running'], DONE: ['done'] },
        naps: { placement: 'wired in component.naps POST-INIT' },
        reactors: [{ name: 'persist', on: 'every_transition' }],
        invariants: ['always finishes within 30s'],
      },
      realization_file: 'src/order_lifecycle.ts',
    };
    const r = validateBody('interaction', body);
    expect(r.ok).toBe(true);
  });

  test('integration_adapter rich form is accepted', () => {
    const body = {
      contract_kind: 'integration_adapter',
      contract_definition: { upstream: 'stripe', operations: ['charge', 'refund'] },
    };
    expect(validateBody('interaction', body).ok).toBe(true);
  });

  test('contract_kind with no contract_definition is accepted (per-kind detail is gate 6)', () => {
    expect(validateBody('interaction', { contract_kind: 'fsm' }).ok).toBe(true);
  });

  test('contract_kind value must be a known kind', () => {
    const r = validateBody('interaction', { contract_kind: 'mystery' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toContain('unknown');
  });

  test('contract_definition (when present) must be an object', () => {
    const r = validateBody('interaction', { contract_kind: 'fsm', contract_definition: 'oops' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toContain('must be an object');
  });

  test('missing both contract_kind and contract is reported clearly', () => {
    const r = validateBody('interaction', { realization_file: 'x.ts' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toContain('contract_kind or contract');
  });
});

describe('validateBody — spec (legacy `content` form)', () => {
  test('spec_kind + content is accepted (back-compat)', () => {
    expect(
      validateBody('spec', { spec_kind: 'code_recipe', content: 'do the thing' }).ok,
    ).toBe(true);
  });
  test('content only (no spec_kind in body) is accepted; spec_kind lives on the envelope', () => {
    // Per docs/sekkei-authoring.md §6, spec_kind is an envelope field — gate 1
    // checks it via node.specKind. The body validator no longer requires it.
    expect(validateBody('spec', { content: 'x' }).ok).toBe(true);
  });
  test('spec_kind in body is accepted (some authors duplicate it for clarity)', () => {
    expect(validateBody('spec', { spec_kind: 'functional', content: 'x' }).ok).toBe(true);
  });
  test('spec_kind in body of wrong shape is rejected', () => {
    const r = validateBody('spec', { spec_kind: 42 as unknown });
    expect(r.ok).toBe(false);
  });
});

describe('validateBody — spec (rich shapes from docs/sekkei-authoring.md §6)', () => {
  test('functional spec with behaviors[] (no content) is accepted', () => {
    const body = {
      spec_kind: 'functional',
      behaviors: [
        {
          id: 'create',
          signature: 'create(input)',
          description: 'creates an entity',
          preconditions: ['input is valid'],
          postconditions: ['entity exists'],
        },
      ],
    };
    expect(validateBody('spec', body).ok).toBe(true);
  });

  test('technical spec with implementation block (no content) is accepted', () => {
    const body = {
      spec_kind: 'technical',
      implementation: { runtime: 'bun', framework: 'hono', storage: 'bun:sqlite' },
    };
    expect(validateBody('spec', body).ok).toBe(true);
  });

  test('acceptance spec with deliverables[] and verifier object is accepted', () => {
    const body = {
      spec_kind: 'acceptance',
      deliverables: [{ kind: 'test_file', path: 'test/repo.test.ts' }],
      verifier: { command: 'bun test test/repo.test.ts', expect: 'exit 0' },
    };
    expect(validateBody('spec', body).ok).toBe(true);
  });

  test('prompt spec with outputs as [{path,description}] is accepted', () => {
    const body = {
      spec_kind: 'prompt',
      context_bundle: ['acme:web.shop', 'acme:web.shop.catalog'],
      outputs: [{ path: 'src/repo.ts', description: 'repository module' }],
      prompt_template: 'Generate the repository.',
      verifier: { command: 'bun test', expect: 'all green' },
    };
    expect(validateBody('spec', body).ok).toBe(true);
  });

  test('prompt spec with verifier as a plain string still works (back-compat)', () => {
    const body = {
      spec_kind: 'prompt',
      context_bundle: [],
      outputs: ['src/x.ts'],
      verifier: 'bun test',
    };
    expect(validateBody('spec', body).ok).toBe(true);
  });

  test('verifier of wrong shape is rejected', () => {
    const r = validateBody('spec', { spec_kind: 'acceptance', verifier: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toContain('verifier');
  });

  test('outputs with neither string nor {path} is rejected', () => {
    const r = validateBody('spec', { spec_kind: 'prompt', outputs: [{ description: 'no path' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toContain('outputs');
  });

  test('business_rule spec with rules[] is accepted', () => {
    const body = {
      spec_kind: 'business_rule',
      rules: [{ id: 'BR-001', rule: 'invariant', enforcement: 'asserted on write' }],
    };
    expect(validateBody('spec', body).ok).toBe(true);
  });

  test('a bare body (empty object) passes envelope; gate 1 envelope check + gate 6 enforce the rest', () => {
    expect(validateBody('spec', {}).ok).toBe(true);
  });
});

describe('assertValidBody', () => {
  test('throws NodeBodyValidationError on failure', () => {
    expect(() => assertValidBody('component', { boundary: 'x' })).toThrow(NodeBodyValidationError);
  });
});
