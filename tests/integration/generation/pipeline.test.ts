import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { HmacSigner, verifyDsseEnvelope } from '../../../src/generation/attestation.ts';
import { InMemoryGenerationCache } from '../../../src/generation/cache.ts';
import { FakeLlmClient } from '../../../src/generation/llm-client.ts';
import { runPipeline } from '../../../src/generation/pipeline.ts';
import { AttestationRepository } from '../../../src/repository/attestation-repository.ts';
import { ProvenanceRepository } from '../../../src/repository/provenance-repository.ts';
import { runMigrations } from '../../../src/repository/db.ts';
import { MIGRATIONS_DIR } from '../helpers.ts';

const GENERATOR = { llm: 'claude-sonnet-4-6', promptVersion: 'sha256:a', toolChain: 'sha256:b' };
const SEKKEI = { rootId: 'glm:system.web', revision: 'A.0', lockDigest: 'sha256:lock' as const };

describe('generation pipeline (AC-32, AC-33)', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db, MIGRATIONS_DIR);
    db.prepare('INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)').run(
      'ws-1',
      'demo',
      'Demo',
      '2026-05-11T00:00:00.000Z',
    );
  });
  afterEach(() => db.close());

  function makeDeps(llm: FakeLlmClient = new FakeLlmClient([{ text: 'generated artifact body' }])) {
    return {
      llm,
      cache: new InMemoryGenerationCache(),
      signer: new HmacSigner({ keyId: 'test', keyHex: 'a'.repeat(64) }),
      repos: {
        provenance: new ProvenanceRepository(db),
        attestations: new AttestationRepository(db),
      },
    };
  }

  test('AC-32: cache miss produces exactly one provenance row and one signed Statement', async () => {
    const deps = makeDeps();
    const result = await runPipeline(deps, {
      workspaceId: 'ws-1',
      subjectFile: 'src/routes/checkout.ts',
      llmInput: { prompt: 'emit code' },
      sekkei: SEKKEI,
      binding: {},
      closureHash: 'sha256:closure',
      generatorIdentity: GENERATOR,
    });
    expect(result.cache).toBe('miss');
    expect(result.provenance.tokensIn).toBeGreaterThan(0);
    expect(result.provenance.tokensOut).toBeGreaterThan(0);
    expect(result.provenance.signed).toBe(true);

    const provs = deps.repos.provenance.listByWorkspace('ws-1');
    expect(provs.length).toBe(1);
    const att = deps.repos.attestations.findByEvent(provs[0]?.id ?? '');
    expect(att).not.toBeNull();
    expect(verifyDsseEnvelope(JSON.parse(att!.dsseJson), deps.signer).passed).toBe(true);
  });

  test('AC-33: cache hit produces a provenance row with zero token counters and no LLM call', async () => {
    const llm = new FakeLlmClient([{ text: 'generated artifact body' }]);
    const deps = makeDeps(llm);
    const input = {
      workspaceId: 'ws-1',
      subjectFile: 'src/routes/checkout.ts',
      llmInput: { prompt: 'emit code' },
      sekkei: SEKKEI,
      binding: { x: 1 },
      closureHash: 'sha256:closure',
      generatorIdentity: GENERATOR,
    };
    const first = await runPipeline(deps, input);
    expect(first.cache).toBe('miss');
    expect(llm.calls.length).toBe(1);

    const second = await runPipeline(deps, input);
    expect(second.cache).toBe('hit');
    expect(second.provenance.tokensIn).toBe(0);
    expect(second.provenance.tokensOut).toBe(0);
    expect(second.provenance.cache).toBe('hit');
    expect(llm.calls.length).toBe(1); // LLM not invoked on the hit

    expect(deps.repos.provenance.listByWorkspace('ws-1').length).toBe(2);
  });

  test('binding key order does not change cache hit/miss', async () => {
    const llm = new FakeLlmClient([{ text: 'A' }, { text: 'B' }]);
    const deps = makeDeps(llm);
    const a = await runPipeline(deps, {
      workspaceId: 'ws-1',
      subjectFile: 'x',
      llmInput: { prompt: 'p' },
      sekkei: SEKKEI,
      binding: { a: 1, b: 2 },
      closureHash: 'sha256:c',
      generatorIdentity: GENERATOR,
    });
    const b = await runPipeline(deps, {
      workspaceId: 'ws-1',
      subjectFile: 'x',
      llmInput: { prompt: 'p' },
      sekkei: SEKKEI,
      binding: { b: 2, a: 1 },
      closureHash: 'sha256:c',
      generatorIdentity: GENERATOR,
    });
    expect(a.cache).toBe('miss');
    expect(b.cache).toBe('hit');
  });

  test('the Statement subject digest matches the sha256 of the artifact bytes', async () => {
    const deps = makeDeps();
    const r = await runPipeline(deps, {
      workspaceId: 'ws-1',
      subjectFile: 'a.ts',
      llmInput: { prompt: 'p' },
      sekkei: SEKKEI,
      binding: {},
      closureHash: 'sha256:c',
      generatorIdentity: GENERATOR,
    });
    expect(r.statement.subject[0]?.digest.sha256).toBe(r.artifactDigest.replace('sha256:', ''));
  });
});
