/**
 * Puffin GLM service worker.
 *
 * Strategy:
 *   - shell-precache: install fetches the core HTML/JS/CSS and primes the cache.
 *   - navigation: network-first, fall back to cached `/` on offline.
 *   - same-origin GET /api/v1/...: stale-while-revalidate so the offline read
 *     surface stays usable; mutations are never cached.
 *   - same-origin GET static asset: cache-first with background refresh.
 */

const VERSION = 'glm-v17';
const SHELL = [
  '/',
  '/public/styles/tokens.css',
  '/public/styles/app.css',
  '/public/js/app.js',
  '/public/js/api.js',
  '/public/js/store.js',
  '/public/js/ws.js',
  '/public/js/router.js',
  '/public/js/components/index.js',
  '/public/js/components/status-pill.js',
  '/public/js/components/stratum-tag.js',
  '/public/js/components/class-badge.js',
  '/public/js/components/hash.js',
  '/public/js/components/section.js',
  '/public/js/components/kv.js',
  '/public/js/components/diff-block.js',
  '/public/js/components/yaml-block.js',
  '/public/js/components/empty.js',
  '/public/js/views/dashboard.js',
  '/public/js/views/sekkei-browser.js',
  '/public/js/views/change-management.js',
  '/public/js/views/variants.js',
  '/public/js/views/where-used.js',
  '/public/js/views/effectivity.js',
  '/public/js/views/drift.js',
  '/public/js/views/reuse.js',
  '/public/js/views/provenance.js',
  '/public/js/views/vibe-mode.js',
  '/public/js/views/import.js',
  '/public/js/offline-queue.js',
  '/public/js/node-lock.js',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigation request → network-first, fall back to cached '/'
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/')),
    );
    return;
  }

  // API reads → stale-while-revalidate
  if (url.pathname.startsWith('/api/v1/')) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Static assets → cache-first
  if (url.pathname.startsWith('/public/') || url.pathname === '/manifest.json') {
    event.respondWith(cacheFirst(req));
  }
});

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req);
  if (cached) {
    refresh(cache, req).catch(() => {});
    return cached;
  }
  return refresh(cache, req).catch(() => new Response('offline', { status: 503 }));
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) return cached;
  const fresh = await network;
  return fresh ?? new Response('offline', { status: 503 });
}

async function refresh(cache, req) {
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}
