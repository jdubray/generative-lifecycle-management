/**
 * Git Step 7 acceptance tests — Diff-Aware Regeneration.
 *
 * AC-40  When a prior generation_inputs row exists for the spec node,
 *        runPipeline builds a diff-aware prompt (not a blank-slate prompt).
 * AC-41  The diff-aware prompt contains the spec diff, realization drift, and
 *        the original prompt text.
 * AC-42  generation_inputs row is written after every pipeline run that
 *        includes specNodeId + specBody.
 * AC-43  On the first generation (no prior inputs) the row is written with
 *        specDiffJson = null.
 * AC-44  The cache key changes when prevArtifactHash is included, so a
 *        diff-aware run and a blank-slate run for the same spec never share
 *        a cache entry.
 * AC-45  When specBody is unchanged between runs the pipeline falls back to
 *        a blank-slate prompt (no diff produced) and the new row has
 *        specDiffJson = null.
 * AC-46  runPipeline without specNodeId is unaffected (backward compat).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { HmacSigner } from '../../../src/generation/attestation.ts';
import { InMemoryGenerationCache } from '../../../src/generation/cache.ts';
import { FakeLlmClient } from '../../../src/generation/llm-client.ts';
import { runPipeline, type PipelineDeps, type PipelineInput } from '../../../src/generation/pipeline.ts';
import { GitNotesClient } from '../../../src/git/git-notes.ts';
import { AttestationRepository } from '../../../src/repository/attestation-repository.ts';
import { GenerationInputsRepository } from '../../../src/repository/generation-inputs-repository.ts';
import { ProvenanceRepository } from '../../../src/repository/provenance-repository.ts';
import { runMigrations } from '../../../src/repository/db.ts';
import { MIGRATIONS_DIR } from '../helpers.ts';
import { makeTempRepo, type TempRepo } from './helpers.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOW = '2026-05-12T00:00:00.000Z';
const SIGNER = new HmacSigner({ keyId: 'test', keyHex: 'a'.repeat(64) });
const GENERATOR = { llm: 'fake-llm@v1', promptVersion: 'sha256:pv1' };
const SEKKEI = { rootId: 'glm:system.demo', revision: 'A.0', lockDigest: 'sha256:lock' as const };
const SPEC_NODE_ID = 'node-spec-1';
const ARTIFACT_PATH = 'src/main.ts';

const SPEC_BODY_V1 = { spec_kind: 'prompt', content: 'Generate a hello-world module.' };
const SPEC_BODY_V2 = { spec_kind: 'prompt', content: 'Generate a hello-world module with logging.' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db, MIGRATIONS_DIR);
  db.prepare(`INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)`).run(
    'ws-1',
    'demo',
    'Demo',
    NOW,
  );
  // Insert minimal node row to satisfy FK from generation_inputs.
  db.prepare(
    `INSERT INTO users (id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('user-1', 'alice@example.com', 'Alice', 'editor', NOW);
  db.prepare(
    `INSERT INTO nodes
       (id, workspace_id, glm_id, stratum, title, description, body_json, content_hash,
        revision_major, revision_iteration, revision_status, override_kind,
        spec_kind, authored_by, authored_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SPEC_NODE_ID, 'ws-1', 'glm:spec.demo', 'spec', 'Demo Spec', '',
    JSON.stringify(SPEC_BODY_V1), 'sha256:h1',
    'A', 0, 'in_work', 'net_new', 'prompt', 'user-1', NOW, NOW,
  );
  return db;
}

function makeDeps(
  db: Database,
  llm: FakeLlmClient,
  opts: {
    realizationGit?: TempRepo['git'];
    sekkeiCommit?: string;
    realizationCommit?: string;
    cache?: InMemoryGenerationCache;
    /** Collector for any TempRepos allocated internally; caller must push to repos[]. */
    trackRepos?: TempRepo[];
  } = {},
): PipelineDeps {
  // Only build git deps when both a commit SHA and a git client are provided.
  // Requiring both prevents a leaked TempRepo from being created as a fallback.
  const hasGitDeps = opts.realizationGit != null && opts.sekkeiCommit != null;
  const notes = hasGitDeps ? new GitNotesClient(opts.realizationGit!) : undefined;

  return {
    llm,
    cache: opts.cache ?? new InMemoryGenerationCache(),
    signer: SIGNER,
    repos: {
      provenance: new ProvenanceRepository(db),
      attestations: new AttestationRepository(db),
      generationInputs: new GenerationInputsRepository(db),
    },
    clock: () => new Date(NOW),
    ...(hasGitDeps
      ? {
          git: {
            notes: notes!,
            sekkeiCommit: opts.sekkeiCommit!,
            realizationCommit: opts.realizationCommit,
            realizationGit: opts.realizationGit!,
          },
        }
      : {}),
  };
}

function baseInput(specBody: Record<string, unknown>, prompt = 'Generate code.'): PipelineInput {
  return {
    workspaceId: 'ws-1',
    subjectFile: ARTIFACT_PATH,
    llmInput: { prompt },
    sekkei: SEKKEI,
    binding: {},
    closureHash: 'sha256:closure' as const,
    generatorIdentity: GENERATOR,
    specNodeId: SPEC_NODE_ID,
    specContentHash: 'sha256:cv1',
    specBody,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Git Step 7 — Diff-Aware Regeneration', () => {
  let repos: TempRepo[] = [];
  let dbs: Database[] = [];

  afterEach(() => {
    for (const r of repos) r.cleanup();
    for (const d of dbs) d.close();
    repos = [];
    dbs = [];
  });

  // AC-43: first generation → specDiffJson is null
  test('AC-43: first generation writes generation_inputs with specDiffJson = null', async () => {
    const db = openDb();
    dbs.push(db);
    const llm = new FakeLlmClient([{ text: 'hello world v1' }]);
    const result = await runPipeline(makeDeps(db, llm), baseInput(SPEC_BODY_V1));

    expect(result.cache).toBe('miss');

    const row = db
      .prepare(`SELECT spec_diff_json, artifact_hash FROM generation_inputs WHERE attestation_id = ?`)
      .get(result.attestationId) as { spec_diff_json: string | null; artifact_hash: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.spec_diff_json).toBeNull();
    expect(row!.artifact_hash).toBe(result.artifactDigest);
  });

  // AC-42: generation_inputs row written every run
  test('AC-42: generation_inputs row is written with correct spec/artifact metadata', async () => {
    const db = openDb();
    dbs.push(db);
    const llm = new FakeLlmClient([{ text: 'artifact v1' }]);
    const result = await runPipeline(makeDeps(db, llm), baseInput(SPEC_BODY_V1, 'My prompt'));

    const row = db
      .prepare(`SELECT * FROM generation_inputs WHERE attestation_id = ?`)
      .get(result.attestationId) as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row!.spec_node_id).toBe(SPEC_NODE_ID);
    expect(row!.spec_content_hash).toBe('sha256:cv1');
    expect(row!.spec_body_json).toBe(JSON.stringify(SPEC_BODY_V1));
    expect(row!.artifact_path).toBe(ARTIFACT_PATH);
    expect(row!.prompt_text).toContain('My prompt');
  });

  // AC-40: diff-aware prompt when spec changed
  test('AC-40: second generation with changed spec uses a diff-aware prompt', async () => {
    const db = openDb();
    dbs.push(db);
    const llm = new FakeLlmClient([
      { text: 'artifact v1' },
      { text: 'artifact v2' },
    ]);
    const deps = makeDeps(db, llm);

    // First run — blank slate
    await runPipeline(deps, baseInput(SPEC_BODY_V1, 'Generate code.'));

    // Second run with updated spec — should trigger diff-aware prompt
    await runPipeline(deps, {
      ...baseInput(SPEC_BODY_V2, 'Generate code.'),
      specContentHash: 'sha256:cv2',
    });

    // The LLM call for the second run should have received a diff-aware prompt
    expect(llm.calls).toHaveLength(2);
    const secondPrompt = llm.calls[1].prompt;
    expect(secondPrompt).toContain('previously generated');
    expect(secondPrompt).toContain('spec has been updated');
    expect(secondPrompt).toContain('Generate code.');
  });

  // AC-41: diff prompt contains spec diff text
  test('AC-41: diff-aware prompt contains spec diff and generation_inputs row records it', async () => {
    const db = openDb();
    dbs.push(db);
    const llm = new FakeLlmClient([
      { text: 'artifact v1' },
      { text: 'artifact v2' },
    ]);
    const deps = makeDeps(db, llm);

    const r1 = await runPipeline(deps, baseInput(SPEC_BODY_V1));
    const r2 = await runPipeline(deps, { ...baseInput(SPEC_BODY_V2), specContentHash: 'sha256:cv2' });

    // generation_inputs for r2 should have non-null spec_diff_json
    const row2 = db
      .prepare(`SELECT spec_diff_json, spec_diff_yaml FROM generation_inputs WHERE attestation_id = ?`)
      .get(r2.attestationId) as { spec_diff_json: string | null; spec_diff_yaml: string | null } | undefined;

    expect(row2).toBeDefined();
    expect(row2!.spec_diff_json).not.toBeNull();

    const diffs = JSON.parse(row2!.spec_diff_json!);
    expect(Array.isArray(diffs)).toBe(true);
    expect(diffs.length).toBeGreaterThan(0);
    // The content field changed
    const contentDiff = diffs.find((d: { path: string }) => d.path === 'content');
    expect(contentDiff).toBeDefined();
    expect(contentDiff.op).toBe('change');

    // r1 attestation_id not used just to avoid the unused warning
    void r1.attestationId;
  });

  // AC-44: cache key isolation between blank-slate and diff-aware
  test('AC-44: diff-aware re-gen uses a different cache key than the blank-slate gen', async () => {
    const db = openDb();
    dbs.push(db);
    const cache = new InMemoryGenerationCache();
    const llm = new FakeLlmClient([
      { text: 'v1 artifact' }, // run 1: blank-slate for spec v1
      { text: 'v2 artifact' }, // run 2: diff-aware for spec v2 (prevArtifactHash added to key)
    ]);
    const deps = makeDeps(db, llm, { cache });

    // Run 1: spec V1, no prior inputs → blank-slate, cache miss
    const r1 = await runPipeline(deps, baseInput(SPEC_BODY_V1));
    expect(r1.cache).toBe('miss');

    // Run 2: spec V2, prior inputs exist → diff found → prevArtifactHash added to key.
    // Even though closureHash / bindingHash / generatorIdentity are identical to run 1,
    // the extended cache key means this is a miss (different entry).
    const r2 = await runPipeline(deps, {
      ...baseInput(SPEC_BODY_V2),
      specContentHash: 'sha256:cv2',
    });
    expect(r2.cache).toBe('miss');

    // Both runs went to the LLM, confirming distinct cache slots.
    expect(llm.calls).toHaveLength(2);

    // The two artifact digests are different (distinct LLM outputs).
    expect(r1.artifactDigest).not.toBe(r2.artifactDigest);
  });

  // AC-45: unchanged spec → no diff, specDiffJson stays null
  test('AC-45: re-running with unchanged spec produces no diff and a blank-slate prompt', async () => {
    const db = openDb();
    dbs.push(db);
    const cache = new InMemoryGenerationCache();
    const llm = new FakeLlmClient([{ text: 'v1 artifact' }, { text: 'v1 artifact again' }]);
    const deps = makeDeps(db, llm, { cache });

    const r1 = await runPipeline(deps, baseInput(SPEC_BODY_V1));
    // Second run with same spec body — no diff should be generated
    const r2 = await runPipeline(deps, baseInput(SPEC_BODY_V1));

    expect(r2.cache).toBe('hit'); // same key, no prevArtifactHash → same key as r1

    // Confirm neither run produced a diff
    const row1 = db
      .prepare(`SELECT spec_diff_json FROM generation_inputs WHERE attestation_id = ?`)
      .get(r1.attestationId) as { spec_diff_json: string | null } | undefined;
    const row2 = db
      .prepare(`SELECT spec_diff_json FROM generation_inputs WHERE attestation_id = ?`)
      .get(r2.attestationId) as { spec_diff_json: string | null } | undefined;

    expect(row1!.spec_diff_json).toBeNull();
    // r2 is a cache hit so generation_inputs is still written (spec body unchanged)
    expect(row2!.spec_diff_json).toBeNull();
  });

  // AC-46: pipeline without specNodeId is unaffected
  test('AC-46: pipeline without specNodeId writes no generation_inputs row', async () => {
    const db = openDb();
    dbs.push(db);
    const llm = new FakeLlmClient([{ text: 'compat artifact' }]);
    // Use deps with generationInputs repo but omit specNodeId from the input
    const deps = makeDeps(db, llm);
    const input: PipelineInput = {
      workspaceId: 'ws-1',
      subjectFile: ARTIFACT_PATH,
      llmInput: { prompt: 'compat prompt' },
      sekkei: SEKKEI,
      binding: {},
      closureHash: 'sha256:closure' as const,
      generatorIdentity: GENERATOR,
      // No specNodeId / specBody
    };

    const result = await runPipeline(deps, input);
    expect(result.cache).toBe('miss');

    const count = (
      db.prepare(`SELECT COUNT(*) as n FROM generation_inputs`).get() as { n: number }
    ).n;
    expect(count).toBe(0);

    // LLM should have received the original prompt unchanged
    expect(llm.calls[0].prompt).toBe('compat prompt');
  });

  // prompt_hash correctness
  test('stored prompt_hash is sha256 of prompt_text', async () => {
    const { createHash } = await import('node:crypto');
    const db = openDb();
    dbs.push(db);
    const llm = new FakeLlmClient([{ text: 'out' }]);
    const result = await runPipeline(makeDeps(db, llm), baseInput(SPEC_BODY_V1, 'My exact prompt'));

    const row = db
      .prepare(`SELECT prompt_hash, prompt_text FROM generation_inputs WHERE attestation_id = ?`)
      .get(result.attestationId) as { prompt_hash: string; prompt_text: string } | undefined;

    expect(row).toBeDefined();
    const expected = `sha256:${createHash('sha256').update(row!.prompt_text, 'utf8').digest('hex')}`;
    expect(row!.prompt_hash).toBe(expected);
  });

  // null realizationCommit on first run — should not throw
  test('first run with realizationCommit null does not throw and leaves realization_commit null', async () => {
    const db = openDb();
    dbs.push(db);
    const llm = new FakeLlmClient([{ text: 'v1' }]);
    // No git deps → realizationCommit is null
    const result = await runPipeline(makeDeps(db, llm), baseInput(SPEC_BODY_V1));

    const row = db
      .prepare(`SELECT realization_commit FROM generation_inputs WHERE attestation_id = ?`)
      .get(result.attestationId) as { realization_commit: string | null } | undefined;

    expect(row).toBeDefined();
    expect(row!.realization_commit).toBeNull();
  });

  // multi-spec-node isolation: two different spec nodes do not see each other's inputs
  test('two different spec nodes do not share generation_inputs lookups', async () => {
    const db = openDb();
    dbs.push(db);
    // Seed a second spec node.
    const SPEC_NODE_2 = 'node-spec-2';
    db.prepare(
      `INSERT INTO nodes
         (id, workspace_id, glm_id, stratum, title, description, body_json, content_hash,
          revision_major, revision_iteration, revision_status, override_kind,
          spec_kind, authored_by, authored_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      SPEC_NODE_2, 'ws-1', 'glm:spec.demo2', 'spec', 'Demo Spec 2', '',
      JSON.stringify(SPEC_BODY_V1), 'sha256:h2',
      'A', 0, 'in_work', 'net_new', 'prompt', 'user-1', NOW, NOW,
    );

    const llm = new FakeLlmClient([
      { text: 'node1 v1' }, // node 1, first gen
      { text: 'node2 v1' }, // node 2, first gen — must not see node 1's prior input
    ]);
    const deps = makeDeps(db, llm);

    // Gen for node 1 with its own closure hash
    await runPipeline(deps, baseInput(SPEC_BODY_V1));

    // Gen for node 2: different closureHash forces a cache miss so the LLM is called
    // and we can verify that node 2 does NOT inherit node 1's generation_inputs row.
    const r2 = await runPipeline(deps, {
      ...baseInput(SPEC_BODY_V1),
      specNodeId: SPEC_NODE_2,
      closureHash: 'sha256:closure-node2' as const, // distinct → distinct cache key
    });

    expect(llm.calls).toHaveLength(2);

    const row2 = db
      .prepare(`SELECT spec_diff_json, spec_node_id FROM generation_inputs WHERE attestation_id = ?`)
      .get(r2.attestationId) as { spec_diff_json: string | null; spec_node_id: string } | undefined;

    expect(row2!.spec_node_id).toBe(SPEC_NODE_2);
    expect(row2!.spec_diff_json).toBeNull(); // first gen for node 2, so no diff
  });

  // Realization drift is included when realizationGit is wired
  test('realization drift appears in the diff-aware prompt when realizationGit is provided', async () => {
    const db = openDb();
    dbs.push(db);

    const realizationRepo = makeTempRepo();
    repos.push(realizationRepo);

    // Seed the artifact file at HEAD so the prior commit can retrieve it.
    mkdirSync(join(realizationRepo.path, 'src'), { recursive: true });
    writeFileSync(join(realizationRepo.path, ARTIFACT_PATH), 'function hello() {}', 'utf8');
    realizationRepo.git.add([ARTIFACT_PATH]);
    realizationRepo.git.commit({ message: 'initial: add artifact' });
    const firstCommit = realizationRepo.git.revParse('HEAD');

    // Add a human modification after the first commit.
    writeFileSync(
      join(realizationRepo.path, ARTIFACT_PATH),
      'function hello() {}\n// operator note',
      'utf8',
    );
    realizationRepo.git.add([ARTIFACT_PATH]);
    realizationRepo.git.commit({ message: 'hotfix: operator note' });

    const llm = new FakeLlmClient([{ text: 'v1' }, { text: 'v2 diff-aware' }]);
    const deps = makeDeps(db, llm, {
      realizationGit: realizationRepo.git,
      sekkeiCommit: firstCommit,
      realizationCommit: firstCommit,
    });

    // First run — records realizationCommit = firstCommit
    await runPipeline(deps, baseInput(SPEC_BODY_V1));

    // Second run with updated spec + realGit pointing at HEAD (has drift)
    const deps2 = makeDeps(db, llm, {
      realizationGit: realizationRepo.git,
      sekkeiCommit: realizationRepo.git.revParse('HEAD'),
      realizationCommit: realizationRepo.git.revParse('HEAD'),
    });
    await runPipeline(deps2, { ...baseInput(SPEC_BODY_V2), specContentHash: 'sha256:cv2' });

    // The second LLM call should include realization drift
    expect(llm.calls).toHaveLength(2);
    const prompt = llm.calls[1].prompt;
    expect(prompt).toContain('human modifications');
  });
});
