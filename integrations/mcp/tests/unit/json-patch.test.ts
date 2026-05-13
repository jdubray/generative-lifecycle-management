import { describe, expect, test } from 'bun:test';
import { applyJsonPatch, JsonPatchError } from '../../src/lib/json-patch.ts';

describe('applyJsonPatch — add / replace / remove / move', () => {
  test('add at object path creates a new key', () => {
    const out = applyJsonPatch({ a: 1 }, [{ op: 'add', path: '/b', value: 2 }]);
    expect(out).toEqual({ a: 1, b: 2 });
  });

  test('replace overwrites an existing key', () => {
    const out = applyJsonPatch({ a: 1 }, [{ op: 'replace', path: '/a', value: 99 }]);
    expect(out).toEqual({ a: 99 });
  });

  test('remove deletes a key', () => {
    const out = applyJsonPatch({ a: 1, b: 2 }, [{ op: 'remove', path: '/b' }]);
    expect(out).toEqual({ a: 1 });
  });

  test('add to array index inserts (does not replace)', () => {
    const out = applyJsonPatch({ xs: [10, 20] }, [{ op: 'add', path: '/xs/1', value: 15 }]);
    expect(out).toEqual({ xs: [10, 15, 20] });
  });

  test('add with `-` appends to array', () => {
    const out = applyJsonPatch({ xs: [1, 2] }, [{ op: 'add', path: '/xs/-', value: 3 }]);
    expect(out).toEqual({ xs: [1, 2, 3] });
  });

  test('move repositions a value', () => {
    const out = applyJsonPatch(
      { a: { x: 1 }, b: { } as Record<string, unknown> },
      [{ op: 'move', from: '/a/x', path: '/b/y' }],
    );
    expect(out).toEqual({ a: {}, b: { y: 1 } });
  });

  test('does not mutate the input', () => {
    const input = { a: 1 };
    applyJsonPatch(input, [{ op: 'add', path: '/b', value: 2 }]);
    expect(input).toEqual({ a: 1 });
  });

  test('replace on missing key throws', () => {
    expect(() => applyJsonPatch({}, [{ op: 'replace', path: '/missing/nested', value: 1 }])).toThrow(JsonPatchError);
  });

  test('remove on missing key throws', () => {
    expect(() => applyJsonPatch({ a: 1 }, [{ op: 'remove', path: '/missing' }])).toThrow(JsonPatchError);
  });

  test('unsupported op (test / copy) throws', () => {
    expect(() =>
      applyJsonPatch({}, [{ op: 'test' as never, path: '/a', value: 1 }]),
    ).toThrow();
  });

  test('multi-op sequence applies in order', () => {
    const out = applyJsonPatch(
      { outputs: [{ path: 'a.ts' }] },
      [
        { op: 'add', path: '/outputs/-', value: { path: 'b.ts' } },
        { op: 'replace', path: '/outputs/0/path', value: 'a-renamed.ts' },
      ],
    );
    expect(out).toEqual({ outputs: [{ path: 'a-renamed.ts' }, { path: 'b.ts' }] });
  });
});
