import { describe, expect, test } from 'bun:test';
import {
  canonicalize,
  contentHash,
  HASH_PREFIX,
  verifyContentHash,
} from '../../../src/domain/content-hash.ts';

describe('canonicalize', () => {
  test('sorts object keys at every depth', () => {
    const a = canonicalize({ b: 2, a: 1, c: { z: 1, y: 2 } });
    const b = canonicalize({ a: 1, c: { y: 2, z: 1 }, b: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":2,"c":{"y":2,"z":1}}');
  });

  test('preserves array order', () => {
    const s = canonicalize([3, 1, 2]);
    expect(s).toBe('[3,1,2]');
  });

  test('rejects undefined at the root', () => {
    expect(() => canonicalize(undefined)).toThrow(TypeError);
  });

  test('skips undefined object fields (matching JSON.stringify)', () => {
    const obj: Record<string, unknown> = { a: 1, b: undefined };
    expect(canonicalize(obj)).toBe('{"a":1}');
  });

  test('rejects NaN and Infinity', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('contentHash', () => {
  test('produces a sha256:<hex> string', () => {
    const h = contentHash({ a: 1 });
    expect(h.startsWith(HASH_PREFIX)).toBe(true);
    expect(h.length).toBe(HASH_PREFIX.length + 64);
  });

  test('is stable across logically-equal bodies', () => {
    const a = contentHash({ user_value: 'pay', tags: ['x', 'y'] });
    const b = contentHash({ tags: ['x', 'y'], user_value: 'pay' });
    expect(a).toBe(b);
  });

  test('changes when content changes', () => {
    const a = contentHash({ runtime: 'es2022' });
    const b = contentHash({ runtime: 'es2024' });
    expect(a).not.toBe(b);
  });
});

describe('verifyContentHash', () => {
  test('returns true on match, false on tamper', () => {
    const body = { boundary: 'browser DOM', runtime: 'es2022' };
    const h = contentHash(body);
    expect(verifyContentHash(body, h)).toBe(true);
    expect(verifyContentHash({ ...body, runtime: 'es2024' }, h)).toBe(false);
  });
});
