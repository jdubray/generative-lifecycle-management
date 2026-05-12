import type { Database, Statement } from 'bun:sqlite';
import type { ReuseCandidate, ReuseStage } from '../types.ts';

export interface ReuseCandidateInsert {
  id: string;
  workspaceId: string;
  subtree: string;
  title: string;
  stage: ReuseStage;
  rationale?: string;
  usages?: number;
  invariantsHeldIn?: number;
  steward?: string | null;
}

export interface ReuseCandidateUpdate {
  stage?: ReuseStage;
  rationale?: string;
  usages?: number;
  invariantsHeldIn?: number;
  steward?: string | null;
}

export class ReuseRepository {
  private readonly stInsert: Statement;
  private readonly stFind: Statement;
  private readonly stListAll: Statement;
  private readonly stListByStage: Statement;
  private readonly stUpdate: Statement;
  private readonly stDelete: Statement;

  constructor(db: Database) {
    this.stInsert = db.prepare(
      `INSERT INTO reuse_candidates (id, workspace_id, subtree, title, stage, rationale, usages, invariants_held_in, steward)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stFind = db.prepare(`SELECT ${COLS} FROM reuse_candidates WHERE id = ?`);
    this.stListAll = db.prepare(`SELECT ${COLS} FROM reuse_candidates WHERE workspace_id = ? ORDER BY stage, title`);
    this.stListByStage = db.prepare(`SELECT ${COLS} FROM reuse_candidates WHERE workspace_id = ? AND stage = ? ORDER BY title`);
    this.stUpdate = db.prepare(
      `UPDATE reuse_candidates SET
         stage = COALESCE(?, stage),
         rationale = COALESCE(?, rationale),
         usages = COALESCE(?, usages),
         invariants_held_in = COALESCE(?, invariants_held_in),
         steward = ?
       WHERE id = ?`,
    );
    this.stDelete = db.prepare('DELETE FROM reuse_candidates WHERE id = ?');
  }

  insert(input: ReuseCandidateInsert): ReuseCandidate {
    this.stInsert.run(
      input.id,
      input.workspaceId,
      input.subtree,
      input.title,
      input.stage,
      input.rationale ?? '',
      input.usages ?? 0,
      input.invariantsHeldIn ?? 0,
      input.steward ?? null,
    );
    return {
      id: input.id,
      workspaceId: input.workspaceId,
      subtree: input.subtree,
      title: input.title,
      stage: input.stage,
      rationale: input.rationale ?? '',
      usages: input.usages ?? 0,
      invariantsHeldIn: input.invariantsHeldIn ?? 0,
      steward: input.steward ?? null,
    };
  }

  findById(id: string): ReuseCandidate | null {
    const row = this.stFind.get(id) as Row | undefined;
    return row ? rowTo(row) : null;
  }

  list(workspaceId: string, stage?: ReuseStage): ReuseCandidate[] {
    const rows = stage
      ? (this.stListByStage.all(workspaceId, stage) as Row[])
      : (this.stListAll.all(workspaceId) as Row[]);
    return rows.map(rowTo);
  }

  update(id: string, patch: ReuseCandidateUpdate): ReuseCandidate {
    const existing = this.findById(id);
    if (!existing) throw new Error(`reuse candidate ${id} not found`);
    const steward = patch.steward === undefined ? existing.steward : patch.steward;
    this.stUpdate.run(
      patch.stage ?? null,
      patch.rationale ?? null,
      patch.usages ?? null,
      patch.invariantsHeldIn ?? null,
      steward,
      id,
    );
    return this.findById(id) as ReuseCandidate;
  }

  delete(id: string): boolean {
    return this.stDelete.run(id).changes > 0;
  }
}

const COLS = 'id, workspace_id, subtree, title, stage, rationale, usages, invariants_held_in, steward';

interface Row {
  id: string;
  workspace_id: string;
  subtree: string;
  title: string;
  stage: string;
  rationale: string;
  usages: number;
  invariants_held_in: number;
  steward: string | null;
}

function rowTo(r: Row): ReuseCandidate {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    subtree: r.subtree,
    title: r.title,
    stage: r.stage as ReuseStage,
    rationale: r.rationale,
    usages: r.usages,
    invariantsHeldIn: r.invariants_held_in,
    steward: r.steward,
  };
}
