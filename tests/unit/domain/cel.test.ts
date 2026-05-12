import { describe, expect, test } from 'bun:test';
import { CelParseError, evaluate, evaluateConstraint } from '../../../src/domain/cel.ts';

describe('evaluate — literals', () => {
  test('numbers, strings, booleans, null', () => {
    expect(evaluate('1', {})).toBe(1);
    expect(evaluate('1.5', {})).toBe(1.5);
    expect(evaluate("'abc'", {})).toBe('abc');
    expect(evaluate('"abc"', {})).toBe('abc');
    expect(evaluate('true', {})).toBe(true);
    expect(evaluate('false', {})).toBe(false);
    expect(evaluate('null', {})).toBeNull();
  });
});

describe('evaluate — comparisons', () => {
  test('numeric and string comparisons', () => {
    expect(evaluate('1 < 2', {})).toBe(true);
    expect(evaluate('2 <= 2', {})).toBe(true);
    expect(evaluate("'a' < 'b'", {})).toBe(true);
    expect(evaluate("'a' == 'a'", {})).toBe(true);
    expect(evaluate("'a' != 'b'", {})).toBe(true);
  });
});

describe('evaluate — logical', () => {
  test('and / or / not', () => {
    expect(evaluate('true && false', {})).toBe(false);
    expect(evaluate('true || false', {})).toBe(true);
    expect(evaluate('!false', {})).toBe(true);
    expect(evaluate('!(1 == 2)', {})).toBe(true);
  });
});

describe('evaluate — identifiers and dot access', () => {
  test('top-level binding', () => {
    expect(evaluate('single_user == true', { single_user: true })).toBe(true);
  });
  test('dot path', () => {
    expect(
      evaluate("pragma.journal_mode == 'wal'", { pragma: { journal_mode: 'wal' } }),
    ).toBe(true);
    expect(evaluate('pragma.foreign_keys == 1', { pragma: { foreign_keys: 1 } })).toBe(true);
  });
  test('.length on strings and arrays', () => {
    expect(evaluate('todo.title.length > 0', { todo: { title: 'hello' } })).toBe(true);
    expect(evaluate('xs.length == 3', { xs: [1, 2, 3] })).toBe(true);
  });
});

describe('evaluate — in operator', () => {
  test('membership in a string list', () => {
    expect(
      evaluate("filter_value in ['all', 'active', 'completed']", { filter_value: 'all' }),
    ).toBe(true);
    expect(
      evaluate("filter_value in ['all', 'active', 'completed']", { filter_value: 'archive' }),
    ).toBe(false);
  });
});

describe('evaluate — parse errors', () => {
  test('unterminated string', () => {
    expect(() => evaluate("'abc", {})).toThrow(CelParseError);
  });
  test('unexpected token', () => {
    expect(() => evaluate('1 @ 2', {})).toThrow();
  });
});

describe('evaluateConstraint', () => {
  test('passes when truthy', () => {
    const r = evaluateConstraint('1 == 1', {});
    expect(r.passed).toBe(true);
    expect(r.reason).toBeNull();
  });
  test('fails when false', () => {
    const r = evaluateConstraint('1 == 2', {});
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('false');
  });
  test('fails gracefully on unsupported syntax', () => {
    const r = evaluateConstraint('todo.title.length > 0 AFTER trim', {});
    expect(r.passed).toBe(false);
    expect(r.reason).toBeTruthy();
  });
  test('fails when expression does not return a boolean', () => {
    const r = evaluateConstraint('1 + 1', {});
    // '1 + 1' is a parse error because '+' is not supported — treat as failed.
    expect(r.passed).toBe(false);
  });
});
