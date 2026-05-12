import type { Database, Statement } from 'bun:sqlite';
import type {
  Variant,
  VariantChannel,
  VariantPinPolicy,
  VariantRollout,
  VariantRolloutState,
} from '../types.ts';

export interface VariantInsert {
  id: string;
  workspaceId: string;
  label: string;
  instance?: string | null;
  channel: VariantChannel;
  pinPolicyDefault: VariantPinPolicy;
}

export interface VariantRolloutUpsert {
  variantId: string;
  nodeId: string;
  availableRev?: string | null;
  pinRev?: string | null;
  state: VariantRolloutState;
}

const VARIANT_COLS =
  'id, workspace_id, label, instance, channel, pin_policy_default, git_ref, git_commit, closure_hash, sekkei_lock_path';

/** Repository over `variants` + `variant_rollout`. */
export class VariantRepository {
  private readonly stInsertVariant: Statement;
  private readonly stFindVariant: Statement;
  private readonly stListVariants: Statement;
  private readonly stSetGitInfo: Statement;
  private readonly stUpsertRollout: Statement;
  private readonly stListRollout: Statement;
  private readonly stDeleteRollout: Statement;

  constructor(db: Database) {
    this.stInsertVariant = db.prepare(
      `INSERT INTO variants (id, workspace_id, label, instance, channel, pin_policy_default)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.stFindVariant = db.prepare(
      `SELECT ${VARIANT_COLS} FROM variants WHERE id = ?`,
    );
    this.stListVariants = db.prepare(
      `SELECT ${VARIANT_COLS} FROM variants WHERE workspace_id = ? ORDER BY label ASC`,
    );
    this.stSetGitInfo = db.prepare(
      'UPDATE variants SET git_ref = ?, git_commit = ?, closure_hash = ?, sekkei_lock_path = ? WHERE id = ?',
    );
    this.stUpsertRollout = db.prepare(
      `INSERT INTO variant_rollout (variant_id, node_id, available_rev, pin_rev, state)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(variant_id, node_id) DO UPDATE SET
         available_rev = excluded.available_rev,
         pin_rev = excluded.pin_rev,
         state = excluded.state`,
    );
    this.stListRollout = db.prepare(
      'SELECT variant_id, node_id, available_rev, pin_rev, state FROM variant_rollout WHERE variant_id = ?',
    );
    this.stDeleteRollout = db.prepare(
      'DELETE FROM variant_rollout WHERE variant_id = ? AND node_id = ?',
    );
  }

  setGitInfo(variantId: string, opts: { gitRef: string; gitCommit: string; closureHash: string }): void {
    const r = this.stSetGitInfo.run(opts.gitRef, opts.gitCommit, opts.closureHash, 'sekkei.lock', variantId);
    if (r.changes === 0) throw new Error(`variant ${variantId} not found`);
  }

  insertVariant(input: VariantInsert): Variant {
    this.stInsertVariant.run(
      input.id,
      input.workspaceId,
      input.label,
      input.instance ?? null,
      input.channel,
      input.pinPolicyDefault,
    );
    return {
      id: input.id,
      workspaceId: input.workspaceId,
      label: input.label,
      instance: input.instance ?? null,
      channel: input.channel,
      pinPolicyDefault: input.pinPolicyDefault,
      gitRef: null,
      gitCommit: null,
      closureHash: null,
      sekkeiLockPath: null,
    };
  }

  findVariant(id: string): Variant | null {
    const row = this.stFindVariant.get(id) as VariantRow | undefined;
    return row ? rowToVariant(row) : null;
  }

  listVariants(workspaceId: string): Variant[] {
    return (this.stListVariants.all(workspaceId) as VariantRow[]).map(rowToVariant);
  }

  upsertRollout(input: VariantRolloutUpsert): VariantRollout {
    this.stUpsertRollout.run(
      input.variantId,
      input.nodeId,
      input.availableRev ?? null,
      input.pinRev ?? null,
      input.state,
    );
    return {
      variantId: input.variantId,
      nodeId: input.nodeId,
      availableRev: input.availableRev ?? null,
      pinRev: input.pinRev ?? null,
      state: input.state,
    };
  }

  listRollout(variantId: string): VariantRollout[] {
    return (this.stListRollout.all(variantId) as RolloutRow[]).map((r) => ({
      variantId: r.variant_id,
      nodeId: r.node_id,
      availableRev: r.available_rev,
      pinRev: r.pin_rev,
      state: r.state as VariantRolloutState,
    }));
  }

  deleteRollout(variantId: string, nodeId: string): boolean {
    return this.stDeleteRollout.run(variantId, nodeId).changes > 0;
  }
}

interface VariantRow {
  id: string;
  workspace_id: string;
  label: string;
  instance: string | null;
  channel: string;
  pin_policy_default: string;
  git_ref: string | null;
  git_commit: string | null;
  closure_hash: string | null;
  sekkei_lock_path: string | null;
}

interface RolloutRow {
  variant_id: string;
  node_id: string;
  available_rev: string | null;
  pin_rev: string | null;
  state: string;
}

function rowToVariant(r: VariantRow): Variant {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    label: r.label,
    instance: r.instance,
    channel: r.channel as VariantChannel,
    pinPolicyDefault: r.pin_policy_default as VariantPinPolicy,
    gitRef: r.git_ref ?? null,
    gitCommit: r.git_commit ?? null,
    closureHash: r.closure_hash ?? null,
    sekkeiLockPath: r.sekkei_lock_path ?? null,
  };
}
