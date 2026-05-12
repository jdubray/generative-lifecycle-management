import type { Database, Statement } from 'bun:sqlite';
import type { WorkspaceConflict } from '../types.ts';

export interface WorkspaceConflictInsert {
  id: string;
  workspaceId: string;
  localCommit: string;
  remoteCommit: string;
  createdAt?: string;
}

/** Tracks non-fast-forward divergences between the local clone and its remote. */
export class WorkspaceConflictsRepository {
  private readonly stInsert: Statement;
  private readonly stListOpen: Statement;
  private readonly stResolve: Statement;

  constructor(db: Database) {
    this.stInsert = db.prepare(
      `INSERT INTO workspace_conflicts (id, workspace_id, local_commit, remote_commit, status, created_at)
       VALUES (?, ?, ?, ?, 'open', ?)`,
    );
    this.stListOpen = db.prepare(
      `SELECT id, workspace_id, local_commit, remote_commit, status, created_at
       FROM workspace_conflicts WHERE workspace_id = ? AND status = 'open'
       ORDER BY created_at DESC`,
    );
    this.stResolve = db.prepare(
      `UPDATE workspace_conflicts SET status = 'resolved' WHERE id = ?`,
    );
  }

  insert(c: WorkspaceConflictInsert): WorkspaceConflict {
    const createdAt = c.createdAt ?? new Date().toISOString();
    this.stInsert.run(c.id, c.workspaceId, c.localCommit, c.remoteCommit, createdAt);
    return {
      id: c.id,
      workspaceId: c.workspaceId,
      localCommit: c.localCommit,
      remoteCommit: c.remoteCommit,
      status: 'open',
      createdAt,
    };
  }

  listOpen(workspaceId: string): WorkspaceConflict[] {
    return (this.stListOpen.all(workspaceId) as ConflictRow[]).map(rowToConflict);
  }

  resolve(id: string): void {
    this.stResolve.run(id);
  }
}

interface ConflictRow {
  id: string;
  workspace_id: string;
  local_commit: string;
  remote_commit: string;
  status: string;
  created_at: string;
}

function rowToConflict(r: ConflictRow): WorkspaceConflict {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    localCommit: r.local_commit,
    remoteCommit: r.remote_commit,
    status: r.status as 'open' | 'resolved',
    createdAt: r.created_at,
  };
}
