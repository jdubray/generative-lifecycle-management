import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateSecret } from '../../../src/auth/session.ts';
import { runMigrations } from '../../../src/repository/db.ts';
import { GitClient } from '../../../src/git/git-client.ts';
import { parseEcnMessage } from '../../../src/git/ecn-commit.ts';
import { parseNode } from '../../../src/git/yaml-store.ts';
import { createApp } from '../../../src/server/app.ts';
import { MIGRATIONS_DIR } from '../helpers.ts';
import { makeTempRepo, type TempRepo } from './helpers.ts';

/**
 * Phase 4 done-when: a full SCR cycle (Draft → Submitted → Under Review →
 * Approved → Implemented) produces a single ECN commit; `git log --grep`
 * finds it; the commit tree contains the canonical node YAML.
 */
describe('SCR implement → ECN commit (Phase 4 done-when)', () => {
  let repo: TempRepo;
  let db: Database;
  afterEach(() => {
    repo?.cleanup();
    db?.close();
  });

  test('full SCR cycle through Implement produces an ECN commit on the active branch', async () => {
    repo = makeTempRepo({ initialBranch: 'next' });
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db, MIGRATIONS_DIR);
    const now = '2026-05-11T00:00:00.000Z';
    db.prepare('INSERT INTO users (id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'user-1',
      'alice@example.com',
      'Alice',
      'editor',
      now,
    );
    db.prepare('INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)').run(
      'ws-1',
      'demo',
      'Demo',
      now,
    );

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

    // 1. Create a target node via the REST API.
    const createNode = await app.request('/api/v1/workspaces/ws-1/nodes', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        glmId: 'glm:capability.checkout',
        stratum: 'capability',
        title: 'Checkout',
        body: { user_value: 'allow customers to pay' },
        revisionMajor: 'A',
        revisionIteration: 0,
        revisionStatus: 'in_work',
        overrideKind: 'net_new',
      }),
    });
    expect(createNode.status).toBe(201);

    // 2. Open the SCR.
    const createScr = await app.request('/api/v1/workspaces/ws-1/scrs', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: 'SCR-2090',
        title: 'Allow guest checkout',
        scrClass: 'I',
        problem: 'Customers abandon at signup',
        targetNodes: ['glm:capability.checkout'],
        diffYaml: [{ line: '+   guest: true', kind: 'add' }],
      }),
    });
    expect(createScr.status).toBe(201);

    // 3. Walk the FSM: submit → startReview → approve → implement.
    for (const event of ['submit', 'startReview', 'approve'] as const) {
      const res = await app.request('/api/v1/workspaces/ws-1/scrs/SCR-2090/status', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ event }),
      });
      expect(res.status).toBe(200);
    }
    const implementRes = await app.request('/api/v1/workspaces/ws-1/scrs/SCR-2090/status', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ event: 'implement' }),
    });
    expect(implementRes.status).toBe(200);
    const implementBody = (await implementRes.json()) as { commit?: { hash: string } };
    expect(implementBody.commit?.hash).toMatch(/^[0-9a-f]{40}$/);

    // 4. Confirm git log can find the commit via SCR id (spec done-when).
    const found = repo.git.logGrep('SCR-2090');
    expect(found.length).toBe(1);
    const message = repo.git.showMessage(found[0]?.hash ?? '');
    const parsed = parseEcnMessage(message);
    expect(parsed?.summary).toBe('Allow guest checkout');
    expect(parsed?.affected).toEqual(['glm:capability.checkout']);
    expect(parsed?.scrId).toBe('SCR-2090');
    expect(parsed?.signedOffBy).toBe('alice@example.com');

    // 5. Confirm the commit tree contains the canonical YAML.
    const files = repo.git.showFiles(found[0]?.hash ?? '');
    expect(files).toContain('nodes/capability/glm__capability.checkout.yaml');
    const yamlAtCommit = repo.git.showFile(
      found[0]?.hash ?? '',
      'nodes/capability/glm__capability.checkout.yaml',
    );
    const parsedYaml = parseNode(yamlAtCommit);
    expect(parsedYaml.id).toBe('glm:capability.checkout');
    expect(parsedYaml.title).toBe('Checkout');
  });
});
