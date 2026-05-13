/**
 * Minimal RFC-6902 JSON-Patch implementation for `glm refine`.
 *
 * Supports the four ops we actually expect from Claude: `add`, `remove`,
 * `replace`, `move`. Operates on a defensive deep clone of the input so the
 * caller's object is never mutated.
 *
 * `copy` and `test` are deliberately omitted — `copy` is rare in practice and
 * `test` is for transactional patch sequences we don't run. If Claude emits
 * either, we throw rather than silently skipping.
 */

export interface JsonPatchOp {
  op: 'add' | 'remove' | 'replace' | 'move';
  path: string;
  /** Required for add / replace. */
  value?: unknown;
  /** Required for move. */
  from?: string;
}

export class JsonPatchError extends Error {
  public readonly op: JsonPatchOp;
  constructor(op: JsonPatchOp, message: string) {
    super(`JSON-Patch op ${op.op} '${op.path}': ${message}`);
    this.name = 'JsonPatchError';
    this.op = op;
  }
}

export function applyJsonPatch(target: unknown, ops: readonly JsonPatchOp[]): unknown {
  let doc = deepClone(target);
  for (const op of ops) {
    doc = applyOne(doc, op);
  }
  return doc;
}

// ---------------------------------------------------------------------- core

function applyOne(doc: unknown, op: JsonPatchOp): unknown {
  switch (op.op) {
    case 'add':
      return setAt(doc, op, parsePointer(op.path), op.value, 'add');
    case 'replace':
      return setAt(doc, op, parsePointer(op.path), op.value, 'replace');
    case 'remove':
      return removeAt(doc, op, parsePointer(op.path));
    case 'move': {
      if (!op.from) throw new JsonPatchError(op, "'move' requires a 'from' field");
      const fromTokens = parsePointer(op.from);
      const value = readAt(doc, op, fromTokens);
      const withoutSource = removeAt(doc, op, fromTokens);
      return setAt(withoutSource, op, parsePointer(op.path), value, 'add');
    }
    default:
      throw new JsonPatchError(op, `unsupported op (only add/remove/replace/move are implemented)`);
  }
}

function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw new Error(`invalid JSON Pointer: '${pointer}' (must be empty or start with '/')`);
  }
  return pointer
    .slice(1)
    .split('/')
    .map((tok) => tok.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readAt(doc: unknown, op: JsonPatchOp, tokens: readonly string[]): unknown {
  let current: unknown = doc;
  for (const token of tokens) {
    if (isArray(current)) {
      const idx = parseArrayIndex(token, current.length, op);
      current = current[idx];
    } else if (isObject(current)) {
      if (!(token in current)) {
        throw new JsonPatchError(op, `path token '${token}' not found`);
      }
      current = current[token];
    } else {
      throw new JsonPatchError(op, `cannot descend into ${typeof current}`);
    }
  }
  return current;
}

function setAt(
  doc: unknown,
  op: JsonPatchOp,
  tokens: readonly string[],
  value: unknown,
  semantics: 'add' | 'replace',
): unknown {
  if (tokens.length === 0) {
    return value;
  }
  const parentTokens = tokens.slice(0, -1);
  const lastToken = tokens[tokens.length - 1] as string;
  const parent = readAt(doc, op, parentTokens);

  if (isArray(parent)) {
    if (lastToken === '-') {
      parent.push(value);
      return doc;
    }
    const idx = parseArrayIndex(lastToken, parent.length + (semantics === 'add' ? 1 : 0), op);
    if (semantics === 'add') {
      parent.splice(idx, 0, value);
    } else {
      if (idx >= parent.length) {
        throw new JsonPatchError(op, `replace index ${idx} out of bounds`);
      }
      parent[idx] = value;
    }
    return doc;
  }

  if (isObject(parent)) {
    parent[lastToken] = value;
    return doc;
  }

  throw new JsonPatchError(op, `cannot ${semantics} into ${typeof parent}`);
}

function removeAt(doc: unknown, op: JsonPatchOp, tokens: readonly string[]): unknown {
  if (tokens.length === 0) {
    throw new JsonPatchError(op, 'cannot remove the document root');
  }
  const parentTokens = tokens.slice(0, -1);
  const lastToken = tokens[tokens.length - 1] as string;
  const parent = readAt(doc, op, parentTokens);

  if (isArray(parent)) {
    const idx = parseArrayIndex(lastToken, parent.length, op);
    parent.splice(idx, 1);
    return doc;
  }

  if (isObject(parent)) {
    if (!(lastToken in parent)) {
      throw new JsonPatchError(op, `key '${lastToken}' not found`);
    }
    delete parent[lastToken];
    return doc;
  }

  throw new JsonPatchError(op, `cannot remove from ${typeof parent}`);
}

function parseArrayIndex(token: string, length: number, op: JsonPatchOp): number {
  if (token === '-') return length;
  if (!/^\d+$/.test(token)) {
    throw new JsonPatchError(op, `invalid array index '${token}'`);
  }
  const idx = Number.parseInt(token, 10);
  if (idx < 0) throw new JsonPatchError(op, `negative array index '${idx}'`);
  return idx;
}

function deepClone<T>(value: T): T {
  // structuredClone handles all JSON types and is in Bun + modern Node.
  return structuredClone(value);
}
