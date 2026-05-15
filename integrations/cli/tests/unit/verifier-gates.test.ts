/**
 * Unit tests for verifier gates — focusing on the Phase 2 additions:
 *   - P2-A: resolveSiblingInterfaceRefs + buildContextBundle sibling section
 *   - P2-B: gate7IntegrationCheck
 *
 * Existing gates (1-6) are covered by the TodoMVC verify_sekkei.py and the
 * integration sekkei. These tests cover the new behaviour only.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gate7IntegrationCheck,
  runGates,
  type SpawnSyncFn,
  type VerifierInput,
} from '../../../../src/verifier/gates.ts';
import {
  resolveSiblingInterfaceRefs,
  buildContextBundle,
} from '../../../../src/generation/component-spec.ts';
import type { NodeRelationship } from '../../../../src/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRelationship(kind: NodeRelationship['kind'], targetGlmId: string): NodeRelationship {
  return { sourceNodeId: 'src', ord: 0, kind, targetGlmId, attributes: null };
}

/** Minimal stub NodeRepository used by buildContextBundle. */
function makeNodeRepo(nodes: Array<{ glmId: string; body: unknown; contentHash?: string }>) {
  return {
    findByGlmId: (_workspaceId: string, glmId: string) => {
      const n = nodes.find((x) => x.glmId === glmId);
      if (!n) return null;
      return {
        node: {
          glmId: n.glmId,
          body: n.body,
          contentHash: n.contentHash ?? 'sha256:aabbcc',
          stratum: 'spec',
          specKind: 'functional',
        },
        parameters: [],
        constraints: [],
        relationships: [],
      };
    },
  } as unknown as Parameters<typeof buildContextBundle>[0];
}

/** Stub spawnSync that returns a canned exit code and stderr. */
function makeSpawnSync(exitCode: number, stderr: string): SpawnSyncFn {
  return () => ({
    exitCode,
    stderr: Buffer.from(stderr, 'utf8'),
  });
}

// ---------------------------------------------------------------------------
// P2-A: resolveSiblingInterfaceRefs
// ---------------------------------------------------------------------------

describe('resolveSiblingInterfaceRefs', () => {
  test('emits spec.functional + spec.schema for each depends-on target', () => {
    const rels: NodeRelationship[] = [
      makeRelationship('depends-on', 'acme:web.shop.catalog.product_repository'),
    ];
    const refs = resolveSiblingInterfaceRefs(rels);
    expect(refs).toContain('acme:web.shop.catalog.product_repository.spec.functional');
    expect(refs).toContain('acme:web.shop.catalog.product_repository.spec.schema');
  });

  test('emits refs for composes-of targets', () => {
    const rels: NodeRelationship[] = [
      makeRelationship('composes-of', 'acme:web.shop.catalog.filter_engine'),
    ];
    const refs = resolveSiblingInterfaceRefs(rels);
    expect(refs).toContain('acme:web.shop.catalog.filter_engine.spec.functional');
  });

  test('ignores non-dependency relationship kinds', () => {
    const rels: NodeRelationship[] = [
      makeRelationship('generates', 'acme:artifact'),
      makeRelationship('derives-from', 'acme:parent'),
      makeRelationship('implements', 'acme:interaction'),
    ];
    expect(resolveSiblingInterfaceRefs(rels)).toHaveLength(0);
  });

  test('skips external refs (pkg:, dep:, svc:, hw:)', () => {
    const rels: NodeRelationship[] = [
      makeRelationship('depends-on', 'pkg:npm/hono@4'),
      makeRelationship('depends-on', 'dep:pg'),
      makeRelationship('depends-on', 'svc:stripe'),
      makeRelationship('depends-on', 'hw:gpu'),
    ];
    expect(resolveSiblingInterfaceRefs(rels)).toHaveLength(0);
  });

  test('de-duplicates when the same target appears in both depends-on and composes-of', () => {
    const rels: NodeRelationship[] = [
      makeRelationship('depends-on', 'acme:web.shop.catalog.repo'),
      makeRelationship('composes-of', 'acme:web.shop.catalog.repo'),
    ];
    const refs = resolveSiblingInterfaceRefs(rels);
    // Should appear exactly once, not twice.
    expect(refs.filter((r) => r === 'acme:web.shop.catalog.repo.spec.functional')).toHaveLength(1);
  });

  test('returns empty array for a component with no relationships', () => {
    expect(resolveSiblingInterfaceRefs([])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// P2-A: buildContextBundle — sibling section injection
// ---------------------------------------------------------------------------

describe('buildContextBundle sibling refs', () => {
  test('injects DEPENDENCY INTERFACES header when sibling refs resolve', () => {
    const nodes = makeNodeRepo([
      { glmId: 'acme:repo.spec.functional', body: { interface: 'fn foo()' } },
    ]);
    const result = buildContextBundle(nodes, 'ws-1', [], ['acme:repo.spec.functional']);
    expect(result.text).toContain('DEPENDENCY INTERFACES');
    expect(result.text).toContain('acme:repo.spec.functional');
  });

  test('does NOT inject header when all sibling refs are missing (silent omission)', () => {
    const nodes = makeNodeRepo([]); // empty repo
    const result = buildContextBundle(nodes, 'ws-1', [], ['acme:missing.spec.functional']);
    expect(result.text).not.toContain('DEPENDENCY INTERFACES');
    expect(result.text).not.toContain('not found'); // missing siblings are silent
  });

  test('explicit refs appear before the sibling section', () => {
    const nodes = makeNodeRepo([
      { glmId: 'acme:system', body: { name: 'system' } },
      { glmId: 'acme:dep.spec.functional', body: { fn: 'bar()' } },
    ]);
    const result = buildContextBundle(nodes, 'ws-1', ['acme:system'], ['acme:dep.spec.functional']);
    const systemIdx = result.text.indexOf('acme:system');
    const headerIdx = result.text.indexOf('DEPENDENCY INTERFACES');
    const siblingIdx = result.text.indexOf('acme:dep.spec.functional');
    expect(systemIdx).toBeLessThan(headerIdx);
    expect(headerIdx).toBeLessThan(siblingIdx);
  });

  test('binding hash covers both explicit and sibling resolved content hashes', () => {
    const nodes = makeNodeRepo([
      { glmId: 'acme:explicit', body: {}, contentHash: 'sha256:explicit' },
      { glmId: 'acme:sibling.spec.functional', body: {}, contentHash: 'sha256:sibling' },
    ]);
    const withSibling = buildContextBundle(nodes, 'ws-1', ['acme:explicit'], ['acme:sibling.spec.functional']);
    const withoutSibling = buildContextBundle(nodes, 'ws-1', ['acme:explicit'], []);
    // Adding a sibling changes the binding hash (provenance-awareness).
    expect(withSibling.bindingHash).not.toBe(withoutSibling.bindingHash);
  });

  test('missing explicit refs still emit a "not found" marker (unchanged behaviour)', () => {
    const nodes = makeNodeRepo([]);
    const result = buildContextBundle(nodes, 'ws-1', ['acme:missing'], []);
    expect(result.text).toContain("ref 'acme:missing' not found in workspace; skipping");
  });
});

// ---------------------------------------------------------------------------
// P2-B: gate7IntegrationCheck
// ---------------------------------------------------------------------------

describe('gate7IntegrationCheck', () => {
  let tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs = [];
  });

  function makeTmpDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'glm-gate7-'));
    tmpDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content, 'utf8');
    }
    return dir;
  }

  // Skipped paths
  test('passed + info when sourceDir is null', () => {
    const result = gate7IntegrationCheck(null);
    expect(result.passed).toBe(true);
    expect(result.name).toBe('7.integration_check');
    expect(result.issues[0]).toContain('skipped');
    expect(result.issues[0]).toContain('no source_dir');
  });

  test('passed + info when sourceDir is undefined', () => {
    const result = gate7IntegrationCheck(undefined);
    expect(result.passed).toBe(true);
    expect(result.issues[0]).toContain('skipped');
  });

  test('passed + info when sourceDir directory does not exist on disk', () => {
    const result = gate7IntegrationCheck('/this/path/does/not/exist/at/all');
    expect(result.passed).toBe(true);
    expect(result.issues[0]).toContain('does not exist on disk');
  });

  // Prerequisite failures
  test('fails when package.json is missing', () => {
    const dir = makeTmpDir({ 'tsconfig.json': '{}' });
    // Create node_modules/.bin/tsc so only package.json is missing.
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\nexit 0\n');
    const result = gate7IntegrationCheck(dir);
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.includes('package.json'))).toBe(true);
  });

  test('fails when tsconfig.json is missing', () => {
    const dir = makeTmpDir({ 'package.json': '{"name":"x"}' });
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '.bin', 'tsc'), '');
    const result = gate7IntegrationCheck(dir);
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.includes('tsconfig.json'))).toBe(true);
  });

  test('fails when node_modules/.bin/tsc is missing', () => {
    const dir = makeTmpDir({
      'package.json': '{"name":"x"}',
      'tsconfig.json': '{}',
    });
    const result = gate7IntegrationCheck(dir);
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.includes('node_modules/.bin/tsc'))).toBe(true);
  });

  // tsc execution paths (via injected spawnSync)
  test('passed when injected tsc exits 0', () => {
    const dir = makeTmpDir({
      'package.json': '{"name":"x"}',
      'tsconfig.json': '{}',
      'node_modules/.bin/tsc': '',
    });
    const result = gate7IntegrationCheck(dir, makeSpawnSync(0, ''));
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test('fails when injected tsc exits 1, issues include stderr lines', () => {
    const dir = makeTmpDir({
      'package.json': '{"name":"x"}',
      'tsconfig.json': '{}',
      'node_modules/.bin/tsc': '',
    });
    const stderr = [
      'src/server.ts(42,5): error TS2345: Argument of type …',
      'src/service.ts(18,3): error TS2304: Cannot find name …',
    ].join('\n');
    const result = gate7IntegrationCheck(dir, makeSpawnSync(1, stderr));
    expect(result.passed).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]).toContain('TS2345');
    expect(result.issues[1]).toContain('TS2304');
  });

  test('truncates stderr beyond TSC_STDERR_LINE_LIMIT and appends a count', () => {
    const dir = makeTmpDir({
      'package.json': '{"name":"x"}',
      'tsconfig.json': '{}',
      'node_modules/.bin/tsc': '',
    });
    const manyErrors = Array.from({ length: 50 }, (_, i) => `file.ts(${i},1): error TS000${i}: msg`).join('\n');
    const result = gate7IntegrationCheck(dir, makeSpawnSync(2, manyErrors));
    expect(result.passed).toBe(false);
    // 30 real lines + 1 truncation message = 31 total
    expect(result.issues.length).toBe(31);
    expect(result.issues[30]).toContain('more errors truncated');
  });

  // runGates integration — gate 7 is included in the result array
  test('runGates includes gate 7 result in the array', () => {
    const input: VerifierInput = { nodes: [], sourceDir: null };
    const result = runGates(input);
    const gate7 = result.gates.find((g) => g.name === '7.integration_check');
    expect(gate7).toBeDefined();
    expect(gate7?.passed).toBe(true); // skipped with no sourceDir
  });

  test('runGates fails overall when gate 7 fails', () => {
    const dir = makeTmpDir({
      'package.json': '{"name":"x"}',
      'tsconfig.json': '{}',
      'node_modules/.bin/tsc': '',
    });
    const failingSpawn = makeSpawnSync(1, 'src/x.ts(1,1): error TS2345: type error');
    const input: VerifierInput = { nodes: [], sourceDir: dir };
    const result = runGates(input, failingSpawn);
    expect(result.overallPass).toBe(false);
  });
});
