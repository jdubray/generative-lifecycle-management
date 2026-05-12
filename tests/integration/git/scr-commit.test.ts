import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateSecret } from '../../../src/auth/session.ts';
import { runMigrations } from '../../../src/repository/db.ts';
import { GitClient } from '../../../src/git/git-client.ts';
import { createApp } from '../../../src/server/app.ts';
import { MIGRATIONS_DIR } from '../helpers.ts';
import { makeTempRepo, type TempRepo } from './helpers.ts';

/**
 * Git Step 3 acceptance tests:
 *   - Feature branch created and merged back to the integration branch.
 *   - Feature branch deleted locally after merge.
 *   - scrs.git_commit and scrs.git_branch persisted in the DB.
 *   - Integration branch HEAD advances to the ECN commit.
 */
describe('Git Step 3 — SCR implement write path', () => {
  let repo: TempRepo;
  let db: Database;
  afterEach(() => {
    repo?.cleanup();
    db?.close();
  });

  function seedDb(database: Database) {
    const now = '2026-05-12T00:00:00.000Z';
    database.prepare(
      'INSERT INTO users (id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('user-1', 'alice@example.com', 'Alice', 'editor', now);
    database.prepare(
      'INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)',
    ).run('ws-1', 'demo', 'Demo', now);
  }

  async function runScrCycle(
    application: ReturnType<typeof createApp>['app'],
    scrId: string,
  ): Promise<Response> {
    const headers = { 'x-test-user-id': 'user-1', 'content-type': 'application/json' };

    await application.request('/api/v1/workspaces/ws-1/nodes', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        glmId: 'glm:capability.payment',
        stratum: 'capability',
        title: 'Payment',
        body: { user_value: 'allow payment' },
        revisionMajor: 'A',
        revisionIteration: 0,
        revisionStatus: 'in_work',
        overrideKind: 'net_new',
      }),
    });

    await application.request('/api/v1/workspaces/ws-1/scrs', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: scrId,
        title: 'Add payment method',
        scrClass: 'I',
        problem: 'Users cannot pay with new providers',
        targetNodes: ['glm:capability.payment'],
        diffYaml: [],
      }),
    });

    for (const event of ['submit', 'startReview', 'approve'] as const) {
      await application.request(`/api/v1/workspaces/ws-1/scrs/${scrId}/status`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ event }),
      });
    }

    return application.request(`/api/v1/workspaces/ws-1/scrs/${scrId}/status`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ event: 'implement' }),
    });
  }

  test('commit lands on the integration branch (next), not on a dangling feature branch', async () => {
    repo = makeTempRepo({ initialBranch: 'next' });
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db, MIGRATIONS_DIR);
    seedDb(db);

    const { app } = createApp({
      db,
      sessionSecret: generateSecret(),
      cookieSecure: false,
      allowTestAuthHeader: true,
      getSekkeiGit: () =>
        new GitClient({
          repoPath: repo.path,
          env: {
            GIT_AUTHOR_NAME: 'Alice',
            GIT_AUTHOR_EMAIL: 'alice@example.com',
            GIT_COMMITTER_NAME: 'Alice',
            GIT_COMMITTER_EMAIL: 'alice@example.com',
          },
        }),
    });

    const res = await runScrCycle(app, 'SCR-3001');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commit?: { hash: string } };
    const commitHash = body.commit?.hash;
    expect(commitHash).toMatch(/^[0-9a-f]{40}$/);

    // The integration branch must include the commit.
    const nextHead = repo.git.revParse('next');
    expect(nextHead).toBe(commitHash);

    // The feature branch must no longer exist.
    const branches = repo.git.run(['branch', '--list', 'feature/SCR-3001']);
    expect(branches.trim()).toBe('');
  });

  test('scrs.git_commit and scrs.git_branch are persisted in the DB', async () => {
    repo = makeTempRepo({ initialBranch: 'next' });
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db, MIGRATIONS_DIR);
    seedDb(db);

    const { app } = createApp({
      db,
      sessionSecret: generateSecret(),
      cookieSecure: false,
      allowTestAuthHeader: true,
      getSekkeiGit: () =>
        new GitClient({
          repoPath: repo.path,
          env: {
            GIT_AUTHOR_NAME: 'Alice',
            GIT_AUTHOR_EMAIL: 'alice@example.com',
            GIT_COMMITTER_NAME: 'Alice',
            GIT_COMMITTER_EMAIL: 'alice@example.com',
          },
        }),
    });

    const res = await runScrCycle(app, 'SCR-3002');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commit?: { hash: string } };
    const commitHash = body.commit?.hash;

    const row = db
      .prepare('SELECT git_commit, git_branch FROM scrs WHERE id = ?')
      .get('SCR-3002') as { git_commit: string | null; git_branch: string | null } | undefined;

    expect(row?.git_commit).toBe(commitHash);
    expect(row?.git_branch).toBe('feature/SCR-3002');
  });

  test('SCR GET reflects gitCommit and gitBranch after implement', async () => {
    repo = makeTempRepo({ initialBranch: 'next' });
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db, MIGRATIONS_DIR);
    seedDb(db);

    const { app } = createApp({
      db,
      sessionSecret: generateSecret(),
      cookieSecure: false,
      allowTestAuthHeader: true,
      getSekkeiGit: () =>
        new GitClient({
          repoPath: repo.path,
          env: {
            GIT_AUTHOR_NAME: 'Alice',
            GIT_AUTHOR_EMAIL: 'alice@example.com',
            GIT_COMMITTER_NAME: 'Alice',
            GIT_COMMITTER_EMAIL: 'alice@example.com',
          },
        }),
    });

    const headers = { 'x-test-user-id': 'user-1', 'content-type': 'application/json' };
    await runScrCycle(app, 'SCR-3003');

    const getRes = await app.request('/api/v1/workspaces/ws-1/scrs/SCR-3003', { headers });
    expect(getRes.status).toBe(200);
    const { scr } = (await getRes.json()) as { scr: { gitCommit: string | null; gitBranch: string | null } };
    expect(scr.gitCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(scr.gitBranch).toBe('feature/SCR-3003');
  });

  test('DB-only workspace (no git) implement still succeeds without a commit', async () => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db, MIGRATIONS_DIR);
    seedDb(db);

    // getSekkeiGit returns null → no commit path
    const { app } = createApp({
      db,
      sessionSecret: generateSecret(),
      cookieSecure: false,
      allowTestAuthHeader: true,
      getSekkeiGit: () => null,
    });

    const res = await runScrCycle(app, 'SCR-3004');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scr: { status: string }; commit?: unknown };
    expect(body.scr.status).toBe('Implemented');
    expect(body.commit).toBeUndefined();
  });
});
