import { describe, expect, test } from 'bun:test';
import { applyJsonPatch, JsonPatchError } from '../../src/lib/json-patch.ts';

describe('applyJsonPatch', () => {
  test('does not mutate the input', () => {
    const before = { a: 1, b: { c: 2 } };
    const after = applyJsonPatch(before, [{ op: 'replace', path: '/a', value: 99 }]);
    expect(before.a).toBe(1);
    expect((after as { a: number }).a).toBe(99);
  });

  test('add into an object', () => {
    const out = applyJsonPatch({ a: 1 }, [{ op: 'add', path: '/b', value: 2 }]);
    expect(out).toEqual({ a: 1, b: 2 });
  });

  test('replace an existing field', () => {
    const out = applyJsonPatch({ a: 1 }, [{ op: 'replace', path: '/a', value: 2 }]);
    expect(out).toEqual({ a: 2 });
  });

  test('remove a field', () => {
    const out = applyJsonPatch({ a: 1, b: 2 }, [{ op: 'remove', path: '/a' }]);
    expect(out).toEqual({ b: 2 });
  });

  test('add into an array at index', () => {
    const out = applyJsonPatch(
      { items: [10, 20, 30] },
      [{ op: 'add', path: '/items/1', value: 15 }],
    );
    expect(out).toEqual({ items: [10, 15, 20, 30] });
  });

  test("append with '/-' on an array", () => {
    const out = applyJsonPatch(
      { items: [10, 20] },
      [{ op: 'add', path: '/items/-', value: 30 }],
    );
    expect(out).toEqual({ items: [10, 20, 30] });
  });

  test('replace an array element', () => {
    const out = applyJsonPatch(
      { items: [10, 20, 30] },
      [{ op: 'replace', path: '/items/1', value: 99 }],
    );
    expect(out).toEqual({ items: [10, 99, 30] });
  });

  test('remove an array element', () => {
    const out = applyJsonPatch(
      { items: [10, 20, 30] },
      [{ op: 'remove', path: '/items/1' }],
    );
    expect(out).toEqual({ items: [10, 30] });
  });

  test('move within an object', () => {
    const out = applyJsonPatch(
      { a: { x: 1 }, b: {} },
      [{ op: 'move', from: '/a/x', path: '/b/y' }],
    );
    expect(out).toEqual({ a: {}, b: { y: 1 } });
  });

  test('nested paths', () => {
    const out = applyJsonPatch(
      { behaviors: [{ id: 'create', tags: ['a', 'b'] }] },
      [{ op: 'add', path: '/behaviors/0/tags/-', value: 'c' }],
    );
    expect(out).toEqual({ behaviors: [{ id: 'create', tags: ['a', 'b', 'c'] }] });
  });

  test('JSON Pointer escapes ~0 and ~1', () => {
    const out = applyJsonPatch(
      { 'a/b': 1, 'c~d': 2 },
      [
        { op: 'replace', path: '/a~1b', value: 99 },
        { op: 'replace', path: '/c~0d', value: 88 },
      ],
    );
    expect(out).toEqual({ 'a/b': 99, 'c~d': 88 });
  });

  test('applies multiple ops in order', () => {
    const out = applyJsonPatch(
      { items: [], count: 0 },
      [
        { op: 'add', path: '/items/-', value: 'a' },
        { op: 'add', path: '/items/-', value: 'b' },
        { op: 'replace', path: '/count', value: 2 },
      ],
    );
    expect(out).toEqual({ items: ['a', 'b'], count: 2 });
  });

  test('throws for unsupported op', () => {
    expect(() => applyJsonPatch({}, [{ op: 'copy', path: '/x' } as never])).toThrow(JsonPatchError);
    expect(() => applyJsonPatch({}, [{ op: 'test', path: '/x' } as never])).toThrow(JsonPatchError);
  });

  test('throws for missing path on remove', () => {
    expect(() => applyJsonPatch({ a: 1 }, [{ op: 'remove', path: '/b' }])).toThrow(JsonPatchError);
  });

  test('throws for invalid array index', () => {
    expect(() =>
      applyJsonPatch({ items: [1, 2] }, [{ op: 'replace', path: '/items/foo', value: 9 }]),
    ).toThrow(JsonPatchError);
  });

  test('throws for replace beyond array end', () => {
    expect(() =>
      applyJsonPatch({ items: [1, 2] }, [{ op: 'replace', path: '/items/5', value: 9 }]),
    ).toThrow(JsonPatchError);
  });
});
