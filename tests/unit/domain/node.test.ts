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

describe('validateBody — interaction', () => {
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

describe('validateBody — spec', () => {
  test('requires spec_kind and content', () => {
    expect(
      validateBody('spec', { spec_kind: 'code_recipe', content: 'do the thing' }).ok,
    ).toBe(true);
    expect(validateBody('spec', { spec_kind: 'code_recipe' }).ok).toBe(false);
  });
});

describe('assertValidBody', () => {
  test('throws NodeBodyValidationError on failure', () => {
    expect(() => assertValidBody('component', { boundary: 'x' })).toThrow(NodeBodyValidationError);
  });
});
