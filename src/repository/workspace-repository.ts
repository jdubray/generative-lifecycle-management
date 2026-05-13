import type { Database, Statement } from 'bun:sqlite';
import type { Workspace, WorkspaceMember, WorkspaceMemberRole } from '../types.ts';

export interface WorkspaceInsert {
  id: string;
  slug: string;
  name: string;
  createdAt?: string;
}

export interface WorkspaceMemberInsert {
  workspaceId: string;
  userId: string;
  role: WorkspaceMemberRole;
  joinedAt?: string;
}

export interface WorkspaceGitAttach {
  gitRemote: string;
  gitRef: string;
  gitCommit: string;
  gitCloneDir: string;
  gitForge?: 'github' | 'gitlab' | null;
  gitAutoPush?: boolean;
}

const WORKSPACE_COLS = [
  'id', 'slug', 'name', 'created_at',
  'git_remote', 'git_ref', 'git_commit', 'git_clone_dir', 'git_forge', 'git_auto_push',
  'source_dir',
].join(', ');

export class WorkspaceRepository {
  private readonly stInsert: Statement;
  private readonly stFindById: Statement;
  private readonly stFindBySlug: Statement;
  private readonly stListAttached: Statement;
  private readonly stAttachGit: Statement;
  private readonly stDetachGit: Statement;
  private readonly stUpdateGitCommit: Statement;
  private readonly stSetSourceDir: Statement;
  private readonly stInsertMember: Statement;
  private readonly stFindMember: Statement;
  private readonly stListMembers: Statement;

  constructor(db: Database) {
    this.stInsert = db.prepare(
      'INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)',
    );
    this.stFindById = db.prepare(
      `SELECT ${WORKSPACE_COLS} FROM workspaces WHERE id = ?`,
    );
    this.stFindBySlug = db.prepare(
      `SELECT ${WORKSPACE_COLS} FROM workspaces WHERE slug = ?`,
    );
    this.stListAttached = db.prepare(
      `SELECT ${WORKSPACE_COLS} FROM workspaces WHERE git_remote IS NOT NULL`,
    );
    this.stAttachGit = db.prepare(
      `UPDATE workspaces
       SET git_remote = ?, git_ref = ?, git_commit = ?, git_clone_dir = ?,
           git_forge = ?, git_auto_push = ?
       WHERE id = ?`,
    );
    this.stDetachGit = db.prepare(
      `UPDATE workspaces
       SET git_remote = NULL, git_ref = NULL, git_commit = NULL,
           git_clone_dir = NULL, git_forge = NULL, git_auto_push = 0
       WHERE id = ?`,
    );
    this.stUpdateGitCommit = db.prepare(
      'UPDATE workspaces SET git_commit = ? WHERE id = ?',
    );
    this.stSetSourceDir = db.prepare(
      'UPDATE workspaces SET source_dir = ? WHERE id = ?',
    );
    this.stInsertMember = db.prepare(
      'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
    );
    this.stFindMember = db.prepare(
      'SELECT workspace_id, user_id, role, joined_at FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    );
    this.stListMembers = db.prepare(
      'SELECT workspace_id, user_id, role, joined_at FROM workspace_members WHERE workspace_id = ?',
    );
  }

  insert(w: WorkspaceInsert): Workspace {
    const createdAt = w.createdAt ?? new Date().toISOString();
    this.stInsert.run(w.id, w.slug, w.name, createdAt);
    return rowToWorkspace({ id: w.id, slug: w.slug, name: w.name, created_at: createdAt,
      git_remote: null, git_ref: null, git_commit: null, git_clone_dir: null,
      git_forge: null, git_auto_push: 0, source_dir: null });
  }

  findById(id: string): Workspace | null {
    const r = this.stFindById.get(id) as WorkspaceRow | undefined;
    return r ? rowToWorkspace(r) : null;
  }

  findBySlug(slug: string): Workspace | null {
    const r = this.stFindBySlug.get(slug) as WorkspaceRow | undefined;
    return r ? rowToWorkspace(r) : null;
  }

  /** Attach a git remote to the workspace; returns the updated record. */
  attachGit(workspaceId: string, opts: WorkspaceGitAttach): void {
    this.stAttachGit.run(
      opts.gitRemote,
      opts.gitRef,
      opts.gitCommit,
      opts.gitCloneDir,
      opts.gitForge ?? null,
      opts.gitAutoPush ? 1 : 0,
      workspaceId,
    );
  }

  /** Detach git remote; workspace reverts to DB-only mode. Clone survives on disk. */
  detachGit(workspaceId: string): void {
    this.stDetachGit.run(workspaceId);
  }

  /** Update `git_commit` after a successful sync or initial attach. */
  updateGitCommit(workspaceId: string, sha: string): void {
    this.stUpdateGitCommit.run(sha, workspaceId);
  }

  /** Set (or clear) the workspace's local `source_dir` used by `glm generate`. */
  setSourceDir(workspaceId: string, sourceDir: string | null): void {
    this.stSetSourceDir.run(sourceDir, workspaceId);
  }

  /** All workspaces that have a git remote attached. */
  listAttached(): Workspace[] {
    return (this.stListAttached.all() as WorkspaceRow[]).map(rowToWorkspace);
  }

  addMember(m: WorkspaceMemberInsert): WorkspaceMember {
    const joinedAt = m.joinedAt ?? new Date().toISOString();
    this.stInsertMember.run(m.workspaceId, m.userId, m.role, joinedAt);
    return { workspaceId: m.workspaceId, userId: m.userId, role: m.role, joinedAt };
  }

  findMember(workspaceId: string, userId: string): WorkspaceMember | null {
    const r = this.stFindMember.get(workspaceId, userId) as MemberRow | undefined;
    return r ? rowToMember(r) : null;
  }

  listMembers(workspaceId: string): WorkspaceMember[] {
    return (this.stListMembers.all(workspaceId) as MemberRow[]).map(rowToMember);
  }
}

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  created_at: string;
  git_remote: string | null;
  git_ref: string | null;
  git_commit: string | null;
  git_clone_dir: string | null;
  git_forge: string | null;
  git_auto_push: number;
  source_dir: string | null;
}

interface MemberRow {
  workspace_id: string;
  user_id: string;
  role: string;
  joined_at: string;
}

function rowToWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    createdAt: r.created_at,
    gitRemote: r.git_remote,
    gitRef: r.git_ref,
    gitCommit: r.git_commit,
    gitCloneDir: r.git_clone_dir,
    gitForge: (r.git_forge as 'github' | 'gitlab' | null) ?? null,
    gitAutoPush: r.git_auto_push === 1,
    sourceDir: r.source_dir,
  };
}

function rowToMember(r: MemberRow): WorkspaceMember {
  return {
    workspaceId: r.workspace_id,
    userId: r.user_id,
    role: r.role as WorkspaceMemberRole,
    joinedAt: r.joined_at,
  };
}
