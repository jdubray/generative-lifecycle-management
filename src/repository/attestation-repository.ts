import type { Database, Statement } from 'bun:sqlite';

export interface AttestationRow {
  id: string;
  provenanceEventId: string;
  workspaceId: string;
  statementJson: string;
  dsseJson: string;
  keyId: string;
  rekorEntryId: string | null;
  createdAt: string;
  realizationCommit: string | null;
  gitNoteRef: string | null;
}

export interface AttestationInsert {
  id: string;
  provenanceEventId: string;
  workspaceId: string;
  statementJson: string;
  dsseJson: string;
  keyId: string;
  rekorEntryId?: string | null;
  createdAt?: string;
}

export class AttestationRepository {
  private readonly stInsert: Statement;
  private readonly stFindByEvent: Statement;
  private readonly stListByWorkspace: Statement;
  private readonly stSetGitInfo: Statement;

  constructor(db: Database) {
    this.stInsert = db.prepare(
      `INSERT INTO generation_attestations
         (id, provenance_event_id, workspace_id, statement_json, dsse_json, key_id, rekor_entry_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stFindByEvent = db.prepare(`SELECT ${COLS} FROM generation_attestations WHERE provenance_event_id = ?`);
    this.stListByWorkspace = db.prepare(
      `SELECT ${COLS} FROM generation_attestations WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`,
    );
    this.stSetGitInfo = db.prepare(
      `UPDATE generation_attestations SET realization_commit = ?, git_note_ref = ? WHERE id = ?`,
    );
  }

  insert(input: AttestationInsert): AttestationRow {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.stInsert.run(
      input.id,
      input.provenanceEventId,
      input.workspaceId,
      input.statementJson,
      input.dsseJson,
      input.keyId,
      input.rekorEntryId ?? null,
      createdAt,
    );
    return {
      id: input.id,
      provenanceEventId: input.provenanceEventId,
      workspaceId: input.workspaceId,
      statementJson: input.statementJson,
      dsseJson: input.dsseJson,
      keyId: input.keyId,
      rekorEntryId: input.rekorEntryId ?? null,
      createdAt,
      realizationCommit: null,
      gitNoteRef: null,
    };
  }

  /** Record the git-notes ref and realization commit after attaching the note. */
  setGitInfo(id: string, opts: { realizationCommit: string; gitNoteRef: string }): void {
    this.stSetGitInfo.run(opts.realizationCommit, opts.gitNoteRef, id);
  }

  findByEvent(provenanceEventId: string): AttestationRow | null {
    const row = this.stFindByEvent.get(provenanceEventId) as RowShape | undefined;
    return row ? rowTo(row) : null;
  }

  listByWorkspace(workspaceId: string, limit = 100): AttestationRow[] {
    return (this.stListByWorkspace.all(workspaceId, limit) as RowShape[]).map(rowTo);
  }
}

const COLS =
  'id, provenance_event_id, workspace_id, statement_json, dsse_json, key_id, rekor_entry_id, created_at, realization_commit, git_note_ref';

interface RowShape {
  id: string;
  provenance_event_id: string;
  workspace_id: string;
  statement_json: string;
  dsse_json: string;
  key_id: string;
  rekor_entry_id: string | null;
  created_at: string;
  realization_commit: string | null;
  git_note_ref: string | null;
}

function rowTo(r: RowShape): AttestationRow {
  return {
    id: r.id,
    provenanceEventId: r.provenance_event_id,
    workspaceId: r.workspace_id,
    statementJson: r.statement_json,
    dsseJson: r.dsse_json,
    keyId: r.key_id,
    rekorEntryId: r.rekor_entry_id,
    createdAt: r.created_at,
    realizationCommit: r.realization_commit,
    gitNoteRef: r.git_note_ref,
  };
}
