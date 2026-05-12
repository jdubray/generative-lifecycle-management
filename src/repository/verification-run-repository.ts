import type { Database, Statement } from 'bun:sqlite';
import type { VerificationRun } from '../types.ts';

export interface VerificationRunInsert {
  id: string;
  workspaceId: string;
  ts?: string;
  gateResults: Record<string, unknown>;
  overallPass: boolean;
}

export class VerificationRunRepository {
  private readonly stInsert: Statement;
  private readonly stFind: Statement;
  private readonly stListLatest: Statement;
  private readonly stLatestOne: Statement;

  constructor(db: Database) {
    this.stInsert = db.prepare(
      `INSERT INTO verification_runs (id, workspace_id, ts, gate_results_json, overall_pass)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.stFind = db.prepare(
      `SELECT id, workspace_id, ts, gate_results_json, overall_pass FROM verification_runs WHERE id = ?`,
    );
    this.stListLatest = db.prepare(
      `SELECT id, workspace_id, ts, gate_results_json, overall_pass FROM verification_runs
       WHERE workspace_id = ? ORDER BY ts DESC LIMIT ?`,
    );
    this.stLatestOne = db.prepare(
      `SELECT id, workspace_id, ts, gate_results_json, overall_pass FROM verification_runs
       WHERE workspace_id = ? ORDER BY ts DESC LIMIT 1`,
    );
  }

  insert(input: VerificationRunInsert): VerificationRun {
    const ts = input.ts ?? new Date().toISOString();
    this.stInsert.run(
      input.id,
      input.workspaceId,
      ts,
      JSON.stringify(input.gateResults),
      input.overallPass ? 1 : 0,
    );
    return {
      id: input.id,
      workspaceId: input.workspaceId,
      ts,
      gateResults: input.gateResults,
      overallPass: input.overallPass,
    };
  }

  findById(id: string): VerificationRun | null {
    const row = this.stFind.get(id) as Row | undefined;
    return row ? rowTo(row) : null;
  }

  listLatest(workspaceId: string, limit = 20): VerificationRun[] {
    return (this.stListLatest.all(workspaceId, limit) as Row[]).map(rowTo);
  }

  latest(workspaceId: string): VerificationRun | null {
    const row = this.stLatestOne.get(workspaceId) as Row | undefined;
    return row ? rowTo(row) : null;
  }
}

interface Row {
  id: string;
  workspace_id: string;
  ts: string;
  gate_results_json: string;
  overall_pass: number;
}

function rowTo(r: Row): VerificationRun {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    ts: r.ts,
    gateResults: JSON.parse(r.gate_results_json) as Record<string, unknown>,
    overallPass: r.overall_pass === 1,
  };
}
