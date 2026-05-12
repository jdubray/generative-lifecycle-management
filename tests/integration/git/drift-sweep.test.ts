import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Database } from 'bun:sqlite';
import { openTestDb } from '../helpers.ts';
import { GitClient } from '../../../src/git/git-client.ts';
import { DriftRepository } from '../../../src/repository/drift-repository.ts';
import { runDriftSweep } from '../../../src/git/sekkei-git-service.ts';
import { makeTempRepo, type TempRepo } from './helpers.ts';

/**
 * Git Step 6 acceptance tests — drift sweep against a live realization clone.
 *
 * Each test builds a minimal realization repo (src/main.ts), seeds one drift
 * record whose desiredHash is pinned to the original file content, then mutates
 * the file and calls runDriftSweep. Assertions cover:
 *   - Drift status is promoted to Live-Drifted on hash mismatch.
 *   - observedHash reflects the new file content.
 *   - classification and autoResolvable are persisted correctly.
 *   - realization_commit and spec_commit are written on the record.
 *   - Auto-resolution re-syncs a previously drifted record when hash matches again.
 *   - A file absent from the realization repo is classified as human_improvement.
 */
describe('Git Step 6 — Drift sweep', () => {
  let realizationRepo: TempRepo;

  afterEach(() => {
    realizationRepo?.cleanup();
  });

  const SEKKEI_COMMIT = 'a'.repeat(40);
  const FILE = 'src/main.ts';
  const ORIGINAL = 'export const version = 1;\n';
  const MODIFIED = 'export const version = 2; // human change\n';

  function sha256(content: string): string {
    return `sha256:${createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')}`;
  }

  /** Seed the minimal workspace + node rows required by FK constraints. */
  function seedPrereqs(db: Database): void {
    const NOW = new Date().toISOString();
    db.prepare(
      'INSERT OR IGNORE INTO users (id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('user-1', 'alice@test.local', 'Alice', 'editor', NOW);
    db.prepare(
      'INSERT OR IGNORE INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)',
    ).run('ws-1', 'demo', 'Demo', NOW);
    db.prepare(
      `INSERT OR IGNORE INTO nodes
         (id, workspace_id, glm_id, stratum, title, body_json, content_hash,
          revision_major, revision_iteration, revision_status, override_kind, authored_by, authored_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'node-1', 'ws-1', 'glm:cap.main', 'capability', 'Main', '{}', 'sha256:0',
      'A', 0, 'in_work', 'net_new', 'user-1', NOW, NOW,
    );
  }

  function seedDriftRecord(
    _db: Database,
    drift: DriftRepository,
    opts: {
      id?: string;
      status?: string;
      desiredHash?: string | null;
      observedHash?: string | null;
      kind?: string;
    } = {},
  ) {
    return drift.upsert({
      id: opts.id ?? 'dr-1',
      workspaceId: 'ws-1',
      nodeId: 'node-1',
      file: FILE,
      status: (opts.status as any) ?? 'Synced',
      kind: (opts.kind as any) ?? 'live_state',
      policy: 'alert',
      desiredHash: opts.desiredHash !== undefined ? opts.desiredHash : sha256(ORIGINAL),
      observedHash: opts.observedHash !== undefined ? opts.observedHash : sha256(ORIGINAL),
    });
  }

  function writeAndCommit(repo: TempRepo, filePath: string, content: string, message: string) {
    const abs = join(repo.path, filePath);
    mkdirSync(join(repo.path, 'src'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    repo.git.add([filePath]);
    repo.git.commit({ message });
  }

  test('detects hash mismatch and classifies as human_improvement', async () => {
    const db = openTestDb();
    realizationRepo = makeTempRepo();
    seedPrereqs(db);

    writeAndCommit(realizationRepo, FILE, ORIGINAL, 'initial: add src/main.ts');

    const drift = new DriftRepository(db);
    seedDriftRecord(db, drift, { desiredHash: sha256(ORIGINAL), observedHash: sha256(ORIGINAL) });

    // Mutate the file — not whitespace-only, so classifies as human_improvement.
    writeAndCommit(realizationRepo, FILE, MODIFIED, 'change version');

    const result = await runDriftSweep(
      { drift },
      { workspaceId: 'ws-1', sekkeiCommit: SEKKEI_COMMIT, realizationGit: realizationRepo.git },
    );

    expect(result.detected).toBe(1);
    expect(result.autoResolved).toBe(0);

    const record = drift.findById('dr-1')!;
    expect(record.status).toBe('Live-Drifted');
    expect(record.observedHash).toBe(sha256(MODIFIED));
    expect(record.desiredHash).toBe(sha256(ORIGINAL));
    expect(record.classification).toBe('human_improvement');
    expect(record.autoResolvable).toBe(false);
    expect(record.realizationCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(record.specCommit).toBe(SEKKEI_COMMIT);

    db.close();
  });

  test('auto-resolves a previously drifted record when hash now matches desired', async () => {
    const db = openTestDb();
    realizationRepo = makeTempRepo();
    seedPrereqs(db);

    // Current realization content matches the desired hash.
    writeAndCommit(realizationRepo, FILE, ORIGINAL, 'initial');

    const drift = new DriftRepository(db);
    seedDriftRecord(db, drift, {
      status: 'Live-Drifted',
      desiredHash: sha256(ORIGINAL),
      observedHash: sha256(MODIFIED),
    });

    const result = await runDriftSweep(
      { drift },
      { workspaceId: 'ws-1', sekkeiCommit: SEKKEI_COMMIT, realizationGit: realizationRepo.git },
    );

    expect(result.detected).toBe(0);
    expect(result.autoResolved).toBe(1);

    const record = drift.findById('dr-1')!;
    expect(record.status).toBe('Synced');
    expect(record.observedHash).toBe(sha256(ORIGINAL));
    expect(record.realizationCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(record.specCommit).toBe(SEKKEI_COMMIT);

    db.close();
  });

  test('classifies whitespace-only diff as format / autoResolvable', async () => {
    const db = openTestDb();
    realizationRepo = makeTempRepo();
    seedPrereqs(db);

    writeAndCommit(realizationRepo, FILE, ORIGINAL, 'initial');

    const drift = new DriftRepository(db);
    seedDriftRecord(db, drift, { desiredHash: sha256(ORIGINAL), observedHash: sha256(ORIGINAL) });

    // Add only a trailing blank line — whitespace-only change.
    const WHITESPACE = ORIGINAL + '\n';
    writeAndCommit(realizationRepo, FILE, WHITESPACE, 'formatting');

    const result = await runDriftSweep(
      { drift },
      { workspaceId: 'ws-1', sekkeiCommit: SEKKEI_COMMIT, realizationGit: realizationRepo.git },
    );

    expect(result.detected).toBe(1);

    const record = drift.findById('dr-1')!;
    expect(record.classification).toBe('format');
    expect(record.autoResolvable).toBe(true);

    db.close();
  });

  test('classifies HOTFIX comment as hot_patch', async () => {
    const db = openTestDb();
    realizationRepo = makeTempRepo();
    seedPrereqs(db);

    writeAndCommit(realizationRepo, FILE, ORIGINAL, 'initial');

    const drift = new DriftRepository(db);
    seedDriftRecord(db, drift, { desiredHash: sha256(ORIGINAL), observedHash: sha256(ORIGINAL) });

    const HOTFIX = ORIGINAL + '// HOTFIX: emergency patch\n';
    writeAndCommit(realizationRepo, FILE, HOTFIX, 'hotfix patch');

    await runDriftSweep(
      { drift },
      { workspaceId: 'ws-1', sekkeiCommit: SEKKEI_COMMIT, realizationGit: realizationRepo.git },
    );

    const record = drift.findById('dr-1')!;
    expect(record.classification).toBe('hot_patch');
    expect(record.autoResolvable).toBe(false);

    db.close();
  });

  test('marks absent file as Live-Drifted with human_improvement', async () => {
    const db = openTestDb();
    realizationRepo = makeTempRepo();
    seedPrereqs(db);
    // Realization repo has no src/main.ts — seed commit only.

    const drift = new DriftRepository(db);
    seedDriftRecord(db, drift, { desiredHash: sha256(ORIGINAL), observedHash: sha256(ORIGINAL) });

    const result = await runDriftSweep(
      { drift },
      { workspaceId: 'ws-1', sekkeiCommit: SEKKEI_COMMIT, realizationGit: realizationRepo.git },
    );

    expect(result.detected).toBe(1);

    const record = drift.findById('dr-1')!;
    expect(record.status).toBe('Live-Drifted');
    expect(record.observedHash).toBeNull();
    expect(record.classification).toBe('human_improvement');
    expect(record.autoResolvable).toBe(false);

    db.close();
  });

  test('already-absent drifted file does not increment detected again', async () => {
    const db = openTestDb();
    realizationRepo = makeTempRepo();
    seedPrereqs(db);

    const drift = new DriftRepository(db);
    seedDriftRecord(db, drift, {
      status: 'Live-Drifted',
      desiredHash: sha256(ORIGINAL),
      observedHash: null,
    });

    const result = await runDriftSweep(
      { drift },
      { workspaceId: 'ws-1', sekkeiCommit: SEKKEI_COMMIT, realizationGit: realizationRepo.git },
    );

    // Already drifted + still absent → no change.
    expect(result.detected).toBe(0);
    expect(result.autoResolved).toBe(0);

    db.close();
  });

  test('records with empty file path are skipped', async () => {
    const db = openTestDb();
    realizationRepo = makeTempRepo();
    seedPrereqs(db);

    const drift = new DriftRepository(db);
    drift.upsert({
      id: 'dr-no-file',
      workspaceId: 'ws-1',
      nodeId: 'node-1',
      file: '',
      status: 'Synced',
      kind: 'live_state',
      policy: 'alert',
      desiredHash: sha256(ORIGINAL),
      observedHash: sha256(ORIGINAL),
    });

    const result = await runDriftSweep(
      { drift },
      { workspaceId: 'ws-1', sekkeiCommit: SEKKEI_COMMIT, realizationGit: realizationRepo.git },
    );

    expect(result.detected).toBe(0);
    expect(result.autoResolved).toBe(0);
    const record = drift.findById('dr-no-file')!;
    expect(record.realizationCommit).toBeNull();

    db.close();
  });

  test('initial commit in realization repo classifies as human_improvement, not format', async () => {
    // Reproduce the edge case where the realization repo's relevant commit has
    // no parent (HEAD~1 does not exist). In this scenario realizationDiff must
    // return null so classifyDiff is bypassed and we don't misclassify the
    // brand-new file as a whitespace-only (format / autoResolvable) change.
    const db = openTestDb();
    seedPrereqs(db);

    // Build a repo where the first — and only — commit adds src/main.ts.
    // We cannot use makeTempRepo because it seeds an initial empty commit.
    const rawPath = mkdtempSync(join(tmpdir(), 'glm-initial-'));
    const rawGit = new GitClient({
      repoPath: rawPath,
      env: {
        GIT_AUTHOR_NAME: 'glm test',
        GIT_AUTHOR_EMAIL: 'test@glm.local',
        GIT_COMMITTER_NAME: 'glm test',
        GIT_COMMITTER_EMAIL: 'test@glm.local',
      },
    });
    rawGit.init({ initialBranch: 'main' });
    rawGit.config('user.name', 'glm test');
    rawGit.config('user.email', 'test@glm.local');
    rawGit.config('commit.gpgsign', 'false');

    mkdirSync(join(rawPath, 'src'), { recursive: true });
    writeFileSync(join(rawPath, FILE), MODIFIED, 'utf8');
    rawGit.add([FILE]);
    rawGit.commit({ message: 'initial: add src/main.ts' }); // HEAD has no parent

    const drift = new DriftRepository(db);
    seedDriftRecord(db, drift, { desiredHash: sha256(ORIGINAL), observedHash: sha256(ORIGINAL) });

    const result = await runDriftSweep(
      { drift },
      { workspaceId: 'ws-1', sekkeiCommit: SEKKEI_COMMIT, realizationGit: rawGit },
    );

    expect(result.detected).toBe(1);
    const record = drift.findById('dr-1')!;
    expect(record.classification).toBe('human_improvement');
    expect(record.autoResolvable).toBe(false);

    try { rmSync(rawPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    db.close();
  });

  test('desiredHash null with file present classifies as human_improvement', async () => {
    const db = openTestDb();
    realizationRepo = makeTempRepo();
    seedPrereqs(db);

    writeAndCommit(realizationRepo, FILE, ORIGINAL, 'initial');

    const drift = new DriftRepository(db);
    // desiredHash null means we never captured a baseline — file should be flagged.
    seedDriftRecord(db, drift, { desiredHash: null, observedHash: null });

    const result = await runDriftSweep(
      { drift },
      { workspaceId: 'ws-1', sekkeiCommit: SEKKEI_COMMIT, realizationGit: realizationRepo.git },
    );

    expect(result.detected).toBe(1);
    const record = drift.findById('dr-1')!;
    expect(record.status).toBe('Live-Drifted');
    expect(record.observedHash).toBe(sha256(ORIGINAL));
    expect(record.classification).toBe('human_improvement');

    db.close();
  });

  test('multiple records with mixed drift states are all processed correctly', async () => {
    const db = openTestDb();
    realizationRepo = makeTempRepo();
    seedPrereqs(db);

    // Seed a second node so FK constraints are satisfied for the second record.
    const NOW = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO nodes
         (id, workspace_id, glm_id, stratum, title, body_json, content_hash,
          revision_major, revision_iteration, revision_status, override_kind, authored_by, authored_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('node-2', 'ws-1', 'glm:cap.other', 'capability', 'Other', '{}', 'sha256:1',
      'A', 0, 'in_work', 'net_new', 'user-1', NOW, NOW);

    const FILE2 = 'src/other.ts';
    const CONTENT2 = 'export const other = true;\n';

    writeAndCommit(realizationRepo, FILE, ORIGINAL, 'add main');
    writeAndCommit(realizationRepo, FILE2, CONTENT2, 'add other');
    // Now mutate main.ts to trigger drift on that record.
    writeAndCommit(realizationRepo, FILE, MODIFIED, 'change main');

    const drift = new DriftRepository(db);
    // Record 1: main.ts — Synced, will become Live-Drifted.
    seedDriftRecord(db, drift, { id: 'dr-main', desiredHash: sha256(ORIGINAL), observedHash: sha256(ORIGINAL) });
    // Record 2: other.ts — already Live-Drifted, hash now matches (will auto-resolve).
    drift.upsert({
      id: 'dr-other',
      workspaceId: 'ws-1',
      nodeId: 'node-2',
      file: FILE2,
      status: 'Live-Drifted',
      kind: 'live_state',
      policy: 'alert',
      desiredHash: sha256(CONTENT2),
      observedHash: sha256(MODIFIED),
    });

    const result = await runDriftSweep(
      { drift },
      { workspaceId: 'ws-1', sekkeiCommit: SEKKEI_COMMIT, realizationGit: realizationRepo.git },
    );

    expect(result.detected).toBe(1);
    expect(result.autoResolved).toBe(1);

    const main = drift.findById('dr-main')!;
    expect(main.status).toBe('Live-Drifted');
    expect(main.observedHash).toBe(sha256(MODIFIED));

    const other = drift.findById('dr-other')!;
    expect(other.status).toBe('Synced');
    expect(other.observedHash).toBe(sha256(CONTENT2));

    db.close();
  });
});
