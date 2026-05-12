import type { Database, Statement } from 'bun:sqlite';
import type { RolloutRecord, RolloutStatus, IsoDateTime } from '../types.ts';

export interface RolloutRecordInsert {
  id: string;
  variantId: string;
  nodeId: string;
  fromRev?: string | null;
  toRev?: string | null;
  status?: RolloutStatus;
  pinRev?: string | null;
  releaseTag: string;
  createdAt?: IsoDateTime;
  updatedAt?: IsoDateTime;
}

const COLS =
  'id, variant_id, node_id, from_rev, to_rev, status, pin_rev, release_tag, created_at, updated_at';

interface RrRow {
  id: string;
  variant_id: string;
  node_id: string;
  from_rev: string | null;
  to_rev: string | null;
  status: string;
  pin_rev: string | null;
  release_tag: string;
  created_at: string;
  updated_at: string;
}

function rowTo(r: RrRow): RolloutRecord {
  return {
    id: r.id,
    variantId: r.variant_id,
    nodeId: r.node_id,
    fromRev: r.from_rev,
    toRev: r.to_rev,
    status: r.status as RolloutStatus,
    pinRev: r.pin_rev,
    releaseTag: r.release_tag,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Repository over `rollout_records` (Git Step 8).
 *
 * Each row tracks a single node's rollout progress for one release tag.
 * The `advance` method moves a record from `pending` to `advanced` or
 * `blocked`; the state is terminal once set.
 */
export class RolloutRepository {
  private readonly stInsert: Statement;
  private readonly stFindById: Statement;
  private readonly stListByVariant: Statement;
  private readonly stListByTag: Statement;
  private readonly stAdvance: Statement;

  constructor(db: Database) {
    this.stInsert = db.prepare(
      `INSERT OR IGNORE INTO rollout_records
         (id, variant_id, node_id, from_rev, to_rev, status, pin_rev, release_tag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stFindById = db.prepare(
      `SELECT ${COLS} FROM rollout_records WHERE id = ?`,
    );
    this.stListByVariant = db.prepare(
      `SELECT ${COLS} FROM rollout_records WHERE variant_id = ? ORDER BY release_tag DESC, created_at DESC`,
    );
    this.stListByTag = db.prepare(
      `SELECT ${COLS} FROM rollout_records WHERE release_tag = ? ORDER BY variant_id, node_id`,
    );
    this.stAdvance = db.prepare(
      `UPDATE rollout_records SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
    );
  }

  insert(input: RolloutRecordInsert): RolloutRecord {
    const now = new Date().toISOString();
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? now;
    this.stInsert.run(
      input.id,
      input.variantId,
      input.nodeId,
      input.fromRev ?? null,
      input.toRev ?? null,
      input.status ?? 'pending',
      input.pinRev ?? null,
      input.releaseTag,
      createdAt,
      updatedAt,
    );
    return {
      id: input.id,
      variantId: input.variantId,
      nodeId: input.nodeId,
      fromRev: input.fromRev ?? null,
      toRev: input.toRev ?? null,
      status: input.status ?? 'pending',
      pinRev: input.pinRev ?? null,
      releaseTag: input.releaseTag,
      createdAt,
      updatedAt,
    };
  }

  findById(id: string): RolloutRecord | null {
    const row = this.stFindById.get(id) as RrRow | undefined;
    return row ? rowTo(row) : null;
  }

  /** All rollout records for a variant, newest release first. */
  listByVariant(variantId: string): RolloutRecord[] {
    return (this.stListByVariant.all(variantId) as RrRow[]).map(rowTo);
  }

  /** All rollout records created for a specific release tag. */
  listByTag(releaseTag: string): RolloutRecord[] {
    return (this.stListByTag.all(releaseTag) as RrRow[]).map(rowTo);
  }

  /**
   * Advance a record's status to `advanced` or `blocked`. Returns the updated
   * record, or null if the id does not exist.
   */
  advance(id: string, status: 'advanced' | 'blocked'): RolloutRecord | null {
    const updatedAt = new Date().toISOString();
    const r = this.stAdvance.run(status, updatedAt, id);
    if (r.changes === 0) return null;
    return this.findById(id);
  }
}
