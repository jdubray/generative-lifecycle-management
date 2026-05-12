/**
 * Offline write queue.
 *
 * The PWA service worker is read-through; mutations must succeed against the
 * server. While the network is unreachable, write actions are stored in
 * IndexedDB and replayed when `online` fires.
 *
 *   const q = createOfflineQueue();
 *   await q.submit({ kind: 'createScr', request, body });
 *
 * A submission with a fresh network returns the server's response. While
 * offline, it returns `{ queued: true, id }` and resolves later when the
 * queue drains. Conflict handling on flush is the caller's responsibility:
 * `onConflict(item, response)` is invoked when the server returns 409/423.
 */

const DB_NAME = 'glm';
const STORE = 'write-queue';

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('workspace-cursors')) {
        db.createObjectStore('workspace-cursors');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const result = fn(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

export function createOfflineQueue({ onConflict, onFlushed } = {}) {
  let flushing = false;

  async function submit(item) {
    if (navigator.onLine) {
      try {
        return await execute(item);
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        // fall through to enqueue
      }
    }
    const id = `wq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const queued = { id, queuedAt: new Date().toISOString(), ...item };
    await withStore('readwrite', (s) => s.put(queued));
    return { queued: true, id };
  }

  async function flush() {
    if (flushing) return { drained: 0 };
    flushing = true;
    let drained = 0;
    try {
      const items = await list();
      for (const item of items) {
        try {
          const response = await execute(item);
          if (response?.error?.code === 'conflict' || response?.error?.code === 'locked') {
            onConflict?.(item, response);
            continue;
          }
          await withStore('readwrite', (s) => s.delete(item.id));
          drained++;
        } catch (err) {
          if (isNetworkError(err)) break;
          onConflict?.(item, { error: { message: err.message } });
          await withStore('readwrite', (s) => s.delete(item.id));
        }
      }
    } finally {
      flushing = false;
      onFlushed?.(drained);
    }
    return { drained };
  }

  async function list() {
    return withStore('readonly', (s) => {
      return new Promise((resolve, reject) => {
        const req = s.getAll();
        req.onsuccess = () => resolve(req.result ?? []);
        req.onerror = () => reject(req.error);
      });
    });
  }

  async function size() {
    return withStore('readonly', (s) => {
      return new Promise((resolve, reject) => {
        const req = s.count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    });
  }

  window.addEventListener('online', () => flush().catch(() => {}));

  return { submit, flush, list, size };
}

async function execute(item) {
  const init = {
    method: item.method,
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
  };
  if (item.body !== undefined) init.body = JSON.stringify(item.body);
  const res = await fetch(item.path, init);
  const text = await res.text();
  const json = text ? safeParse(text) : null;
  if (!res.ok) {
    return json ?? { error: { code: 'http', status: res.status } };
  }
  return json;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isNetworkError(err) {
  // fetch() throws TypeError on offline; treat anything not an ApiError-like
  // structured response as a network failure.
  return err instanceof TypeError;
}
