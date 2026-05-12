import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GeneratorIdentity, Sha256Hash } from '../types.ts';
import { canonicalize } from '../domain/content-hash.ts';

/**
 * Content-addressed cache for generated artifacts (spec §9.6).
 *
 * Cache key:
 *
 *   generation_hash = sha256( design_hash || binding_hash || generator_identity_canonical )
 *
 * On disk the cache is laid out as:
 *
 *   <root>/<two-char-prefix>/<rest-of-hex>/<safe-filename>
 *
 * where `safe-filename` is the relative output path with `/` replaced by
 * `__SLASH__`. The first two hex characters are split out as a sharding
 * subdirectory so a single workspace's cache never grows a directory with
 * thousands of entries.
 */

export interface CacheKeyInput {
  /** sha256 over the resolved closure (spec §5.4: closure_hash). */
  closureHash: Sha256Hash;
  /** sha256 over the canonical-JSON of the parameter binding. */
  bindingHash: Sha256Hash;
  /** Identity of the generator (model + prompt + tool chain). */
  generatorIdentity: GeneratorIdentity;
  /**
   * Git Step 7: sha256 of the artifact produced in the previous generation.
   * When present the cache key is keyed to this specific prior output, so a
   * diff-aware re-gen and a blank-slate gen never share a cache entry.
   */
  prevArtifactHash?: Sha256Hash;
}

/** Compute the cache key. Returns `<hex>` (no prefix). */
export function generationHash(input: CacheKeyInput): string {
  const generatorCanonical = canonicalize(input.generatorIdentity as Record<string, unknown>);
  const prevPart = input.prevArtifactHash ? `|${stripPrefix(input.prevArtifactHash)}` : '';
  const payload = `${stripPrefix(input.closureHash)}|${stripPrefix(input.bindingHash)}|${generatorCanonical}${prevPart}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export interface CacheGetResult {
  hit: boolean;
  bytes?: Buffer;
}

/**
 * In-memory cache backend — used by tests. Production wires up
 * `FileSystemGenerationCache` rooted at a directory inside the realization
 * repo's `.cache/` folder (or wherever the operator points it).
 */
export interface GenerationCache {
  /** Get cached bytes for `(key, filename)`, or `{ hit: false }`. */
  get(key: string, filename: string): CacheGetResult;
  /** Persist bytes under `(key, filename)`. Returns the absolute storage path (or null for in-memory). */
  put(key: string, filename: string, bytes: Buffer): string | null;
  /** True iff `(key, filename)` is in the cache. */
  has(key: string, filename: string): boolean;
}

export class InMemoryGenerationCache implements GenerationCache {
  private readonly store = new Map<string, Buffer>();

  get(key: string, filename: string): CacheGetResult {
    const bytes = this.store.get(this.compoundKey(key, filename));
    return bytes ? { hit: true, bytes } : { hit: false };
  }

  put(key: string, filename: string, bytes: Buffer): null {
    this.store.set(this.compoundKey(key, filename), bytes);
    return null;
  }

  has(key: string, filename: string): boolean {
    return this.store.has(this.compoundKey(key, filename));
  }

  size(): number {
    return this.store.size;
  }

  private compoundKey(key: string, filename: string): string {
    return `${key}:${filename}`;
  }
}

export class FileSystemGenerationCache implements GenerationCache {
  public readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    mkdirSync(rootDir, { recursive: true });
  }

  get(key: string, filename: string): CacheGetResult {
    const path = this.pathFor(key, filename);
    if (!existsSync(path)) return { hit: false };
    return { hit: true, bytes: readFileSync(path) };
  }

  put(key: string, filename: string, bytes: Buffer): string {
    const path = this.pathFor(key, filename);
    mkdirSync(dirname(path), { recursive: true });
    // Atomic write: drop the file at a sibling .tmp first, then rename
    // over the final path so concurrent readers never observe a torn file.
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, bytes);
    try {
      // renameSync on Windows refuses if the destination already exists,
      // so unlink the previous entry first when present.
      if (existsSync(path)) unlinkSync(path);
      renameSync(tmp, path);
    } catch (err) {
      try { unlinkSync(tmp); } catch {}
      throw err;
    }
    return path;
  }

  has(key: string, filename: string): boolean {
    return existsSync(this.pathFor(key, filename));
  }

  private pathFor(key: string, filename: string): string {
    if (key.length < 4) throw new Error('cache key too short');
    const prefix = key.slice(0, 2);
    const rest = key.slice(2);
    const safeName = filename.replace(/\//g, '__SLASH__').replace(/\\/g, '__SLASH__');
    return join(this.rootDir, prefix, rest, safeName);
  }
}

function stripPrefix(h: string): string {
  return h.startsWith('sha256:') ? h.slice('sha256:'.length) : h;
}
