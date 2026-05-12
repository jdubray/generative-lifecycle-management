import type { Database, Statement } from 'bun:sqlite';
import type { EditLock } from '../types.ts';

/**
 * Soft-lock storage. The lock has a 30-second heartbeat TTL (spec §6.2);
 * the repository does not run a sweep itself — the route handler checks
 * `heartbeatAt` and treats stale locks as releasable. Phase 7's UI will
 * call `heartbeat()` every ~10 s while a node is open.
 */
export class EditLockRepository {
  private readonly db: Database;
  private readonly stFind: Statement;
  private readonly stInsert: Statement;
  private readonly stHeartbeat: Statement;
  private readonly stDelete: Statement;
  private readonly stDeleteIfHolder: Statement;

  constructor(db: Database) {
    this.db = db;
    this.stFind = db.prepare(
      'SELECT node_id, user_id, acquired_at, heartbeat_at FROM edit_locks WHERE node_id = ?',
    );
    this.stInsert = db.prepare(
      'INSERT INTO edit_locks (node_id, user_id, acquired_at, heartbeat_at) VALUES (?, ?, ?, ?)',
    );
    this.stHeartbeat = db.prepare(
      'UPDATE edit_locks SET heartbeat_at = ? WHERE node_id = ? AND user_id = ?',
    );
    this.stDelete = db.prepare('DELETE FROM edit_locks WHERE node_id = ?');
    this.stDeleteIfHolder = db.prepare(
      'DELETE FROM edit_locks WHERE node_id = ? AND user_id = ?',
    );
  }

  /** Read the current lock for `nodeId`, if any. */
  find(nodeId: string): EditLock | null {
    const r = this.stFind.get(nodeId) as LockRow | undefined;
    return r ? rowToLock(r) : null;
  }

  /**
   * Acquire the lock. Returns the current lock if it is already held by a
   * different user and is still fresh; replaces it if expired.
   *
   * The find + (maybe) delete + insert run inside a single SQLite
   * transaction so concurrent SQLite writers cannot both observe an
   * empty row and both INSERT (which would otherwise raise UNIQUE on
   * the PRIMARY KEY).
   */
  acquire(nodeId: string, userId: string, ttlMs: number, now = new Date()): {
    granted: boolean;
    lock: EditLock;
  } {
    const nowIso = now.toISOString();
    let result: { granted: boolean; lock: EditLock } = {
      granted: true,
      lock: { nodeId, userId, acquiredAt: nowIso, heartbeatAt: nowIso },
    };
    const tx = this.db.transaction(() => {
      const existing = this.stFind.get(nodeId) as LockRow | undefined;
      if (existing) {
        const ageMs = now.getTime() - new Date(existing.heartbeat_at).getTime();
        const fresh = ageMs <= ttlMs;
        if (fresh && existing.user_id !== userId) {
          result = { granted: false, lock: rowToLock(existing) };
          return;
        }
        // expired, or same user re-acquiring → replace
        this.stDelete.run(nodeId);
      }
      this.stInsert.run(nodeId, userId, nowIso, nowIso);
    });
    tx();
    return result;
  }

  /** Extend the heartbeat for the current holder. Returns true if extended. */
  heartbeat(nodeId: string, userId: string, now = new Date()): boolean {
    return this.stHeartbeat.run(now.toISOString(), nodeId, userId).changes > 0;
  }

  /** Release a lock if `userId` is the holder. Returns true if released. */
  release(nodeId: string, userId: string): boolean {
    return this.stDeleteIfHolder.run(nodeId, userId).changes > 0;
  }

  /** Unconditional release (admin override). */
  forceRelease(nodeId: string): boolean {
    return this.stDelete.run(nodeId).changes > 0;
  }
}

interface LockRow {
  node_id: string;
  user_id: string;
  acquired_at: string;
  heartbeat_at: string;
}

function rowToLock(r: LockRow): EditLock {
  return {
    nodeId: r.node_id,
    userId: r.user_id,
    acquiredAt: r.acquired_at,
    heartbeatAt: r.heartbeat_at,
  };
}
