import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { HmacSigner } from '../../../src/generation/attestation.ts';
import { InMemoryGenerationCache } from '../../../src/generation/cache.ts';
import { FakeLlmClient } from '../../../src/generation/llm-client.ts';
import { runPipeline } from '../../../src/generation/pipeline.ts';
import { GitNotesClient } from '../../../src/git/git-notes.ts';
import { AttestationRepository } from '../../../src/repository/attestation-repository.ts';
import { ProvenanceRepository } from '../../../src/repository/provenance-repository.ts';
import { runMigrations } from '../../../src/repository/db.ts';
import { MIGRATIONS_DIR } from '../helpers.ts';
import { makeTempRepo, type TempRepo } from './helpers.ts';

/**
 * Git Step 5 acceptance tests:
 *   - GitNotesClient can attach and read back a git note.
 *   - runPipeline with git deps attaches the DSSE envelope as a note.
 *   - generation_attestations.git_note_ref and realization_commit are persisted.
 *   - runPipeline without git deps is unaffected (backward compat).
 */
describe('Git Step 5 — Generation Notes', () => {
  let repo: TempRepo | undefined;
  let db: Database | undefined;

  afterEach(() => {
    repo?.cleanup();
    db?.close();
    repo = undefined;
    db = undefined;
  });

  const NOW = '2026-05-12T00:00:00.000Z';
  const GENERATOR = { llm: 'claude-sonnet-4-6', promptVersion: 'sha256:a', toolChain: 'sha256:b' };
  const SEKKEI = { rootId: 'glm:system.demo', revision: 'A.0', lockDigest: 'sha256:lock' as const };

  function openDb(): Database {
    const d = new Database(':memory:');
    d.exec('PRAGMA foreign_keys = ON;');
    runMigrations(d, MIGRATIONS_DIR);
    d.prepare('INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)').run(
      'ws-1',
      'demo',
      'Demo',
      NOW,
    );
    return d;
  }

  function makeDeps(
    database: Database,
    notesClient?: GitNotesClient,
    sekkeiCommit?: string,
  ) {
    return {
      llm: new FakeLlmClient([{ text: 'artifact content' }]),
      cache: new InMemoryGenerationCache(),
      signer: new HmacSigner({ keyId: 'test', keyHex: 'a'.repeat(64) }),
      repos: {
        provenance: new ProvenanceRepository(database),
        attestations: new AttestationRepository(database),
      },
      ...(notesClient && sekkeiCommit
        ? { git: { notes: notesClient, sekkeiCommit } }
        : {}),
    };
  }

  const PIPELINE_INPUT = {
    workspaceId: 'ws-1',
    subjectFile: 'src/main.ts',
    llmInput: { prompt: 'emit code' },
    sekkei: SEKKEI,
    binding: {},
    closureHash: 'sha256:closure' as const,
    generatorIdentity: GENERATOR,
  };

  // ---------------------------------------------------------------------------
  // GitNotesClient unit-level tests (real git, no DB)
  // ---------------------------------------------------------------------------

  test('GitNotesClient.add + show round-trips a JSON payload', () => {
    repo = makeTempRepo({ initialBranch: 'next' });
    const commit = repo.git.revParse('HEAD');
    const notes = new GitNotesClient(repo.git);

    notes.add(commit, '{"hello":"world"}');
    const back = notes.show(commit);
    expect(back).not.toBeNull();
    expect(JSON.parse(back!)).toEqual({ hello: 'world' });
  });

  test('GitNotesClient.show returns null for a commit with no note', () => {
    repo = makeTempRepo({ initialBranch: 'next' });
    const commit = repo.git.revParse('HEAD');
    const notes = new GitNotesClient(repo.git);
    expect(notes.show(commit)).toBeNull();
  });

  test('GitNotesClient.add is idempotent — second add replaces the first', () => {
    repo = makeTempRepo({ initialBranch: 'next' });
    const commit = repo.git.revParse('HEAD');
    const notes = new GitNotesClient(repo.git);

    notes.add(commit, '"first"');
    notes.add(commit, '"second"');
    expect(notes.show(commit)?.trim()).toBe('"second"');
  });

  // ---------------------------------------------------------------------------
  // Pipeline integration tests
  // ---------------------------------------------------------------------------

  test('runPipeline attaches the DSSE envelope as a git note on the sekkei commit', async () => {
    repo = makeTempRepo({ initialBranch: 'next' });
    db = openDb();

    const sekkeiCommit = repo.git.revParse('HEAD');
    const notes = new GitNotesClient(repo.git);
    const deps = makeDeps(db, notes, sekkeiCommit);

    const result = await runPipeline(deps, PIPELINE_INPUT);

    const noteText = notes.show(sekkeiCommit);
    expect(noteText).not.toBeNull();
    const envelope = JSON.parse(noteText!);
    expect(envelope.payloadType).toBe('application/vnd.in-toto+json');
    expect(envelope.signatures.length).toBeGreaterThan(0);
    expect(JSON.stringify(envelope)).toBe(JSON.stringify(result.envelope));
  });

  test('generation_attestations row has git_note_ref and realization_commit persisted', async () => {
    repo = makeTempRepo({ initialBranch: 'next' });
    db = openDb();

    const sekkeiCommit = repo.git.revParse('HEAD');
    const notes = new GitNotesClient(repo.git);
    const deps = makeDeps(db, notes, sekkeiCommit);

    await runPipeline(deps, PIPELINE_INPUT);

    const row = db
      .prepare(
        'SELECT realization_commit, git_note_ref FROM generation_attestations WHERE workspace_id = ?',
      )
      .get('ws-1') as { realization_commit: string | null; git_note_ref: string | null } | undefined;

    expect(row?.realization_commit).toBe(sekkeiCommit);
    expect(row?.git_note_ref).toBe('refs/notes/generation');
  });

  test('runPipeline without git deps completes and leaves git columns null', async () => {
    db = openDb();
    const deps = makeDeps(db); // no git

    const result = await runPipeline(deps, PIPELINE_INPUT);
    expect(result.cache).toBe('miss');
    expect(result.envelope.payloadType).toBe('application/vnd.in-toto+json');

    const row = db
      .prepare(
        'SELECT realization_commit, git_note_ref FROM generation_attestations WHERE workspace_id = ?',
      )
      .get('ws-1') as { realization_commit: string | null; git_note_ref: string | null } | undefined;

    expect(row?.realization_commit).toBeNull();
    expect(row?.git_note_ref).toBeNull();
  });
});
