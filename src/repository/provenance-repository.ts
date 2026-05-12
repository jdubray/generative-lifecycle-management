import type { Database, Statement } from 'bun:sqlite';
import type { ProvenanceCache, ProvenanceEvent, Sha256Hash } from '../types.ts';

export interface ProvenanceInsert {
  id: string;
  workspaceId: string;
  occurredAt?: string;
  subjectFile: string;
  subjectDigest: Sha256Hash;
  sekkeiRoot: string;
  sekkeiRev: string;
  sekkeiLock: string;
  bindingHash: Sha256Hash;
  generatorLlm: string;
  generatorPromptVersion: string;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
  cache: ProvenanceCache;
  signed: boolean;
  note?: string | null;
}

export class ProvenanceRepository {
  private readonly stInsert: Statement;
  private readonly stFind: Statement;
  private readonly stListByWorkspace: Statement;
  private readonly stListBySubject: Statement;

  constructor(db: Database) {
    this.stInsert = db.prepare(
      `INSERT INTO provenance_events (id, workspace_id, occurred_at, subject_file, subject_digest,
         sekkei_root, sekkei_rev, sekkei_lock, binding_hash, generator_llm, generator_prompt_version,
         tokens_in, tokens_out, duration_ms, cache, signed, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stFind = db.prepare(`SELECT ${COLS} FROM provenance_events WHERE id = ?`);
    this.stListByWorkspace = db.prepare(
      `SELECT ${COLS} FROM provenance_events WHERE workspace_id = ? ORDER BY occurred_at DESC LIMIT ?`,
    );
    this.stListBySubject = db.prepare(
      `SELECT ${COLS} FROM provenance_events WHERE workspace_id = ? AND subject_file = ? ORDER BY occurred_at DESC`,
    );
  }

  insert(input: ProvenanceInsert): ProvenanceEvent {
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const event: ProvenanceEvent = {
      id: input.id,
      workspaceId: input.workspaceId,
      occurredAt,
      subjectFile: input.subjectFile,
      subjectDigest: input.subjectDigest,
      sekkeiRoot: input.sekkeiRoot,
      sekkeiRev: input.sekkeiRev,
      sekkeiLock: input.sekkeiLock,
      bindingHash: input.bindingHash,
      generatorLlm: input.generatorLlm,
      generatorPromptVersion: input.generatorPromptVersion,
      tokensIn: input.tokensIn ?? 0,
      tokensOut: input.tokensOut ?? 0,
      durationMs: input.durationMs ?? 0,
      cache: input.cache,
      signed: input.signed,
      note: input.note ?? null,
    };
    this.stInsert.run(
      event.id,
      event.workspaceId,
      event.occurredAt,
      event.subjectFile,
      event.subjectDigest,
      event.sekkeiRoot,
      event.sekkeiRev,
      event.sekkeiLock,
      event.bindingHash,
      event.generatorLlm,
      event.generatorPromptVersion,
      event.tokensIn,
      event.tokensOut,
      event.durationMs,
      event.cache,
      event.signed ? 1 : 0,
      event.note,
    );
    return event;
  }

  findById(id: string): ProvenanceEvent | null {
    const row = this.stFind.get(id) as ProvRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  listByWorkspace(workspaceId: string, limit = 100): ProvenanceEvent[] {
    return (this.stListByWorkspace.all(workspaceId, limit) as ProvRow[]).map(rowToEvent);
  }

  listBySubject(workspaceId: string, subjectFile: string): ProvenanceEvent[] {
    return (this.stListBySubject.all(workspaceId, subjectFile) as ProvRow[]).map(rowToEvent);
  }
}

const COLS =
  'id, workspace_id, occurred_at, subject_file, subject_digest, sekkei_root, sekkei_rev, sekkei_lock, binding_hash, generator_llm, generator_prompt_version, tokens_in, tokens_out, duration_ms, cache, signed, note';

interface ProvRow {
  id: string;
  workspace_id: string;
  occurred_at: string;
  subject_file: string;
  subject_digest: string;
  sekkei_root: string;
  sekkei_rev: string;
  sekkei_lock: string;
  binding_hash: string;
  generator_llm: string;
  generator_prompt_version: string;
  tokens_in: number;
  tokens_out: number;
  duration_ms: number;
  cache: string;
  signed: number;
  note: string | null;
}

function rowToEvent(r: ProvRow): ProvenanceEvent {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    occurredAt: r.occurred_at,
    subjectFile: r.subject_file,
    subjectDigest: r.subject_digest,
    sekkeiRoot: r.sekkei_root,
    sekkeiRev: r.sekkei_rev,
    sekkeiLock: r.sekkei_lock,
    bindingHash: r.binding_hash,
    generatorLlm: r.generator_llm,
    generatorPromptVersion: r.generator_prompt_version,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    durationMs: r.duration_ms,
    cache: r.cache as ProvenanceCache,
    signed: r.signed === 1,
    note: r.note,
  };
}
