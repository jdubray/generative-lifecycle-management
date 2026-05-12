/**
 * Workspace WebSocket client.
 *
 *   const ws = openWorkspaceSocket('ws-1', { onEvent, onStatus });
 *   ws.ping();
 *   ws.replay(lastSeenIso);
 *   ws.close();
 *
 * Reconnects with exponential backoff. The last-seen change_log timestamp
 * is kept in IndexedDB so a reconnect (or PWA cold-start) can replay missed
 * events.
 */

const DB_NAME = 'glm';
const CURSOR_STORE = 'workspace-cursors';

export function openWorkspaceSocket(workspaceId, { onEvent, onStatus } = {}) {
  let socket = null;
  let attempts = 0;
  let closed = false;

  function url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws/${workspaceId}`;
  }

  async function connect() {
    if (closed) return;
    try {
      socket = new WebSocket(url());
    } catch (err) {
      scheduleReconnect();
      return;
    }
    socket.addEventListener('open', async () => {
      attempts = 0;
      onStatus?.({ state: 'open' });
      const since = await readCursor(workspaceId);
      if (since) socket.send(JSON.stringify({ type: 'replay', since }));
    });
    socket.addEventListener('message', (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      onEvent?.(msg);
      if (msg.ts) writeCursor(workspaceId, msg.ts).catch(() => {});
    });
    socket.addEventListener('close', () => {
      onStatus?.({ state: 'closed' });
      scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      onStatus?.({ state: 'error' });
    });
  }

  function scheduleReconnect() {
    if (closed) return;
    const delay = Math.min(30_000, 1_000 * 2 ** attempts++);
    setTimeout(connect, delay);
  }

  function ping() {
    socket?.readyState === 1 && socket.send(JSON.stringify({ type: 'ping' }));
  }

  function replay(since) {
    socket?.readyState === 1 && socket.send(JSON.stringify({ type: 'replay', since }));
  }

  function close() {
    closed = true;
    socket?.close();
  }

  connect();
  return { ping, replay, close };
}

// ---- IndexedDB cursor persistence ------------------------------------------

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CURSOR_STORE)) {
        db.createObjectStore(CURSOR_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function readCursor(workspaceId) {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CURSOR_STORE, 'readonly');
      const req = tx.objectStore(CURSOR_STORE).get(workspaceId);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function writeCursor(workspaceId, ts) {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CURSOR_STORE, 'readwrite');
      tx.objectStore(CURSOR_STORE).put(ts, workspaceId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}
