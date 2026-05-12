import { api, ApiError } from './api.js';
import { createStore } from './store.js';
import { createRouter } from './router.js';
import { openWorkspaceSocket } from './ws.js';
import { dashboardView } from './views/dashboard.js';
import { sekkeiBrowserView } from './views/sekkei-browser.js';
import { changeManagementView } from './views/change-management.js';
import { variantsView } from './views/variants.js';
import { whereUsedView } from './views/where-used.js';
import { effectivityView } from './views/effectivity.js';
import { driftView } from './views/drift.js';
import { reuseView } from './views/reuse.js';
import { provenanceView } from './views/provenance.js';
import { vibeModeView } from './views/vibe-mode.js';
import { importView } from './views/import.js';

/**
 * App entry point. Boots the shell:
 *   1. Resolve the authenticated user (or redirect to /login).
 *   2. Pick a workspace (URL ?workspace=slug, else the first one).
 *   3. Open a workspace WebSocket and pipe events into the store.
 *   4. Mount the router with the four read-only views.
 *   5. Register the service worker once everything else is up.
 */

const store = createStore({
  user: null,
  workspace: null,
  workspaces: [],
  online: navigator.onLine,
  socketState: 'closed',
  activity: [],
});

const NAV_ITEMS = [
  {
    group: 'Overview',
    items: [
      { num: '✦', label: 'Vibe Mode', path: '/vibe' },
      { num: '00', label: 'Dashboard', path: '/' },
    ],
  },
  {
    group: 'Design',
    items: [{ num: '01', label: 'Sekkei Browser', path: '/sekkei' }],
  },
  {
    group: 'Lifecycle',
    items: [
      { num: '02', label: 'Change Management', path: '/changes' },
      { num: '03', label: 'Variant Resolution', path: '/variants' },
      { num: '04', label: 'Where-Used', path: '/where-used' },
      { num: '05', label: 'Effectivity & Rollout', path: '/effectivity' },
      { num: '06', label: 'Drift Reconciliation', path: '/drift' },
      { num: '07', label: 'Reuse & Inheritance', path: '/reuse' },
      { num: '08', label: 'Provenance & Audit', path: '/provenance' },
    ],
  },
];

async function boot() {
  try {
    const me = await api.me();
    store.set({ user: me.user });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      location.replace('/login');
      return;
    }
    return showFatal(err.message);
  }

  let workspace;
  try {
    const list = await api.listWorkspaces();
    const params = new URLSearchParams(location.search);
    const slug = params.get('workspace');
    workspace = slug
      ? list.workspaces.find((w) => w.slug === slug) ?? list.workspaces[0]
      : list.workspaces[0];
    if (!workspace) {
      // No workspaces yet — drop the user straight into the import wizard.
      store.set({ workspaces: [] });
      renderTopbar();
      renderRail();
      location.hash = '#/import';
      const ctxImport = { workspaceId: null, workspace: null, store };
      const router = createRouter([
        { path: '/import', view: () => importView(ctxImport) },
        { path: '*', view: () => importView(ctxImport) },
      ]);
      router.start(document.getElementById('main'));
      return;
    }
    store.set({ workspace, workspaces: list.workspaces });
  } catch (err) {
    return showFatal(`Failed to load workspaces: ${err.message}`);
  }

  renderTopbar();
  renderRail();

  // WebSocket live updates
  openWorkspaceSocket(workspace.id, {
    onStatus: ({ state }) => store.set({ socketState: state }),
    onEvent: (ev) => {
      if (ev.type === 'welcome' || ev.type === 'pong' || ev.type === 'replay.start' || ev.type === 'replay.end') {
        return;
      }
      const cur = store.get().activity ?? [];
      store.set({ activity: [shapeEvent(ev), ...cur].slice(0, 60) });
    },
  });

  window.addEventListener('online', () => store.set({ online: true }));
  window.addEventListener('offline', () => store.set({ online: false }));

  store.subscribe(renderTopbar);

  const ctx = { workspaceId: workspace.id, workspace, store };
  const router = createRouter([
    { path: '/', view: () => dashboardView(ctx) },
    { path: '/vibe', view: () => vibeModeView(ctx) },
    { path: '/sekkei', view: (params) => sekkeiBrowserView(ctx, params) },
    { path: '/changes', view: (params) => changeManagementView(ctx, params) },
    { path: '/variants', view: () => variantsView(ctx) },
    { path: '/where-used', view: (params) => whereUsedView(ctx, params) },
    { path: '/effectivity', view: () => effectivityView(ctx) },
    { path: '/drift', view: () => driftView(ctx) },
    { path: '/reuse', view: () => reuseView(ctx) },
    { path: '/provenance', view: (params) => provenanceView(ctx, params) },
    { path: '/import', view: () => importView(ctx) },
    { path: '*', view: () => fallbackView() },
  ]);
  const mount = document.getElementById('main');
  router.start(mount);

  // Service worker — register late so we don't compete with the first paint.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

function renderTopbar() {
  const { user, workspace, workspaces, online, socketState } = store.get();
  const topbarProject = document.getElementById('topbar-project');
  if (topbarProject) {
    topbarProject.replaceChildren();
    // Workspace switcher — populated from the workspaces array loaded at boot.
    const select = document.createElement('select');
    select.className = 'mono ws-switcher';
    for (const w of workspaces ?? []) {
      const opt = document.createElement('option');
      opt.value = w.slug;
      opt.textContent = `glm:${w.slug}`;
      if (workspace && w.slug === workspace.slug) opt.selected = true;
      select.appendChild(opt);
    }
    const importOpt = document.createElement('option');
    importOpt.value = '__import__';
    importOpt.textContent = '+ Import sekkei…';
    select.appendChild(importOpt);
    select.addEventListener('change', (e) => {
      const next = e.target.value;
      if (next === '__import__') {
        location.hash = '#/import';
        // Reset the select so the chip doesn't show "+ Import sekkei…".
        e.target.value = workspace?.slug ?? '';
        return;
      }
      if (next && next !== workspace?.slug) {
        // Reload so the WebSocket connection is rebuilt against the new id.
        const url = new URL(location.href);
        url.searchParams.set('workspace', next);
        url.hash = '#/';
        location.assign(url.toString());
      }
    });
    topbarProject.appendChild(select);
    topbarProject.appendChild(spanWith('rev mono', workspace ? `@ ${workspace.id.slice(0, 8)}` : '—'));
  }

  const userEl = document.getElementById('topbar-user');
  if (userEl) userEl.textContent = user?.email ?? '…';

  const lockEl = document.getElementById('topbar-lock');
  if (lockEl) {
    const ok = online && socketState === 'open';
    lockEl.querySelector('.dot').style.background = ok ? 'var(--st-released)' : 'var(--st-drift)';
    const text = !online ? 'offline' : socketState === 'open' ? 'live' : socketState;
    lockEl.querySelector('span:last-child').textContent = text;
  }
}

function renderRail() {
  const rail = document.getElementById('rail');
  if (!rail) return;
  rail.replaceChildren();
  for (const group of NAV_ITEMS) {
    const head = document.createElement('div');
    head.className = 'group';
    head.textContent = group.group;
    rail.appendChild(head);
    for (const item of group.items) {
      const a = document.createElement('a');
      a.href = `#${item.path}`;
      a.dataset.path = item.path;
      a.appendChild(spanWith('num mono', item.num));
      a.appendChild(spanWith('label', item.label));
      rail.appendChild(a);
    }
  }
  updateRailActive();
  document.addEventListener('glm:navigate', updateRailActive);
}

function updateRailActive() {
  const current = (location.hash.slice(1).split('?')[0]) || '/';
  for (const a of document.querySelectorAll('#rail a')) {
    a.classList.toggle('active', a.dataset.path === current);
  }
}

function shapeEvent(ev) {
  return {
    ts: ev.ts ?? new Date().toISOString(),
    op: ev.type,
    subject:
      ev.payload?.node?.glmId ??
      ev.payload?.scrId ??
      ev.payload?.driftId ??
      ev.payload?.provenanceId ??
      '(workspace)',
    userId: ev.payload?.userId ?? ev.payload?.by ?? '—',
  };
}

function spanWith(className, text) {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  return s;
}

function fallbackView() {
  const el = document.createElement('div');
  el.className = 'empty';
  el.innerHTML = 'Unknown view. <a href="#/">Go to Dashboard</a>.';
  return el;
}

function showFatal(message) {
  const main = document.getElementById('main');
  if (!main) return;
  main.innerHTML = '';
  const banner = document.createElement('div');
  banner.className = 'banner offline';
  banner.textContent = message;
  main.appendChild(banner);
}

boot();
