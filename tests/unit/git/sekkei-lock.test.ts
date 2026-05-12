import { describe, expect, test } from 'bun:test';
import { lockHash, parseSekkeiLock, serializeSekkeiLock } from '../../../src/git/sekkei-lock.ts';

const GENERATOR = {
  llm: 'claude-sonnet-4-6',
  promptVersion: 'sha256:aaa',
  toolChain: 'sha256:bbb',
};

describe('serializeSekkeiLock', () => {
  test('emits the spec-mandated top-level fields', () => {
    const text = serializeSekkeiLock({
      rootGlmId: 'glm:system.web',
      binding: { multi_user: true },
      nodes: [
        { id: 'glm:capability.x', major: 'A', content_hash: 'sha256:111' },
        { id: 'glm:component.y', major: 'A', content_hash: 'sha256:222' },
      ],
      generatorIdentity: GENERATOR,
    });
    expect(text).toContain('# sekkei.lock');
    expect(text).toContain('root_id: glm:system.web');
    expect(text).toContain('parameter_binding:');
    expect(text).toContain('nodes:');
    expect(text).toContain('generator_identity:');
    expect(text).toContain('content_hash: sha256:111');
  });

  test('sorts nodes by id for determinism', () => {
    const a = serializeSekkeiLock({
      rootGlmId: 'glm:system.web',
      binding: {},
      nodes: [
        { id: 'glm:b', major: 'A', content_hash: 'sha256:bb' },
        { id: 'glm:a', major: 'A', content_hash: 'sha256:aa' },
      ],
      generatorIdentity: GENERATOR,
    });
    const b = serializeSekkeiLock({
      rootGlmId: 'glm:system.web',
      binding: {},
      nodes: [
        { id: 'glm:a', major: 'A', content_hash: 'sha256:aa' },
        { id: 'glm:b', major: 'A', content_hash: 'sha256:bb' },
      ],
      generatorIdentity: GENERATOR,
    });
    expect(a).toBe(b);
  });

  test('sorts binding keys for determinism', () => {
    const a = serializeSekkeiLock({
      rootGlmId: 'glm:system.web',
      binding: { b: 2, a: 1 },
      nodes: [],
      generatorIdentity: GENERATOR,
    });
    const b = serializeSekkeiLock({
      rootGlmId: 'glm:system.web',
      binding: { a: 1, b: 2 },
      nodes: [],
      generatorIdentity: GENERATOR,
    });
    expect(a).toBe(b);
  });
});

describe('parseSekkeiLock', () => {
  test('round-trips serialized output', () => {
    const text = serializeSekkeiLock({
      rootGlmId: 'glm:system.web',
      binding: { multi_user: true },
      nodes: [{ id: 'glm:component.x', major: 'A', content_hash: 'sha256:abc' }],
      generatorIdentity: GENERATOR,
    });
    const lock = parseSekkeiLock(text);
    expect(lock.root_id).toBe('glm:system.web');
    expect(lock.nodes.length).toBe(1);
    expect(lock.nodes[0]?.content_hash).toBe('sha256:abc');
  });

  test('throws on missing required fields', () => {
    expect(() => parseSekkeiLock('foo: bar')).toThrow();
  });
});

describe('lockHash', () => {
  test('returns sha256: prefix and a stable hex digest', () => {
    const h = lockHash('# canonical\nroot_id: x\n');
    expect(h.startsWith('sha256:')).toBe(true);
    expect(h.length).toBe('sha256:'.length + 64);
  });
});
