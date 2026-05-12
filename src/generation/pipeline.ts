import { createHash, randomUUID } from 'node:crypto';
import { contentHash } from '../domain/content-hash.ts';
import type { GitClient } from '../git/git-client.ts';
import type { GitNotesClient } from '../git/git-notes.ts';
import type { AttestationRepository } from '../repository/attestation-repository.ts';
import type { GenerationInputsRepository } from '../repository/generation-inputs-repository.ts';
import type { ProvenanceRepository } from '../repository/provenance-repository.ts';
import type { GeneratorIdentity, ProvenanceEvent, Sha256Hash } from '../types.ts';
import {
  type AttestationSigner,
  type DsseEnvelope,
  type InTotoStatement,
  buildDsseEnvelope,
  buildStatement,
  rekorEntryId,
} from './attestation.ts';
import { type CacheKeyInput, generationHash, type GenerationCache } from './cache.ts';
import type { LlmClient, LlmGenerateInput } from './llm-client.ts';
import { stringify as stringifyYaml } from 'yaml';
import { buildDiffAwarePrompt, computeStructuredDiff, computeYamlDiff } from './spec-diff.ts';

/**
 * Generation pipeline (plan §5 Phase 5).
 *
 *   1. Compute the cache key from (closure_hash, binding_hash, generator).
 *   2. Probe the cache. On hit, skip the LLM call entirely (AC-33).
 *   3. On miss, invoke the LLM (AC-32) and persist the output to the cache.
 *   4. Compute the artifact digest (sha256 of the output bytes).
 *   5. Build the in-toto Statement + DSSE envelope.
 *   6. Persist one `provenance_events` row + one `generation_attestations` row.
 *
 * The pipeline is the only place that writes attestation rows. Routes call
 * `runPipeline(...)` directly or via the queue; either way the inputs and
 * outputs are the same shape.
 */

export interface PipelineInput {
  workspaceId: string;
  /** Path of the artifact being produced (relative to glm-realization/). */
  subjectFile: string;
  /** What the user wants generated. */
  llmInput: LlmGenerateInput;
  /** Sekkei context (passes through to the Statement). */
  sekkei: { rootId: string; revision: string; lockDigest: Sha256Hash };
  /** Parameter binding (used for binding_hash + Statement). */
  binding: Record<string, unknown>;
  /** Closure hash for the cache key. */
  closureHash: Sha256Hash;
  /** Identity of the generator that will run. */
  generatorIdentity: GeneratorIdentity;
  /**
   * Git Step 7: ID of the spec node driving this generation. When set alongside
   * `specBody` and `deps.repos.generationInputs`, the pipeline performs
   * diff-aware regeneration using the prior generation_inputs row.
   */
  specNodeId?: string;
  /** sha256 hash of the spec node body at generation time. */
  specContentHash?: Sha256Hash;
  /** Full spec body object at generation time (JSON-serialisable). */
  specBody?: Record<string, unknown>;
}

export interface PipelineResult {
  cache: 'hit' | 'miss';
  artifactBytes: Buffer;
  artifactDigest: Sha256Hash;
  statement: InTotoStatement;
  envelope: DsseEnvelope;
  rekorEntryId: string;
  provenance: ProvenanceEvent;
  attestationId: string;
}

export interface PipelineDeps {
  llm: LlmClient;
  cache: GenerationCache;
  signer: AttestationSigner;
  repos: {
    provenance: ProvenanceRepository;
    attestations: AttestationRepository;
    /** When set, generation inputs are persisted and diff-aware re-gen is enabled. */
    generationInputs?: GenerationInputsRepository;
  };
  clock?: () => Date;
  /** When provided, attaches the DSSE envelope as a git note on `sekkeiCommit`. */
  git?: {
    notes: GitNotesClient;
    /** The ECN commit SHA in `glm-sekkei/` that this generation is derived from. */
    sekkeiCommit: string;
    /** The commit SHA in `glm-realization/`; defaults to `sekkeiCommit` when absent. */
    realizationCommit?: string;
    /**
     * Git Step 7: client for the `glm-realization/` repo. When set alongside
     * `repos.generationInputs`, the pipeline can retrieve the prior artifact
     * and compute realization drift for the diff-aware prompt.
     */
    realizationGit?: GitClient;
  };
}

/** Run the pipeline for a single artifact. Returns hit/miss + the rows that were written. */
export async function runPipeline(deps: PipelineDeps, input: PipelineInput): Promise<PipelineResult> {
  const clock = deps.clock ?? (() => new Date());

  // ---------------------------------------------------------------------------
  // Git Step 7: diff-aware regeneration
  // Look up the previous generation inputs for this spec node so we can build
  // a targeted prompt and extend the cache key with the prior artifact hash.
  // ---------------------------------------------------------------------------
  let specDiffJson: string | null = null;
  let specDiffYaml: string | null = null;
  let effectiveLlmInput = input.llmInput;
  let prevArtifactHash: Sha256Hash | undefined;

  const canDiff =
    input.specNodeId != null &&
    input.specBody != null &&
    deps.repos.generationInputs != null;

  if (canDiff) {
    const prior = deps.repos.generationInputs!.findLatestBySpec(input.specNodeId!);
    if (prior != null) {
      const prevBody = JSON.parse(prior.specBodyJson) as Record<string, unknown>;
      const diffs = computeStructuredDiff(prevBody, input.specBody!);

      if (diffs.length > 0) {
        specDiffJson = JSON.stringify(diffs);
        specDiffYaml = computeYamlDiff(prevBody, input.specBody!);

        // Retrieve the prior artifact text for the diff-aware prompt when the
        // realization git client is available.
        let previousArtifact = '';
        let realizationDrift = '';
        if (deps.git?.realizationGit && prior.realizationCommit) {
          try {
            previousArtifact = deps.git.realizationGit.run([
              'show',
              `${prior.realizationCommit}:${input.subjectFile}`,
            ]);
          } catch {
            // File may not have existed at that commit; leave empty.
          }
          try {
            realizationDrift = deps.git.realizationGit.diff(
              prior.realizationCommit,
              'HEAD',
              input.subjectFile,
            );
          } catch {
            // No diff available; leave empty.
          }
        }

        effectiveLlmInput = {
          ...input.llmInput,
          prompt: buildDiffAwarePrompt({
            previousArtifact,
            // Render the stored JSON body as human-readable YAML so the LLM
            // receives a spec that looks like the source YAML files, not minified JSON.
            previousSpecYaml: stringifyYaml(prevBody, { lineWidth: 120 }),
            specDiffYaml,
            realizationDrift,
            originalPrompt: input.llmInput.prompt,
          }),
        };

        // Extend the cache key so a diff-aware call and a blank-slate call
        // for the same spec/binding can never collide (§4.4.3).
        prevArtifactHash = prior.artifactHash;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Core pipeline: cache probe → LLM → artifact digest
  // ---------------------------------------------------------------------------
  const cacheKeyInput: CacheKeyInput = {
    closureHash: input.closureHash,
    bindingHash: hashCanonical(input.binding),
    generatorIdentity: input.generatorIdentity,
    prevArtifactHash,
  };
  const cacheKey = generationHash(cacheKeyInput);

  let artifactBytes: Buffer;
  let tokensIn = 0;
  let tokensOut = 0;
  let durationMs = 0;
  let cache: 'hit' | 'miss';

  const probe = deps.cache.get(cacheKey, input.subjectFile);
  if (probe.hit && probe.bytes) {
    cache = 'hit';
    artifactBytes = probe.bytes;
    // AC-33: cache hits must not produce LLM token usage.
  } else {
    cache = 'miss';
    const llmRes = await deps.llm.generate(effectiveLlmInput);
    artifactBytes = Buffer.from(llmRes.text, 'utf8');
    tokensIn = llmRes.tokensIn;
    tokensOut = llmRes.tokensOut;
    durationMs = llmRes.durationMs;
    deps.cache.put(cacheKey, input.subjectFile, artifactBytes);
  }

  const artifactDigest = sha256Prefixed(artifactBytes);

  const statement = buildStatement({
    subjectFile: input.subjectFile,
    subjectDigest: artifactDigest,
    sekkeiRootId: input.sekkei.rootId,
    sekkeiRevision: input.sekkei.revision,
    sekkeiLockDigest: input.sekkei.lockDigest,
    bindingParameterHash: cacheKeyInput.bindingHash,
    generator: input.generatorIdentity,
    tokensIn,
    tokensOut,
    durationMs,
    cache,
  });
  const envelope = buildDsseEnvelope(statement, deps.signer);
  const entryId = rekorEntryId(envelope);

  const provenance = deps.repos.provenance.insert({
    id: randomUUID(),
    workspaceId: input.workspaceId,
    occurredAt: clock().toISOString(),
    subjectFile: input.subjectFile,
    subjectDigest: artifactDigest,
    sekkeiRoot: input.sekkei.rootId,
    sekkeiRev: input.sekkei.revision,
    sekkeiLock: input.sekkei.lockDigest,
    bindingHash: cacheKeyInput.bindingHash,
    generatorLlm: input.generatorIdentity.llm,
    generatorPromptVersion: input.generatorIdentity.promptVersion ?? '',
    tokensIn,
    tokensOut,
    durationMs,
    cache,
    signed: true,
  });

  const attestationId = randomUUID();
  deps.repos.attestations.insert({
    id: attestationId,
    provenanceEventId: provenance.id,
    workspaceId: input.workspaceId,
    statementJson: JSON.stringify(statement),
    dsseJson: JSON.stringify(envelope),
    keyId: deps.signer.keyId,
    rekorEntryId: entryId,
  });

  if (deps.git) {
    deps.git.notes.add(deps.git.sekkeiCommit, JSON.stringify(envelope));
    deps.repos.attestations.setGitInfo(attestationId, {
      realizationCommit: deps.git.realizationCommit ?? deps.git.sekkeiCommit,
      gitNoteRef: deps.git.notes.ref,
    });
  }

  // ---------------------------------------------------------------------------
  // Git Step 7: persist generation inputs for the next diff-aware re-gen.
  // ---------------------------------------------------------------------------
  if (input.specNodeId != null && input.specBody != null && deps.repos.generationInputs != null) {
    const promptHash = sha256Prefixed(Buffer.from(effectiveLlmInput.prompt, 'utf8'));
    deps.repos.generationInputs.insert({
      attestationId,
      specNodeId: input.specNodeId,
      specContentHash: input.specContentHash ?? contentHash(input.specBody),
      specBodyJson: JSON.stringify(input.specBody),
      promptHash,
      promptText: effectiveLlmInput.prompt,
      specDiffJson,
      specDiffYaml,
      artifactPath: input.subjectFile,
      artifactHash: artifactDigest,
      realizationCommit: deps.git?.realizationCommit ?? deps.git?.sekkeiCommit ?? null,
    });
  }

  return {
    cache,
    artifactBytes,
    artifactDigest,
    statement,
    envelope,
    rekorEntryId: entryId,
    provenance,
    attestationId,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sha256Prefixed(bytes: Buffer): Sha256Hash {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function hashCanonical(value: Record<string, unknown>): Sha256Hash {
  // Reuse the domain's canonical JSON so identical bindings produce
  // identical hashes regardless of key order.
  return contentHash(value);
}
