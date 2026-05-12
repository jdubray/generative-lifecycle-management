import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { runImport } from '../../../src/import/importer.ts';
import { AuditRepository } from '../../../src/repository/audit-repository.ts';
import { NodeRepository } from '../../../src/repository/node-repository.ts';
import { UserRepository } from '../../../src/repository/user-repository.ts';
import { WorkspaceRepository } from '../../../src/repository/workspace-repository.ts';
import { runMigrations } from '../../../src/repository/db.ts';
import { MIGRATIONS_DIR } from '../helpers.ts';

const SEKKEI_PATH = resolve(import.meta.dir, '..', '..', '..', 'sekkei');

/**
 * End-to-end bootstrap test: point the importer at the real `./sekkei/`
 * tree and assert the structural invariants documented in `sekkei/STRUCTURE.md`
 * + the BOOTSTRAP doc.
 */
describe('importer — glm-self bootstrap', () => {
  let db: Database;
  function makeRepos() {
    return {
      workspaces: new WorkspaceRepository(db),
      users: new UserRepository(db),
      nodes: new NodeRepository(db),
      audit: new AuditRepository(db),
    };
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db, MIGRATIONS_DIR);
  });
  afterEach(() => db.close());

  test('imports the on-disk sekkei into a fresh workspace', () => {
    const summary = runImport(
      { db, repos: makeRepos() },
      {
        source: { kind: 'directory', path: SEKKEI_PATH },
        workspace: { slug: 'glm-self', name: 'GLM (self)' },
        owner: { email: 'alice@example.com' },
      },
    );

    expect(summary.workspace.slug).toBe('glm-self');
    // 1 System + 16 Capabilities + 66 Components + 6 Interactions = 89 nodes.
    expect(summary.nodesInserted).toBe(89);
    expect(summary.nodesUpdated).toBe(0);
    expect(summary.nodesUnchanged).toBe(0);

    const nodes = makeRepos().nodes.listByWorkspace(summary.workspace.id);
    expect(nodes.length).toBe(89);

    // Root system + its 16 composes-of children.
    const root = nodes.find((n) => n.node.glmId === 'kizo:dev.glm');
    expect(root).toBeDefined();
    expect(root?.node.stratum).toBe('system');
    expect(root?.node.systemRole).toBe('root');
    const composes = (root?.relationships ?? []).filter((r) => r.kind === 'composes-of');
    expect(composes.length).toBe(16);

    // Stratum distribution.
    const byStratum = nodes.reduce<Record<string, number>>((acc, n) => {
      acc[n.node.stratum] = (acc[n.node.stratum] ?? 0) + 1;
      return acc;
    }, {});
    expect(byStratum).toEqual({ system: 1, capability: 16, component: 66, interaction: 6 });
  });

  test('owner membership is granted with role=owner', () => {
    const repos = makeRepos();
    const summary = runImport(
      { db, repos },
      {
        source: { kind: 'directory', path: SEKKEI_PATH },
        workspace: { slug: 'glm-self', name: 'GLM (self)' },
        owner: { email: 'alice@example.com' },
      },
    );
    const alice = repos.users.findByEmail('alice@example.com');
    expect(alice).not.toBeNull();
    const membership = repos.workspaces.findMember(summary.workspace.id, alice?.id ?? '');
    expect(membership?.role).toBe('owner');
  });

  test('writes one workspace.import audit row', () => {
    const repos = makeRepos();
    const summary = runImport(
      { db, repos },
      {
        source: { kind: 'directory', path: SEKKEI_PATH },
        workspace: { slug: 'glm-self', name: 'GLM (self)' },
        owner: { email: 'alice@example.com' },
      },
    );
    const audits = repos.audit.listByType(summary.workspace.id, 'workspace.import');
    expect(audits.length).toBe(1);
    const payload = audits[0]?.payload as { inserted: number };
    expect(payload.inserted).toBe(89);
  });

  test('re-running the importer is idempotent (every node unchanged)', () => {
    const first = runImport(
      { db, repos: makeRepos() },
      {
        source: { kind: 'directory', path: SEKKEI_PATH },
        workspace: { slug: 'glm-self', name: 'GLM (self)' },
      },
    );
    expect(first.nodesInserted).toBe(89);

    const second = runImport(
      { db, repos: makeRepos() },
      {
        source: { kind: 'directory', path: SEKKEI_PATH },
        workspace: { slug: 'glm-self', name: 'GLM (self)' },
      },
    );
    expect(second.nodesInserted).toBe(0);
    expect(second.nodesUpdated).toBe(0);
    expect(second.nodesUnchanged).toBe(89);
  });

  test('dry-run reports the same numbers but persists nothing', () => {
    const repos = makeRepos();
    const summary = runImport(
      { db, repos },
      {
        source: { kind: 'directory', path: SEKKEI_PATH },
        workspace: { slug: 'glm-self-dry', name: 'GLM (self) — dry' },
        dryRun: true,
      },
    );
    expect(summary.dryRun).toBe(true);
    expect(summary.nodesInserted).toBe(89);
    // Workspace shouldn't exist after rollback.
    expect(repos.workspaces.findBySlug('glm-self-dry')).toBeNull();
    expect(repos.nodes.listByWorkspace(summary.workspace.id).length).toBe(0);
  });

  test('derives_from second-pass reports cross-revision lineage as missing', () => {
    const repos = makeRepos();
    const summary = runImport(
      { db, repos },
      {
        source: { kind: 'directory', path: SEKKEI_PATH },
        workspace: { slug: 'glm-self', name: 'GLM (self)' },
      },
    );
    // sekkei.yaml's revision note: the A.1 tree drops the A.0 workbench /
    // engine Sub-Systems but Capabilities still record their lineage to
    // those old ids. The importer surfaces them as `derivesFromMissing`
    // (a non-fatal warning) rather than failing the import.
    expect(summary.nodesInserted).toBe(89);
    expect(summary.derivesFromMissing.length).toBeGreaterThan(0);
    for (const m of summary.derivesFromMissing) {
      expect(m.missingTarget.startsWith('kizo:dev.glm.')).toBe(true);
    }
  });
});
