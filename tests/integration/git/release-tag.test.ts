/**
 * Git Step 8 acceptance tests — Effectivity Tags.
 *
 * AC-50  createRelease tags HEAD with the given name and message.
 * AC-51  createRelease validates the release name format; invalid names throw.
 * AC-52  On the first release (no prior tag) rollout_records are created for
 *        every variant node enrolled in the workspace.
 * AC-53  On a subsequent release only nodes whose YAML files changed between
 *        the prior tag and HEAD produce rollout_records rows.
 * AC-54  advance() moves a rollout_record from pending → advanced; blocked works too.
 * AC-55  pre-receive hook rejects a direct push to refs/heads/main.
 * AC-56  pre-receive hook rejects a force-push on any branch.
 * AC-57  pre-receive hook rejects a push to variants/* when sekkei.lock is absent.
 * AC-58  pre-receive hook accepts a normal push to next with an ECN commit.
 * AC-59  pre-receive hook rejects a push to next when a commit lacks ECN: prefix.
 * AC-60  pre-receive hook accepts an annotated release tag push.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../../../src/repository/db.ts';
import { RolloutRepository } from '../../../src/repository/rollout-repository.ts';
import { VariantRepository } from '../../../src/repository/variant-repository.ts';
import { NodeRepository } from '../../../src/repository/node-repository.ts';
import { createRelease } from '../../../src/git/sekkei-git-service.ts';
import { installHooks, PRE_RECEIVE_HOOK } from '../../../src/git/hook-installer.ts';
import { GitClient } from '../../../src/git/git-client.ts';
import { contentHash } from '../../../src/domain/content-hash.ts';
import { makeTempRepo, type TempRepo } from './helpers.ts';
import { MIGRATIONS_DIR } from '../helpers.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOW = '2026-05-12T00:00:00.000Z';
const WS_ID = 'ws-test';
const NODE_ID = 'node-comp-1';
const NODE_GLM_ID = 'glm:component.auth';
const VARIANT_ID = 'variant-stable';

const NODE_BODY = { boundary: 'auth-service', runtime: 'node' };
/** Real content hash of NODE_BODY — used wherever the NodeRepository would verify it. */
const NODE_CONTENT_HASH = contentHash(NODE_BODY);

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'glm test',
  GIT_AUTHOR_EMAIL: 'test@glm.local',
  GIT_COMMITTER_NAME: 'glm test',
  GIT_COMMITTER_EMAIL: 'test@glm.local',
};

// ---------------------------------------------------------------------------
// DB helper
// ---------------------------------------------------------------------------

function openDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db, MIGRATIONS_DIR);
  db.prepare(`INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)`).run(
    WS_ID, 'test', 'Test', NOW,
  );
  db.prepare(
    `INSERT INTO users (id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('user-1', 'alice@example.com', 'Alice', 'editor', NOW);
  db.prepare(
    `INSERT INTO nodes
       (id, workspace_id, glm_id, stratum, title, description, body_json, content_hash,
        revision_major, revision_iteration, revision_status, override_kind,
        authored_by, authored_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    NODE_ID, WS_ID, NODE_GLM_ID, 'component', 'Auth Component', '',
    JSON.stringify(NODE_BODY), NODE_CONTENT_HASH,
    'A', 0, 'in_work', 'net_new', 'user-1', NOW, NOW,
  );
  db.prepare(
    `INSERT INTO variants (id, workspace_id, label, channel, pin_policy_default) VALUES (?, ?, ?, ?, ?)`,
  ).run(VARIANT_ID, WS_ID, 'stable', 'stable', 'pin-on-release');
  // Enroll the node in the variant's rollout table.
  db.prepare(
    `INSERT INTO variant_rollout (variant_id, node_id, state) VALUES (?, ?, ?)`,
  ).run(VARIANT_ID, NODE_ID, 'Released');
  return db;
}

function openRepos(db: Database) {
  return {
    variants: new VariantRepository(db),
    rollout: new RolloutRepository(db),
    nodes: new NodeRepository(db),
  };
}

// ---------------------------------------------------------------------------
// AC-50 / AC-51 / AC-52 — createRelease basics
// ---------------------------------------------------------------------------

describe('createRelease', () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());

  test('AC-50: tags HEAD and returns the commit SHA', async () => {
    repo = makeTempRepo({ initialBranch: 'next' });
    const db = openDb();
    const repos = openRepos(db);

    const result = await createRelease(repos, {
      workspaceId: WS_ID,
      git: repo.git,
      name: 'A.0',
      message: 'First release',
    });

    expect(result.tag).toBe('A.0');
    expect(result.commit).toBe(repo.git.revParse('HEAD'));
    expect(repo.git.listTags('[A-Z].*')).toContain('A.0');
  });

  test('AC-51: rejects invalid tag names', async () => {
    repo = makeTempRepo();
    const db = openDb();
    const repos = openRepos(db);

    for (const name of ['a.0', 'A', '1.0', 'A-0', 'AA.1', '']) {
      await expect(
        createRelease(repos, { workspaceId: WS_ID, git: repo.git, name, message: 'x' }),
      ).rejects.toThrow('invalid release tag name');
    }
  });

  test('AC-52: first release creates rollout_records for all variant nodes', async () => {
    repo = makeTempRepo({ initialBranch: 'next' });
    const db = openDb();
    const repos = openRepos(db);

    const result = await createRelease(repos, {
      workspaceId: WS_ID,
      git: repo.git,
      name: 'A.0',
      message: 'First release',
    });

    expect(result.rolloutRecords).toHaveLength(1);
    const rec = result.rolloutRecords[0];
    expect(rec.releaseTag).toBe('A.0');
    expect(rec.nodeId).toBe(NODE_ID);
    expect(rec.variantId).toBe(VARIANT_ID);
    expect(rec.status).toBe('pending');
    expect(rec.fromRev).toBeNull();
    expect(rec.toRev).toBe(NODE_CONTENT_HASH);

    expect(repos.rollout.listByTag('A.0')).toHaveLength(1);
  });

  test('AC-53: second release skips unchanged nodes', async () => {
    repo = makeTempRepo({ initialBranch: 'next' });
    const db = openDb();
    const repos = openRepos(db);

    // Commit and tag A.0 so there is a prior tag.
    const nodeDir = join(repo.path, 'nodes', 'component');
    mkdirSync(nodeDir, { recursive: true });
    const safeId = NODE_GLM_ID.replace(/:/g, '__');
    writeFileSync(
      join(nodeDir, `${safeId}.yaml`),
      `id: ${NODE_GLM_ID}\ncontent_hash: ${NODE_CONTENT_HASH}\n`,
    );
    repo.git.add([`nodes/component/${safeId}.yaml`]);
    repo.git.commit({ message: 'ECN: add auth\nAffected: glm:component.auth' });
    repo.git.tag('A.0', { message: 'First release' });

    // New commit that does NOT touch the node file.
    writeFileSync(join(repo.path, 'readme.md'), 'updated\n');
    repo.git.add(['readme.md']);
    repo.git.commit({ message: 'ECN: update readme\nAffected: none' });

    const result = await createRelease(repos, {
      workspaceId: WS_ID,
      git: repo.git,
      name: 'A.1',
      message: 'Second release',
    });

    expect(result.rolloutRecords).toHaveLength(0);
  });

  test('AC-53b: second release enrolls changed nodes with from_rev', async () => {
    repo = makeTempRepo({ initialBranch: 'next' });
    const db = openDb();
    const repos = openRepos(db);

    const nodeDir = join(repo.path, 'nodes', 'component');
    mkdirSync(nodeDir, { recursive: true });
    const safeId = NODE_GLM_ID.replace(/:/g, '__');
    const filePath = join(nodeDir, `${safeId}.yaml`);

    const v1Hash = NODE_CONTENT_HASH;
    writeFileSync(filePath, `id: ${NODE_GLM_ID}\ncontent_hash: ${v1Hash}\n`);
    repo.git.add([`nodes/component/${safeId}.yaml`]);
    repo.git.commit({ message: 'ECN: add auth\nAffected: glm:component.auth' });
    repo.git.tag('A.0', { message: 'First release' });

    // Update the YAML to simulate a spec change.
    const v2Hash = contentHash({ boundary: 'auth-service', runtime: 'deno' });
    writeFileSync(filePath, `id: ${NODE_GLM_ID}\ncontent_hash: ${v2Hash}\n`);
    repo.git.add([`nodes/component/${safeId}.yaml`]);
    repo.git.commit({ message: 'ECN: update runtime\nAffected: glm:component.auth' });

    // Also update DB so findById returns the new content hash.
    db.prepare(`UPDATE nodes SET content_hash = ? WHERE id = ?`).run(v2Hash, NODE_ID);
    db.prepare(`UPDATE nodes SET body_json = ? WHERE id = ?`).run(
      JSON.stringify({ boundary: 'auth-service', runtime: 'deno' }), NODE_ID,
    );

    const result = await createRelease(repos, {
      workspaceId: WS_ID,
      git: repo.git,
      name: 'A.1',
      message: 'Second release',
    });

    expect(result.rolloutRecords).toHaveLength(1);
    expect(result.rolloutRecords[0].fromRev).toBe(v1Hash);
    expect(result.rolloutRecords[0].releaseTag).toBe('A.1');
  });
});

// ---------------------------------------------------------------------------
// AC-54 — rollout record advance
// ---------------------------------------------------------------------------

describe('RolloutRepository.advance', () => {
  test('AC-54: pending → advanced', () => {
    const db = openDb();
    const repos = openRepos(db);

    const record = repos.rollout.insert({
      id: randomUUID(),
      variantId: VARIANT_ID,
      nodeId: NODE_ID,
      toRev: NODE_CONTENT_HASH,
      releaseTag: 'A.0',
    });
    expect(record.status).toBe('pending');

    const updated = repos.rollout.advance(record.id, 'advanced');
    expect(updated?.status).toBe('advanced');
  });

  test('pending → blocked', () => {
    const db = openDb();
    const repos = openRepos(db);

    const record = repos.rollout.insert({
      id: randomUUID(),
      variantId: VARIANT_ID,
      nodeId: NODE_ID,
      releaseTag: 'A.0',
    });
    expect(repos.rollout.advance(record.id, 'blocked')?.status).toBe('blocked');
  });

  test('advance returns null for unknown id', () => {
    const db = openDb();
    const repos = openRepos(db);
    expect(repos.rollout.advance('no-such-id', 'advanced')).toBeNull();
  });

  test('duplicate insert (same variant+node+tag) is silently ignored', () => {
    const db = openDb();
    const repos = openRepos(db);
    repos.rollout.insert({ id: randomUUID(), variantId: VARIANT_ID, nodeId: NODE_ID, releaseTag: 'A.0' });
    // Second insert with same triple — INSERT OR IGNORE keeps exactly one row.
    repos.rollout.insert({ id: randomUUID(), variantId: VARIANT_ID, nodeId: NODE_ID, releaseTag: 'A.0' });
    expect(repos.rollout.listByTag('A.0')).toHaveLength(1);
  });

  test('advance is a no-op on a terminal record', () => {
    const db = openDb();
    const repos = openRepos(db);
    const record = repos.rollout.insert({
      id: randomUUID(),
      variantId: VARIANT_ID,
      nodeId: NODE_ID,
      releaseTag: 'A.0',
    });
    repos.rollout.advance(record.id, 'blocked');
    // Second advance on a non-pending record returns null (WHERE status='pending' guard).
    expect(repos.rollout.advance(record.id, 'advanced')).toBeNull();
    // The record is still 'blocked', not overwritten.
    expect(repos.rollout.findById(record.id)?.status).toBe('blocked');
  });

  test('listByTag returns all records for a release', () => {
    const db = openDb();
    const repos = openRepos(db);
    // Add a second node with a distinct body so (workspace_id, content_hash) stays unique.
    const node2Body = { boundary: 'db-service', runtime: 'postgres' };
    const node2Hash = contentHash(node2Body);
    db.prepare(
      `INSERT INTO nodes
         (id, workspace_id, glm_id, stratum, title, description, body_json, content_hash,
          revision_major, revision_iteration, revision_status, override_kind,
          authored_by, authored_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'node-comp-2', WS_ID, 'glm:component.db', 'component', 'DB Component', '',
      JSON.stringify(node2Body), node2Hash,
      'A', 0, 'in_work', 'net_new', 'user-1', NOW, NOW,
    );

    repos.rollout.insert({ id: randomUUID(), variantId: VARIANT_ID, nodeId: NODE_ID, releaseTag: 'A.0' });
    repos.rollout.insert({ id: randomUUID(), variantId: VARIANT_ID, nodeId: 'node-comp-2', releaseTag: 'A.0' });
    repos.rollout.insert({ id: randomUUID(), variantId: VARIANT_ID, nodeId: NODE_ID, releaseTag: 'A.1' });

    expect(repos.rollout.listByTag('A.0')).toHaveLength(2);
    expect(repos.rollout.listByTag('A.1')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC-55 / AC-56 / AC-57 / AC-58 / AC-59 / AC-60 — pre-receive hook rules
//
// Setup: origin is a non-bare repo with the hook installed and
// receive.denyCurrentBranch=ignore so we can push to its current branch.
// Clone is created with `git clone` so both repos share history (meaning hook
// only sees genuinely new commits, not the seed commit).
// ---------------------------------------------------------------------------

interface HookSetup {
  origin: TempRepo;
  clone: TempRepo;
}

function setupWithHook(): HookSetup {
  const origin = makeTempRepo({ initialBranch: 'next' });
  // Allow push to checked-out branch; the hook is the gatekeeper.
  origin.git.config('receive.denyCurrentBranch', 'ignore');
  installHooks({ repoPath: origin.path, hooks: ['pre-receive'] });

  // Clone so both repos share the seed commit (hook only sees *new* commits).
  const clonePath = mkdtempSync(join(tmpdir(), 'glm-clone-'));
  const cloneGit = GitClient.clone(origin.path, clonePath, { env: GIT_ENV });
  cloneGit.config('user.name', 'glm test');
  cloneGit.config('user.email', 'test@glm.local');
  cloneGit.config('commit.gpgsign', 'false');
  cloneGit.config('tag.gpgsign', 'false');
  const clone: TempRepo = {
    path: clonePath,
    git: cloneGit,
    cleanup() { try { rmSync(clonePath, { recursive: true, force: true }); } catch {} },
  };

  return { origin, clone };
}

describe('pre-receive hook', () => {
  let setup: HookSetup;
  afterEach(() => { setup?.origin.cleanup(); setup?.clone.cleanup(); });

  test('AC-55: direct push to main is rejected', () => {
    setup = setupWithHook();
    setup.clone.git.branch('main', { checkout: true });
    setup.clone.git.commit({ message: 'ECN: seed main\nAffected: none', allowEmpty: true });

    expect(() => setup.clone.git.push('origin', 'main')).toThrow();
  });

  test('AC-56: force-push is rejected', () => {
    setup = setupWithHook();
    // Make origin's next ahead so clone's push would be non-fast-forward.
    setup.origin.git.commit({ message: 'ECN: origin advance\nAffected: none', allowEmpty: true });
    setup.clone.git.commit({ message: 'ECN: clone advance\nAffected: none', allowEmpty: true });

    expect(() => setup.clone.git.run(['push', 'origin', 'next', '--force'])).toThrow();
  });

  test('AC-57: push to variants/* without sekkei.lock is rejected', () => {
    setup = setupWithHook();
    setup.clone.git.branch('variants/test', { checkout: true });
    setup.clone.git.commit({ message: 'ECN: seed variant\nAffected: none', allowEmpty: true });

    expect(() => setup.clone.git.push('origin', 'variants/test')).toThrow();
  });

  test('AC-58: normal push to next with ECN commit succeeds', () => {
    setup = setupWithHook();
    setup.clone.git.commit({ message: 'ECN: add feature\nAffected: none', allowEmpty: true });

    expect(() => setup.clone.git.push('origin', 'next')).not.toThrow();
  });

  test('AC-59: push to next without ECN prefix is rejected', () => {
    setup = setupWithHook();
    setup.clone.git.commit({ message: 'chore: fix typo', allowEmpty: true });

    expect(() => setup.clone.git.push('origin', 'next')).toThrow();
  });

  test('AC-60: annotated release tag push is accepted', () => {
    setup = setupWithHook();
    setup.clone.git.tag('A.0', { message: 'First release' });
    // Push the tag ref directly.
    expect(() => setup.clone.git.push('origin', 'refs/tags/A.0')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// hook content sanity
// ---------------------------------------------------------------------------

describe('hook content', () => {
  test('contains all Step 8 rule markers', () => {
    expect(PRE_RECEIVE_HOOK).toContain('main is release-only');
    expect(PRE_RECEIVE_HOOK).toContain('force-push not permitted');
    expect(PRE_RECEIVE_HOOK).toContain('must be an annotated tag');
    expect(PRE_RECEIVE_HOOK).toContain('GLM_REQUIRE_SIGNED_TAGS');
    expect(PRE_RECEIVE_HOOK).toContain("ECN:|Merge ");
    expect(PRE_RECEIVE_HOOK).toContain('sekkei.lock');
    expect(PRE_RECEIVE_HOOK).toContain('Affected:');
  });
});
