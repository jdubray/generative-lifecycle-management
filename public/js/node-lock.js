/**
 * Soft-lock helper.
 *
 *   const lock = openNodeLock(workspaceId, glmId, { onState });
 *   await lock.acquire();
 *   // ... user edits ...
 *   await lock.release();
 *
 * While held, the lock pings `/lock/heartbeat` every `heartbeatMs` (default
 * 10 s — well inside the server's 30 s TTL). `onState({ state, lock })` is
 * invoked on every transition so the UI can render a "locked by X" banner.
 */
import { api } from './api.js';

export function openNodeLock(workspaceId, glmId, { onState, heartbeatMs = 10_000 } = {}) {
  let timer = null;
  let state = 'idle';
  let lock = null;

  function setState(next, payload) {
    state = next;
    onState?.({ state, lock: payload ?? lock });
  }

  async function acquire() {
    try {
      const res = await api.acquireLock(workspaceId, glmId);
      lock = res.lock;
      setState('held', lock);
      schedule();
      return { granted: true, lock };
    } catch (err) {
      if (err.status === 423) {
        setState('busy', err.body?.error);
        return { granted: false, heldBy: err.body?.error?.heldBy };
      }
      setState('error');
      throw err;
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(beat, heartbeatMs);
  }

  async function beat() {
    if (state !== 'held') return;
    try {
      const res = await api.heartbeatLock(workspaceId, glmId);
      lock = res.lock;
      schedule();
    } catch {
      setState('lost');
    }
  }

  async function release() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (state !== 'held') return;
    try {
      await api.releaseLock(workspaceId, glmId);
    } finally {
      setState('released');
      lock = null;
    }
  }

  return { acquire, release };
}
