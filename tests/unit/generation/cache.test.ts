import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileSystemGenerationCache,
  generationHash,
  InMemoryGenerationCache,
} from '../../../src/generation/cache.ts';

const GENERATOR = { llm: 'claude-sonnet-4-6', promptVersion: 'sha256:a', toolChain: 'sha256:b' };

describe('generationHash', () => {
  test('produces a 64-char hex (no prefix)', () => {
    const h = generationHash({
      closureHash: 'sha256:aaaa',
      bindingHash: 'sha256:bbbb',
      generatorIdentity: GENERATOR,
    });
    expect(h.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(h)).toBe(true);
  });

  test('changes when any input changes', () => {
    const base = generationHash({
      closureHash: 'sha256:a',
      bindingHash: 'sha256:b',
      generatorIdentity: GENERATOR,
    });
    const otherClosure = generationHash({
      closureHash: 'sha256:other',
      bindingHash: 'sha256:b',
      generatorIdentity: GENERATOR,
    });
    const otherBinding = generationHash({
      closureHash: 'sha256:a',
      bindingHash: 'sha256:other',
      generatorIdentity: GENERATOR,
    });
    expect(otherClosure).not.toBe(base);
    expect(otherBinding).not.toBe(base);
  });

  test('is invariant to generator key ordering', () => {
    const a = generationHash({
      closureHash: 'sha256:c',
      bindingHash: 'sha256:b',
      generatorIdentity: { llm: 'x', promptVersion: 'p', toolChain: 't' },
    });
    const b = generationHash({
      closureHash: 'sha256:c',
      bindingHash: 'sha256:b',
      generatorIdentity: { toolChain: 't', llm: 'x', promptVersion: 'p' },
    });
    expect(a).toBe(b);
  });
});

describe('InMemoryGenerationCache', () => {
  test('put/get/has round-trip', () => {
    const cache = new InMemoryGenerationCache();
    expect(cache.has('k', 'a.ts')).toBe(false);
    cache.put('k', 'a.ts', Buffer.from('content'));
    expect(cache.has('k', 'a.ts')).toBe(true);
    expect(cache.get('k', 'a.ts').bytes?.toString()).toBe('content');
  });

  test('different filenames under the same key are independent', () => {
    const cache = new InMemoryGenerationCache();
    cache.put('k', 'a.ts', Buffer.from('A'));
    cache.put('k', 'b.ts', Buffer.from('B'));
    expect(cache.get('k', 'a.ts').bytes?.toString()).toBe('A');
    expect(cache.get('k', 'b.ts').bytes?.toString()).toBe('B');
  });
});

describe('FileSystemGenerationCache', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('persists bytes on disk under the sharded path', () => {
    dir = mkdtempSync(join(tmpdir(), 'glm-cache-'));
    const cache = new FileSystemGenerationCache(dir);
    const key = '0123456789abcdef'.repeat(4); // 64 chars
    const out = cache.put(key, 'src/a.ts', Buffer.from('hello'));
    expect(out).toContain(join(dir, '01'));
    expect(cache.has(key, 'src/a.ts')).toBe(true);
    expect(cache.get(key, 'src/a.ts').bytes?.toString()).toBe('hello');
  });

  test('escapes path separators in filenames', () => {
    dir = mkdtempSync(join(tmpdir(), 'glm-cache-'));
    const cache = new FileSystemGenerationCache(dir);
    const key = '00' + '0'.repeat(62);
    const written = cache.put(key, 'a/b/c.ts', Buffer.from('x'));
    expect(written).toContain('a__SLASH__b__SLASH__c.ts');
  });
});
