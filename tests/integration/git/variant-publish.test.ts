import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateSecret } from '../../../src/auth/session.ts';
import { runMigrations } from '../../../src/repository/db.ts';
import { GitClient } from '../../../src/git/git-client.ts';
import { parseSekkeiLock } from '../../../src/git/sekkei-lock.ts';
import { createApp } from '../../../src/server/app.ts';
import { MIGRATIONS_DIR } from '../helpers.ts';
import { makeTempRepo, type TempRepo } from './helpers.ts';

/**
 * Git Step 4 acceptance tests:
 *   - sekkei.lock written to a `variants/<label>` branch in the git repo.
 *   - Lock content matches the resolution closure.
 *   - variants.git_commit and variants.closure_hash persisted in the DB.
 *   - Second publish updates the existing branch (no -b, just checkout).
 */
describe('Git Step 4 — Variant publish', () => {
  let repo: TempRepo;
  let db: Database;
  afterEach(() => {
    repo?.cleanup();
    db?.close();
  });

  const NOW = '2026-05-12T00:00:00.000Z';

  function seedDb(database: Database) {
    database.prepare(
      'INSERT INTO users (id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('user-1', 'alice@example.com', 'Alice', 'editor', NOW);
    database.prepare(
      'INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)',
    ).run('ws-1', 'demo', 'Demo', NOW);
  }

  function makeApp(database: Database, repoPath: string) {
    return createApp({
      db: database,
      sessionSecret: generateSecret(),
      cookieSecure: false,
      allowTestAuthHeader: true,
      getSekkeiGit: () =>
        new GitClient({
          repoPath,
          env: {
            GIT_AUTHOR_NAME: 'Alice',
            GIT_AUTHOR_EMAIL: 'alice@example.com',
            GIT_COMMITTER_NAME: 'Alice',
            GIT_COMMITTER_EMAIL: 'alice@example.com',
          },
        }),
    });
  }

  const headers = { 'x-test-user-id': 'user-1', 'content-type': 'application/json' };

  async function createNodeAndVariant(application: ReturnType<typeof makeApp>['app']) {
    // Create a capability node (root of the resolution)
    const nodeRes = await application.request('/api/v1/workspaces/ws-1/nodes', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        glmId: 'glm:system.demo',
        stratum: 'system',
        title: 'Demo System',
        body: { mission: 'demo', system_role: 'master' },
        revisionMajor: 'A',
        revisionIteration: 0,
        revisionStatus: 'in_work',
        overrideKind: 'net_new',
        systemRole: 'master',
      }),
    });
    expect(nodeRes.status).toBe(201);

    // Create a variant
    const variantRes = await application.request('/api/v1/workspaces/ws-1/variants', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: 'var-1',
        label: 'acme-stable',
        channel: 'stable',
        pinPolicyDefault: 'pin-on-release',
      }),
    });
    expect(variantRes.status).toBe(201);
  }

  const GENERATOR: Record<string, string> = {
    llm: 'claude-sonnet-4-6',
    prompt_version: 'sha256:abc123',
    tool_chain: 'sha256:def456',
  };

  test('publish creates sekkei.lock on the variant branch', async () => {
    repo = makeTempRepo({ initialBranch: 'next' });
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db, MIGRATIONS_DIR);
    seedDb(db);

    const { app } = makeApp(db, repo.path);
    await createNodeAndVariant(app);

    const res = await app.request('/api/v1/workspaces/ws-1/variants/var-1/publish', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        rootGlmId: 'glm:system.demo',
        binding: {},
        generatorIdentity: GENERATOR,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { publish: { gitCommit: string; closureHash: string } };
    expect(body.publish.gitCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(body.publish.closureHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The variant branch must exist and contain sekkei.lock
    const lockText = repo.git.showFile('variants/acme-stable', 'sekkei.lock');
    expect(lockText).toContain('root_id: glm:system.demo');
    const lock = parseSekkeiLock(lockText);
    expect(lock.nodes.some((n) => n.id === 'glm:system.demo')).toBe(true);
  });

  test('variants.git_commit and variants.closure_hash are persisted in the DB', async () => {
    repo = makeTempRepo({ initialBranch: 'next' });
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db, MIGRATIONS_DIR);
    seedDb(db);

    const { app } = makeApp(db, repo.path);
    await createNodeAndVariant(app);

    const res = await app.request('/api/v1/workspaces/ws-1/variants/var-1/publish', {
      method: 'POST',
      headers,
      body: JSON.stringify({ rootGlmId: 'glm:system.demo', generatorIdentity: GENERATOR }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { publish: { gitCommit: string; closureHash: string } };

    const row = db
      .prepare('SELECT git_commit, closure_hash, git_ref FROM variants WHERE id = ?')
      .get('var-1') as { git_commit: string | null; closure_hash: string | null; git_ref: string | null } | undefined;

    expect(row?.git_commit).toBe(body.publish.gitCommit);
    expect(row?.closure_hash).toBe(body.publish.closureHash);
    expect(row?.git_ref).toBe('refs/heads/variants/acme-stable');
  });

  test('second publish updates the existing variant branch without creating a new one', async () => {
    repo = makeTempRepo({ initialBranch: 'next' });
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db, MIGRATIONS_DIR);
    seedDb(db);

    const { app } = makeApp(db, repo.path);
    await createNodeAndVariant(app);

    const publishBody = JSON.stringify({
      rootGlmId: 'glm:system.demo',
      generatorIdentity: GENERATOR,
    });

    const first = await app.request('/api/v1/workspaces/ws-1/variants/var-1/publish', {
      method: 'POST',
      headers,
      body: publishBody,
    });
    expect(first.status).toBe(201);

    const second = await app.request('/api/v1/workspaces/ws-1/variants/var-1/publish', {
      method: 'POST',
      headers,
      body: publishBody,
    });
    expect(second.status).toBe(201);

    // Only one branch called variants/acme-stable should exist.
    const branches = repo.git.run(['branch', '--list', 'variants/acme-stable']);
    expect(branches.trim().split('\n').length).toBe(1);
  });

  test('publish without git remote returns 409', async () => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db, MIGRATIONS_DIR);
    seedDb(db);

    const { app } = createApp({
      db,
      sessionSecret: generateSecret(),
      cookieSecure: false,
      allowTestAuthHeader: true,
      getSekkeiGit: () => null,
    });

    await app.request('/api/v1/workspaces/ws-1/nodes', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        glmId: 'glm:system.demo', stratum: 'system', title: 'Demo', systemRole: 'master',
        body: {}, revisionMajor: 'A', revisionIteration: 0, revisionStatus: 'in_work',
        overrideKind: 'net_new',
      }),
    });
    await app.request('/api/v1/workspaces/ws-1/variants', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'var-1', label: 'acme', channel: 'stable', pinPolicyDefault: 'pin-on-release' }),
    });

    const res = await app.request('/api/v1/workspaces/ws-1/variants/var-1/publish', {
      method: 'POST',
      headers,
      body: JSON.stringify({ rootGlmId: 'glm:system.demo', generatorIdentity: GENERATOR }),
    });
    expect(res.status).toBe(409);
  });
});
