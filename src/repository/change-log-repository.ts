import type { Database, Statement } from 'bun:sqlite';
import type { ChangeLogEntry, ChangeLogOp, Sha256Hash } from '../types.ts';

export interface ChangeLogInsert {
  workspaceId: string;
  nodeId: string | null;
  /** Null for system-originated entries (git-sync). */
  userId: string | null;
  op: ChangeLogOp;
  beforeContentHash?: Sha256Hash | null;
  afterContentHash?: Sha256Hash | null;
  ts?: string;
}

/** Append-only feed of node mutations. Powers WebSocket replay and audit. */
export class ChangeLogRepository {
  private readonly stInsert: Statement;
  private readonly stListSince: Statement;
  private readonly stListLatest: Statement;

  constructor(db: Database) {
    this.stInsert = db.prepare(
      `INSERT INTO change_log (workspace_id, node_id, user_id, op, before_content_hash, after_content_hash, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    );
    this.stListSince = db.prepare(
      `SELECT id, workspace_id, node_id, user_id, op, before_content_hash, after_content_hash, ts
       FROM change_log WHERE workspace_id = ? AND ts > ? ORDER BY ts ASC, id ASC`,
    );
    this.stListLatest = db.prepare(
      `SELECT id, workspace_id, node_id, user_id, op, before_content_hash, after_content_hash, ts
       FROM change_log WHERE workspace_id = ? ORDER BY ts DESC, id DESC LIMIT ?`,
    );
  }

  append(input: ChangeLogInsert): ChangeLogEntry {
    const ts = input.ts ?? new Date().toISOString();
    const row = this.stInsert.get(
      input.workspaceId,
      input.nodeId,
      input.userId,
      input.op,
      input.beforeContentHash ?? null,
      input.afterContentHash ?? null,
      ts,
    ) as { id: number } | undefined;
    if (!row) throw new Error('change_log insert returned no id');
    return {
      id: row.id,
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      userId: input.userId,
      op: input.op,
      beforeContentHash: input.beforeContentHash ?? null,
      afterContentHash: input.afterContentHash ?? null,
      ts,
    };
  }

  listSince(workspaceId: string, ts: string): ChangeLogEntry[] {
    return (this.stListSince.all(workspaceId, ts) as ChangeLogRow[]).map(rowToEntry);
  }

  listLatest(workspaceId: string, limit = 100): ChangeLogEntry[] {
    return (this.stListLatest.all(workspaceId, limit) as ChangeLogRow[]).map(rowToEntry);
  }
}

interface ChangeLogRow {
  id: number;
  workspace_id: string;
  node_id: string | null;
  user_id: string | null;
  op: string;
  before_content_hash: string | null;
  after_content_hash: string | null;
  ts: string;
}

function rowToEntry(r: ChangeLogRow): ChangeLogEntry {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    nodeId: r.node_id,
    userId: r.user_id,
    op: r.op as ChangeLogOp,
    beforeContentHash: r.before_content_hash,
    afterContentHash: r.after_content_hash,
    ts: r.ts,
  };
}
