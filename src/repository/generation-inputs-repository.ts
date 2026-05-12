import type { Database, Statement } from 'bun:sqlite';
import type { Sha256Hash } from '../types.ts';

export interface GenerationInputRecord {
  attestationId: string;
  specNodeId: string;
  specContentHash: Sha256Hash;
  /** Full JSON-serialised spec body at generation time. */
  specBodyJson: string;
  promptHash: Sha256Hash;
  promptText: string | null;
  /** JSON array of SpecDiff objects; null on the first generation. */
  specDiffJson: string | null;
  /** Human-readable YAML unified diff; null on the first generation. */
  specDiffYaml: string | null;
  artifactPath: string;
  artifactHash: Sha256Hash;
  /** HEAD SHA of glm-realization/ when this artifact was produced. */
  realizationCommit: string | null;
  producedAt: string;
}

export interface GenerationInputInsert {
  attestationId: string;
  specNodeId: string;
  specContentHash: Sha256Hash;
  specBodyJson: string;
  promptHash: Sha256Hash;
  promptText?: string | null;
  specDiffJson?: string | null;
  specDiffYaml?: string | null;
  artifactPath: string;
  artifactHash: Sha256Hash;
  realizationCommit?: string | null;
  producedAt?: string;
}

export class GenerationInputsRepository {
  private readonly stInsert: Statement;
  private readonly stFindByAttestation: Statement;
  private readonly stFindLatestBySpec: Statement;

  constructor(db: Database) {
    this.stInsert = db.prepare(
      `INSERT INTO generation_inputs
         (attestation_id, spec_node_id, spec_content_hash, spec_body_json,
          prompt_hash, prompt_text, spec_diff_json, spec_diff_yaml,
          artifact_path, artifact_hash, realization_commit, produced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stFindByAttestation = db.prepare(
      `SELECT ${COLS} FROM generation_inputs WHERE attestation_id = ?`,
    );
    this.stFindLatestBySpec = db.prepare(
      `SELECT ${COLS} FROM generation_inputs WHERE spec_node_id = ? ORDER BY produced_at DESC LIMIT 1`,
    );
  }

  insert(input: GenerationInputInsert): GenerationInputRecord {
    const producedAt = input.producedAt ?? new Date().toISOString();
    this.stInsert.run(
      input.attestationId,
      input.specNodeId,
      input.specContentHash,
      input.specBodyJson,
      input.promptHash,
      input.promptText ?? null,
      input.specDiffJson ?? null,
      input.specDiffYaml ?? null,
      input.artifactPath,
      input.artifactHash,
      input.realizationCommit ?? null,
      producedAt,
    );
    return {
      attestationId: input.attestationId,
      specNodeId: input.specNodeId,
      specContentHash: input.specContentHash,
      specBodyJson: input.specBodyJson,
      promptHash: input.promptHash,
      promptText: input.promptText ?? null,
      specDiffJson: input.specDiffJson ?? null,
      specDiffYaml: input.specDiffYaml ?? null,
      artifactPath: input.artifactPath,
      artifactHash: input.artifactHash,
      realizationCommit: input.realizationCommit ?? null,
      producedAt,
    };
  }

  findByAttestation(attestationId: string): GenerationInputRecord | null {
    const row = this.stFindByAttestation.get(attestationId) as GiRow | undefined;
    return row ? rowTo(row) : null;
  }

  /** The most recently produced generation input for a spec node; null if none exists. */
  findLatestBySpec(specNodeId: string): GenerationInputRecord | null {
    const row = this.stFindLatestBySpec.get(specNodeId) as GiRow | undefined;
    return row ? rowTo(row) : null;
  }
}

const COLS =
  'attestation_id, spec_node_id, spec_content_hash, spec_body_json, ' +
  'prompt_hash, prompt_text, spec_diff_json, spec_diff_yaml, ' +
  'artifact_path, artifact_hash, realization_commit, produced_at';

interface GiRow {
  attestation_id: string;
  spec_node_id: string;
  spec_content_hash: string;
  spec_body_json: string;
  prompt_hash: string;
  prompt_text: string | null;
  spec_diff_json: string | null;
  spec_diff_yaml: string | null;
  artifact_path: string;
  artifact_hash: string;
  realization_commit: string | null;
  produced_at: string;
}

function rowTo(r: GiRow): GenerationInputRecord {
  return {
    attestationId: r.attestation_id,
    specNodeId: r.spec_node_id,
    specContentHash: r.spec_content_hash,
    specBodyJson: r.spec_body_json,
    promptHash: r.prompt_hash,
    promptText: r.prompt_text,
    specDiffJson: r.spec_diff_json,
    specDiffYaml: r.spec_diff_yaml,
    artifactPath: r.artifact_path,
    artifactHash: r.artifact_hash,
    realizationCommit: r.realization_commit,
    producedAt: r.produced_at,
  };
}
