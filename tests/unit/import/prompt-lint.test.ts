/**
 * P3-D: Prompt-authoring lint — unit tests for the lintPromptNode function
 * that runs inside runImport after adaptYamlNode.
 *
 * We test indirectly via a minimal runImport call using an in-memory SQLite DB,
 * matching the pattern used by the integration import tests.
 */

import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { runImport } from '../../../src/import/importer.ts';
import { NodeRepository } from '../../../src/repository/node-repository.ts';
import { WorkspaceRepository } from '../../../src/repository/workspace-repository.ts';
import { AuditRepository } from '../../../src/repository/audit-repository.ts';
import { UserRepository } from '../../../src/repository/user-repository.ts';
import { runMigrations } from '../../../src/repository/db.ts';
import { resolve } from 'node:path';

const MIGRATIONS_DIR = resolve(import.meta.dir, '..', '..', '..', 'migrations');

function makeDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

function makeDeps(db: Database) {
  return {
    db,
    repos: {
      workspaces: new WorkspaceRepository(db),
      users: new UserRepository(db),
      nodes: new NodeRepository(db),
      audit: new AuditRepository(db),
    },
  };
}

/** Minimal spec.prompt YAML doc as a string. */
function promptYaml(instructionText: string): string {
  return `---
id: 'acme:web.shop.spec_prompt'
stratum: spec
spec_kind: prompt
title: Prompt
revision:
  major: A
  iteration: 0
  status: in_work
provenance:
  override_kind: net_new
  authored_by: test
  authored_at: '2026-01-01T00:00:00Z'
body:
  context_bundle: 'cb'
  outputs: []
  verifier: 'bun test'
  instructions: '${instructionText}'
`;
}

describe('P3-D: prompt-lint warnings', () => {
  test('clean prompt produces no prompt-lint warnings', () => {
    const db = makeDb();
    const summary = runImport(makeDeps(db), {
      source: { kind: 'inline', documents: [{ filename: 'p.yaml', content: promptYaml('implement the catalog service') }] },
      workspace: { slug: 'test', name: 'Test' },
    });
    const lintWarnings = summary.warnings.filter((w) => w.includes('prompt-lint:'));
    expect(lintWarnings).toHaveLength(0);
  });

  test('"run the tests" triggers prompt-lint warning', () => {
    const db = makeDb();
    const summary = runImport(makeDeps(db), {
      source: { kind: 'inline', documents: [{ filename: 'p.yaml', content: promptYaml('implement the service then run the tests') }] },
      workspace: { slug: 'test2', name: 'Test2' },
    });
    const lintWarnings = summary.warnings.filter((w) => w.includes('prompt-lint:'));
    expect(lintWarnings.length).toBeGreaterThan(0);
    expect(lintWarnings[0]).toContain('acme:web.shop.spec_prompt');
    expect(lintWarnings[0]).toContain('spec.acceptance');
  });

  test('"confirm exit code 0" triggers prompt-lint warning', () => {
    const db = makeDb();
    const summary = runImport(makeDeps(db), {
      source: { kind: 'inline', documents: [{ filename: 'p.yaml', content: promptYaml('implement and confirm exit code 0') }] },
      workspace: { slug: 'test3', name: 'Test3' },
    });
    const lintWarnings = summary.warnings.filter((w) => w.includes('prompt-lint:'));
    expect(lintWarnings.length).toBeGreaterThan(0);
  });

  test('"make sure tests pass" triggers prompt-lint warning', () => {
    const db = makeDb();
    const summary = runImport(makeDeps(db), {
      source: { kind: 'inline', documents: [{ filename: 'p.yaml', content: promptYaml('make sure tests pass after each change') }] },
      workspace: { slug: 'test4', name: 'Test4' },
    });
    const lintWarnings = summary.warnings.filter((w) => w.includes('prompt-lint:'));
    expect(lintWarnings.length).toBeGreaterThan(0);
  });

  test('non-prompt spec nodes are not linted', () => {
    const db = makeDb();
    const funcYaml = `---
id: 'acme:web.shop.spec_functional'
stratum: spec
spec_kind: functional
title: Functional
revision:
  major: A
  iteration: 0
  status: in_work
provenance:
  override_kind: net_new
  authored_by: test
  authored_at: '2026-01-01T00:00:00Z'
body:
  interface: 'run the tests to verify the interface'
`;
    const summary = runImport(makeDeps(db), {
      source: { kind: 'inline', documents: [{ filename: 'f.yaml', content: funcYaml }] },
      workspace: { slug: 'test5', name: 'Test5' },
    });
    const lintWarnings = summary.warnings.filter((w) => w.includes('prompt-lint:'));
    expect(lintWarnings).toHaveLength(0);
  });
});
