import { createHash } from 'node:crypto';

/**
 * Content addressing for sekkei nodes.
 *
 * The spec (§6.1) requires every node body to have a stable, content-addressed
 * digest. Bodies travel through three serializations during the system's life:
 *
 *   - in-memory JS value (what TypeScript code holds)
 *   - JSON in SQLite (`nodes.body_json`)
 *   - block-style YAML on disk in the sekkei repo
 *
 * To keep `content_hash` invariant across those forms we hash a **canonical
 * JSON serialization** of the body:
 *
 *   - object keys sorted lexicographically at every depth
 *   - no insignificant whitespace
 *   - unicode is left as-is (JSON.stringify only escapes when required)
 *   - `undefined` is rejected; arrays preserve order; nested objects recurse
 *
 * Phase 4's YAML store parses the YAML file, feeds the resulting value to
 * `canonicalize()`, and re-hashes — so the same body produces the same hash
 * regardless of representation. The chosen prefix `sha256:` matches the spec
 * (e.g. `content_hash: sha256:<hex>`).
 */
export const HASH_PREFIX = 'sha256:';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Stable JSON serialization with sorted keys. Throws on non-JSON values. */
export function canonicalize(value: unknown): string {
  if (value === undefined) {
    throw new TypeError('canonicalize: undefined is not a JSON value');
  }
  return serialize(value);
}

/** Compute `sha256:<hex>` of the canonical serialization of `body`. */
export function contentHash(body: unknown): string {
  const canonical = canonicalize(body);
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `${HASH_PREFIX}${digest}`;
}

/**
 * Re-compute the hash of `body` and compare to `expected`. Returns true on
 * match. Repositories call this after every read; a `false` here should be
 * raised as `ContentHashMismatchError` by the caller.
 */
export function verifyContentHash(body: unknown, expected: string): boolean {
  return contentHash(body) === expected;
}

/** Error type raised by repositories when a stored hash does not match the body. */
export class ContentHashMismatchError extends Error {
  public readonly expected: string;
  public readonly actual: string;
  constructor(expected: string, actual: string) {
    super(`content_hash mismatch: expected ${expected} but body hashes to ${actual}`);
    this.name = 'ContentHashMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function serialize(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalize: ${value} is not a finite number`);
      }
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object':
      if (Array.isArray(value)) {
        return `[${value.map((v) => serialize(v)).join(',')}]`;
      }
      return serializeObject(value as Record<string, unknown>);
    default:
      throw new TypeError(`canonicalize: ${typeof value} is not a JSON value`);
  }
}

function serializeObject(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined) continue; // skip undefined fields, matching JSON.stringify
    parts.push(`${JSON.stringify(key)}:${serialize(v)}`);
  }
  return `{${parts.join(',')}}`;
}
