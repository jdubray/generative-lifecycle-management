import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { appliedMigrations, closeDb, openDb, runMigrations } from '../../../src/repository/db.ts';
import { MIGRATIONS_DIR, openTestDb } from '../helpers.ts';

describe('db.ts — pragmas, migrations, schema', () => {
  let db: Database;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    db.close();
  });

  test('foreign_keys pragma is ON', () => {
    const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
  });

  test('migrations are recorded in schema_migrations', () => {
    const applied = appliedMigrations(db);
    expect(applied.length).toBeGreaterThanOrEqual(1);
    const initial = applied.find((m) => m.version === 1);
    expect(initial).toBeDefined();
    expect(initial?.name).toBe('initial');
  });

  test('runMigrations is idempotent — running again applies nothing', () => {
    const beforeCount = appliedMigrations(db).length;
    const result = runMigrations(db, MIGRATIONS_DIR);
    expect(result).toEqual([]);
    expect(appliedMigrations(db).length).toBe(beforeCount);
  });

  test('every spec table exists', () => {
    const expected = [
      'users',
      'workspaces',
      'workspace_members',
      'nodes',
      'node_parameters',
      'node_constraints',
      'node_relationships',
      'external_deps',
      'generated_artifacts',
      'edit_locks',
      'change_log',
      'verification_runs',
      'audit_events',
      'scrs',
      'scr_approvals',
      'variants',
      'variant_rollout',
      'drift_records',
      'reuse_candidates',
      'provenance_events',
    ];
    for (const name of expected) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(name);
      expect(row).not.toBeNull();
    }
  });

  test('key indexes from spec are present', () => {
    const expected = [
      'idx_nodes_workspace_stratum',
      'idx_node_relationships_target',
      'idx_change_log_workspace_ts',
      'idx_audit_events_workspace_ts',
      'idx_provenance_events_workspace_ts',
      'idx_drift_records_workspace_status',
      'idx_variants_workspace',
    ];
    for (const name of expected) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
        .get(name);
      expect(row).not.toBeNull();
    }
  });
});

describe('openDb — production-mode safety check', () => {
  // Drop the singleton AND any NODE_ENV the test runner set, then restore both
  // afterwards. The check itself is what we are exercising.
  const savedEnv = process.env.NODE_ENV;
  const savedPath = process.env.GLM_DB_PATH;

  beforeEach(() => {
    closeDb();
    delete process.env.GLM_DB_PATH;
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    closeDb();
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
    if (savedPath === undefined) delete process.env.GLM_DB_PATH;
    else process.env.GLM_DB_PATH = savedPath;
  });

  test('refuses to open :memory: outside NODE_ENV=test', () => {
    expect(() => openDb()).toThrow(/Refusing to start with `:memory:`/);
  });

  test('refuses explicit options.path = :memory: outside test mode', () => {
    expect(() => openDb({ path: ':memory:' })).toThrow(/Refusing to start with `:memory:`/);
  });

  test('NODE_ENV=test allows :memory: (no throw)', () => {
    process.env.NODE_ENV = 'test';
    expect(() => openDb({ path: ':memory:', migrationsDir: MIGRATIONS_DIR })).not.toThrow();
  });
});
