import type { Database, Statement } from 'bun:sqlite';
import type {
  DriftGitClassification,
  DriftKind,
  DriftPolicy,
  DriftRecord,
  DriftStatus,
  Sha256Hash,
} from '../types.ts';

export interface DriftInsert {
  id: string;
  workspaceId: string;
  nodeId: string;
  file: string;
  status: DriftStatus;
  kind: DriftKind;
  desiredHash?: Sha256Hash | null;
  observedHash?: Sha256Hash | null;
  policy: DriftPolicy;
  detail?: string | null;
  detectedAt?: string;
  /**
   * These four fields are NOT persisted by `upsert()`. The upsert statement
   * only touches the 11 core columns so it can be called repeatedly without
   * overwriting git provenance on each re-sweep. Pass them to `setGitInfo()`
   * after upsert to write them to the DB. Note: the domain object returned by
   * `upsert()` reflects the values passed in here, creating a temporary
   * divergence from the DB until `setGitInfo()` is called.
   */
  realizationCommit?: string | null;
  specCommit?: string | null;
  classification?: DriftGitClassification | null;
  autoResolvable?: boolean;
}

export class DriftRepository {
  private readonly stUpsert: Statement;
  private readonly stFind: Statement;
  private readonly stListByStatus: Statement;
  private readonly stListByWorkspace: Statement;
  private readonly stListByNode: Statement;
  private readonly stDelete: Statement;
  private readonly stSetGitInfo: Statement;

  constructor(db: Database) {
    this.stUpsert = db.prepare(
      `INSERT INTO drift_records (id, workspace_id, node_id, file, status, kind,
         desired_hash, observed_hash, policy, detail, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         kind = excluded.kind,
         desired_hash = excluded.desired_hash,
         observed_hash = excluded.observed_hash,
         policy = excluded.policy,
         detail = excluded.detail,
         detected_at = excluded.detected_at`,
    );
    this.stFind = db.prepare(`SELECT ${COLS} FROM drift_records WHERE id = ?`);
    this.stListByStatus = db.prepare(
      `SELECT ${COLS} FROM drift_records WHERE workspace_id = ? AND status = ? ORDER BY detected_at DESC`,
    );
    this.stListByWorkspace = db.prepare(
      `SELECT ${COLS} FROM drift_records WHERE workspace_id = ? ORDER BY detected_at DESC`,
    );
    this.stListByNode = db.prepare(
      `SELECT ${COLS} FROM drift_records WHERE node_id = ? ORDER BY detected_at DESC`,
    );
    this.stDelete = db.prepare('DELETE FROM drift_records WHERE id = ?');
    this.stSetGitInfo = db.prepare(
      `UPDATE drift_records
       SET realization_commit = ?, spec_commit = ?, classification = ?, auto_resolvable = ?
       WHERE id = ?`,
    );
  }

  upsert(input: DriftInsert): DriftRecord {
    const detectedAt = input.detectedAt ?? new Date().toISOString();
    this.stUpsert.run(
      input.id,
      input.workspaceId,
      input.nodeId,
      input.file,
      input.status,
      input.kind,
      input.desiredHash ?? null,
      input.observedHash ?? null,
      input.policy,
      input.detail ?? null,
      detectedAt,
    );
    return {
      id: input.id,
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      file: input.file,
      status: input.status,
      kind: input.kind,
      desiredHash: input.desiredHash ?? null,
      observedHash: input.observedHash ?? null,
      policy: input.policy,
      detail: input.detail ?? null,
      detectedAt,
      realizationCommit: input.realizationCommit ?? null,
      specCommit: input.specCommit ?? null,
      classification: input.classification ?? null,
      autoResolvable: input.autoResolvable ?? false,
    };
  }

  /** Record realization/sekkei commit SHAs and drift classification after a sweep. */
  setGitInfo(
    id: string,
    opts: {
      realizationCommit: string;
      specCommit: string;
      classification: DriftGitClassification;
      autoResolvable: boolean;
    },
  ): void {
    this.stSetGitInfo.run(
      opts.realizationCommit,
      opts.specCommit,
      opts.classification,
      opts.autoResolvable ? 1 : 0,
      id,
    );
  }

  findById(id: string): DriftRecord | null {
    const row = this.stFind.get(id) as DriftRow | undefined;
    return row ? rowToDrift(row) : null;
  }

  listByStatus(workspaceId: string, status: DriftStatus): DriftRecord[] {
    return (this.stListByStatus.all(workspaceId, status) as DriftRow[]).map(rowToDrift);
  }

  /** All drift records for a workspace regardless of status. */
  listByWorkspace(workspaceId: string): DriftRecord[] {
    return (this.stListByWorkspace.all(workspaceId) as DriftRow[]).map(rowToDrift);
  }

  listByNode(nodeId: string): DriftRecord[] {
    return (this.stListByNode.all(nodeId) as DriftRow[]).map(rowToDrift);
  }

  delete(id: string): boolean {
    return this.stDelete.run(id).changes > 0;
  }
}

const COLS =
  'id, workspace_id, node_id, file, status, kind, desired_hash, observed_hash, policy, detail, detected_at, realization_commit, spec_commit, classification, auto_resolvable';

interface DriftRow {
  id: string;
  workspace_id: string;
  node_id: string;
  file: string;
  status: string;
  kind: string;
  desired_hash: string | null;
  observed_hash: string | null;
  policy: string;
  detail: string | null;
  detected_at: string;
  realization_commit: string | null;
  spec_commit: string | null;
  classification: string | null;
  auto_resolvable: number;
}

function rowToDrift(r: DriftRow): DriftRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    nodeId: r.node_id,
    file: r.file,
    status: r.status as DriftStatus,
    kind: r.kind as DriftKind,
    desiredHash: r.desired_hash,
    observedHash: r.observed_hash,
    policy: r.policy as DriftPolicy,
    detail: r.detail,
    detectedAt: r.detected_at,
    realizationCommit: r.realization_commit,
    specCommit: r.spec_commit,
    classification: r.classification as DriftGitClassification | null,
    autoResolvable: r.auto_resolvable !== 0,
  };
}
