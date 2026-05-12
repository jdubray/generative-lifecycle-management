import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { GeneratorIdentity, Sha256Hash } from '../types.ts';

/**
 * `sekkei.lock` serializer (spec §3.9, §5.4).
 *
 * Shape:
 *
 *   root_id: glm:<...>
 *   parameter_binding:
 *     <name>: <value>
 *   nodes:
 *     - id: glm:<...>
 *       major: A
 *       content_hash: sha256:<hex>
 *   generator_identity:
 *     llm: claude-sonnet-4-6
 *     prompt_version: sha256:<...>
 *     tool_chain: sha256:<...>
 *
 * Output is a stable YAML string: deterministic key order via explicit
 * construction, sortMapEntries=true at the top level so any extra keys land
 * in a defined position. `lockHash()` returns the sha256 of the serialized
 * bytes — that is the value the UI surfaces as `sekkei.lock #abcd1234`.
 */

export interface LockNode {
  id: string;
  major: string;
  content_hash: Sha256Hash;
}

export interface SekkeiLock {
  root_id: string;
  parameter_binding: Record<string, unknown>;
  nodes: LockNode[];
  generator_identity: GeneratorIdentity;
}

export interface SekkeiLockInput {
  rootGlmId: string;
  binding: Record<string, unknown>;
  nodes: LockNode[];
  generatorIdentity: GeneratorIdentity;
}

const HEADER = '# sekkei.lock — pinned by Variant Resolution; do not edit by hand\n';

/** Serialize a lock to canonical YAML. Always ends with `\n`. */
export function serializeSekkeiLock(input: SekkeiLockInput): string {
  const lock: SekkeiLock = {
    root_id: input.rootGlmId,
    parameter_binding: sortKeys(input.binding),
    nodes: [...input.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    generator_identity: sortKeys(input.generatorIdentity as Record<string, unknown>) as GeneratorIdentity,
  };
  const body = stringifyYaml(lock, { lineWidth: 0, indent: 2 });
  return HEADER + body;
}

/** Parse a serialized lock back into a structured value. */
export function parseSekkeiLock(text: string): SekkeiLock {
  const value = parseYaml(text) as Record<string, unknown> | null;
  if (!value || typeof value !== 'object') throw new Error('sekkei.lock is not a YAML mapping');
  if (typeof value.root_id !== 'string') throw new Error('sekkei.lock missing root_id');
  if (!value.nodes || !Array.isArray(value.nodes)) throw new Error('sekkei.lock missing nodes[]');
  for (const n of value.nodes) {
    if (!n || typeof n !== 'object') throw new Error('sekkei.lock node entry must be a mapping');
    const node = n as Record<string, unknown>;
    if (typeof node.id !== 'string' || typeof node.major !== 'string' || typeof node.content_hash !== 'string') {
      throw new Error('sekkei.lock node missing id/major/content_hash');
    }
  }
  if (!value.generator_identity || typeof value.generator_identity !== 'object') {
    throw new Error('sekkei.lock missing generator_identity');
  }
  return value as unknown as SekkeiLock;
}

/** sha256 of the serialized bytes, prefixed with `sha256:`. */
export function lockHash(text: string): Sha256Hash {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = obj[key];
  }
  return out;
}
