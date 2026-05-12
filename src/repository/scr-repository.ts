import type { Database, Statement } from 'bun:sqlite';
import type {
  Scr,
  ScrApproval,
  ScrApprovalDecision,
  ScrClass,
  ScrDiffLine,
  ScrImpact,
  ScrStatus,
} from '../types.ts';

export interface ScrInsert {
  id: string;
  workspaceId: string;
  title: string;
  scrClass: ScrClass;
  status: ScrStatus;
  proposer: string;
  proposedAt?: string;
  problem: string;
  diffYaml: ScrDiffLine[];
  targetNodes: string[];
  effectivity?: string | null;
  returnReason?: string | null;
  impact?: ScrImpact | null;
}

export interface ScrApprovalUpsert {
  scrId: string;
  who: string;
  decision: ScrApprovalDecision;
  decidedAt?: string | null;
}

/** Repository over `scrs` + `scr_approvals`. */
export class ScrRepository {
  private readonly db: Database;
  private readonly stInsert: Statement;
  private readonly stUpdateStatus: Statement;
  private readonly stSetGitInfo: Statement;
  private readonly stFindById: Statement;
  private readonly stListByStatus: Statement;
  private readonly stUpsertApproval: Statement;
  private readonly stListApprovals: Statement;

  constructor(db: Database) {
    this.db = db;
    this.stInsert = db.prepare(SCR_INSERT_SQL);
    this.stUpdateStatus = db.prepare(
      'UPDATE scrs SET status = ?, return_reason = ? WHERE id = ?',
    );
    this.stSetGitInfo = db.prepare(
      'UPDATE scrs SET git_commit = ?, git_branch = ?, git_pr_url = ? WHERE id = ?',
    );
    this.stFindById = db.prepare(`SELECT ${SCR_SELECT_COLS} FROM scrs WHERE id = ?`);
    this.stListByStatus = db.prepare(
      `SELECT ${SCR_SELECT_COLS} FROM scrs WHERE workspace_id = ? AND status = ? ORDER BY proposed_at DESC`,
    );
    this.stUpsertApproval = db.prepare(
      `INSERT INTO scr_approvals (scr_id, who, decision, decided_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(scr_id, who) DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at`,
    );
    this.stListApprovals = db.prepare(
      'SELECT scr_id, who, decision, decided_at FROM scr_approvals WHERE scr_id = ? ORDER BY who ASC',
    );
  }

  insert(input: ScrInsert): Scr {
    const proposedAt = input.proposedAt ?? new Date().toISOString();
    this.stInsert.run(
      input.id,
      input.workspaceId,
      input.title,
      input.scrClass,
      input.status,
      input.proposer,
      proposedAt,
      input.problem,
      JSON.stringify(input.diffYaml),
      JSON.stringify(input.targetNodes),
      input.effectivity ?? null,
      input.returnReason ?? null,
      input.impact === undefined || input.impact === null ? null : JSON.stringify(input.impact),
    );
    return {
      id: input.id,
      workspaceId: input.workspaceId,
      title: input.title,
      scrClass: input.scrClass,
      status: input.status,
      proposer: input.proposer,
      proposedAt,
      problem: input.problem,
      diffYaml: input.diffYaml,
      targetNodes: input.targetNodes,
      effectivity: input.effectivity ?? null,
      returnReason: input.returnReason ?? null,
      impact: input.impact ?? null,
    };
  }

  setStatus(scrId: string, status: ScrStatus, returnReason: string | null = null): void {
    const r = this.stUpdateStatus.run(status, returnReason, scrId);
    if (r.changes === 0) throw new Error(`scr ${scrId} not found`);
  }

  setGitInfo(scrId: string, opts: { gitCommit: string; gitBranch: string; gitPrUrl?: string | null }): void {
    const r = this.stSetGitInfo.run(opts.gitCommit, opts.gitBranch, opts.gitPrUrl ?? null, scrId);
    if (r.changes === 0) throw new Error(`scr ${scrId} not found`);
  }

  findById(id: string): Scr | null {
    const row = this.stFindById.get(id) as ScrRow | undefined;
    return row ? rowToScr(row) : null;
  }

  listByStatus(workspaceId: string, status: ScrStatus): Scr[] {
    return (this.stListByStatus.all(workspaceId, status) as ScrRow[]).map(rowToScr);
  }

  upsertApproval(input: ScrApprovalUpsert): ScrApproval {
    const decidedAt = input.decidedAt ?? null;
    this.stUpsertApproval.run(input.scrId, input.who, input.decision, decidedAt);
    return { scrId: input.scrId, who: input.who, decision: input.decision, decidedAt };
  }

  listApprovals(scrId: string): ScrApproval[] {
    return (this.stListApprovals.all(scrId) as ApprovalRow[]).map((r) => ({
      scrId: r.scr_id,
      who: r.who,
      decision: r.decision as ScrApprovalDecision,
      decidedAt: r.decided_at,
    }));
  }
}

const SCR_INSERT_COLS =
  'id, workspace_id, title, class, status, proposer, proposed_at, problem, diff_yaml, target_nodes, effectivity, return_reason, impact_json';

const SCR_SELECT_COLS =
  `${SCR_INSERT_COLS}, git_commit, git_branch, git_pr_url`;

const SCR_INSERT_SQL = `
  INSERT INTO scrs (${SCR_INSERT_COLS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

interface ScrRow {
  id: string;
  workspace_id: string;
  title: string;
  class: string;
  status: string;
  proposer: string;
  proposed_at: string;
  problem: string;
  diff_yaml: string;
  target_nodes: string;
  effectivity: string | null;
  return_reason: string | null;
  impact_json: string | null;
  git_commit: string | null;
  git_branch: string | null;
  git_pr_url: string | null;
}

interface ApprovalRow {
  scr_id: string;
  who: string;
  decision: string;
  decided_at: string | null;
}

function rowToScr(r: ScrRow): Scr {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    scrClass: r.class as ScrClass,
    status: r.status as ScrStatus,
    proposer: r.proposer,
    proposedAt: r.proposed_at,
    problem: r.problem,
    diffYaml: JSON.parse(r.diff_yaml) as ScrDiffLine[],
    targetNodes: JSON.parse(r.target_nodes) as string[],
    effectivity: r.effectivity,
    returnReason: r.return_reason,
    impact: r.impact_json ? (JSON.parse(r.impact_json) as ScrImpact) : null,
    gitCommit: r.git_commit ?? null,
    gitBranch: r.git_branch ?? null,
    gitPrUrl: r.git_pr_url ?? null,
  };
}
