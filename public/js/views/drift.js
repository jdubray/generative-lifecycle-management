import { api } from '../api.js';
import { el, empty, hash, kv, section } from '../components/index.js';

/**
 * View 06 — Drift Reconciliation.
 *
 * AC-23: "Run full sweep" runs the server-side sweep job.
 * AC-24: "Reconcile all auto-heal" calls the bulk endpoint.
 * AC-25: "Capture as SCR" pre-fills the SCR form with class=II + the node id.
 * AC-26: waiver requires a duration in days (client + server both enforce).
 * AC-27: the reconciliation triplet always shows three hashes, even when Synced.
 */
export function driftView(ctx) {
  const root = el('section', { class: 'view view-drift' });
  root.appendChild(
    el(
      'div',
      { class: 'view-header' },
      el('span', { class: 'view-id mono' }, '06'),
      el('h1', {}, 'Drift Reconciliation'),
    ),
  );

  const toolbar = el('div', { class: 'toolbar' });
  const sweepBtn = el('button', { class: 'primary' }, 'Run full sweep');
  sweepBtn.addEventListener('click', runSweep);
  toolbar.appendChild(sweepBtn);
  const healBtn = el('button', {}, 'Reconcile all auto-heal');
  healBtn.addEventListener('click', runBulkHeal);
  toolbar.appendChild(healBtn);

  const filterSel = el('select');
  for (const o of ['All', 'Synced', 'Hash-Drifted', 'Live-Drifted', 'Suspended']) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o;
    filterSel.appendChild(opt);
  }
  filterSel.addEventListener('change', renderList);
  toolbar.appendChild(filterSel);
  root.appendChild(toolbar);

  const split = el('div', { class: 'split' });
  const listPane = el('div', { class: 'drift-list' });
  const detailPane = el('div', { class: 'drift-detail' });
  split.append(listPane, detailPane);
  root.appendChild(split);

  let records = [];
  let selectedId = null;

  async function load() {
    try {
      const data = await api.listDrift(ctx.workspaceId);
      records = data.drift ?? [];
      renderList();
      if (records.length > 0) select(records[0].id);
      else detailPane.appendChild(empty('No drift records.'));
    } catch (err) {
      listPane.appendChild(el('div', { class: 'banner offline' }, err.message));
    }
  }

  function renderList() {
    listPane.replaceChildren();
    const filter = filterSel.value;
    const filtered = filter === 'All' ? records : records.filter((r) => r.status === filter);
    if (filtered.length === 0) {
      listPane.appendChild(empty('Nothing here yet.'));
      return;
    }
    const tbody = el('tbody');
    for (const r of filtered) {
      const row = el(
        'tr',
        {},
        el('td', { class: 'mono' }, r.file),
        el('td', {}, el('span', { class: `pill ${pillFor(r.status)}` }, r.status)),
        el('td', {}, el('span', { class: 'tag' }, r.policy)),
      );
      row.addEventListener('click', () => select(r.id));
      if (r.id === selectedId) row.classList.add('selected');
      tbody.appendChild(row);
    }
    listPane.appendChild(
      el(
        'table',
        { class: 'table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'File'), el('th', {}, 'Status'), el('th', {}, 'Policy'))),
        tbody,
      ),
    );
  }

  function select(id) {
    selectedId = id;
    renderList();
    const r = records.find((x) => x.id === id);
    if (!r) return;
    renderDetail(r);
  }

  function renderDetail(r) {
    detailPane.replaceChildren();
    detailPane.appendChild(
      el(
        'div',
        { class: 'detail-header' },
        el('h2', {}, r.file),
        el('div', { class: 'detail-header-row' }, el('span', { class: `pill ${pillFor(r.status)}` }, r.status), el('span', { class: 'tag' }, r.kind), el('span', { class: 'tag' }, r.policy)),
        el('div', { class: 'mono muted' }, `Node ${r.nodeId} · detected ${r.detectedAt}`),
      ),
    );

    // AC-27: always show all three hashes — desired, observed, and the status.
    detailPane.appendChild(
      section(
        { title: 'Reconciliation triplet' },
        kv([
          ['desired_hash', hash(r.desiredHash ?? null)],
          ['observed_hash', hash(r.observedHash ?? null)],
          ['status', r.status],
        ]),
      ),
    );

    if (r.detail) {
      detailPane.appendChild(section({ title: 'Detail' }, el('p', {}, r.detail)));
    }

    // Resolution actions
    const actions = el('div', { class: 'detail-actions' });
    const button = (label, primary, onClick) => {
      const b = el('button', primary ? { class: 'primary' } : {}, label);
      b.addEventListener('click', onClick);
      return b;
    };
    actions.appendChild(button('Heal', true, () => resolve(r.id, { action: 'heal' })));
    actions.appendChild(
      button('Capture as SCR', false, () => {
        // AC-25: navigate to Change Management with the node prefilled and class=II.
        location.hash = `#/changes?target=${encodeURIComponent(r.nodeId)}`;
      }),
    );
    actions.appendChild(
      button('Issue waiver', false, () => {
        const days = Number(prompt('Waiver duration in days?', '7'));
        // AC-26: refuse to send a waiver without a positive duration.
        if (!Number.isFinite(days) || days <= 0) {
          return alert('Waiver requires a positive duration.');
        }
        resolve(r.id, { action: 'waiver', durationDays: days });
      }),
    );
    actions.appendChild(button('Suspend', false, () => resolve(r.id, { action: 'suspend' })));
    detailPane.appendChild(section({ title: 'Resolution' }, actions));
  }

  async function resolve(id, body) {
    try {
      const res = await api.resolveDrift(ctx.workspaceId, id, body);
      const idx = records.findIndex((r) => r.id === id);
      if (idx >= 0) records[idx] = res.drift;
      renderList();
      select(id);
    } catch (err) {
      alert(err.message);
    }
  }

  async function runSweep() {
    try {
      await api.sweepDrift(ctx.workspaceId);
      await load();
    } catch (err) {
      alert(err.message);
    }
  }

  async function runBulkHeal() {
    try {
      const res = await api.bulkAutoHeal(ctx.workspaceId);
      alert(`Healed ${res.healed} of ${res.candidates} eligible records.`);
      await load();
    } catch (err) {
      alert(err.message);
    }
  }

  load();
  return { element: root };
}

function pillFor(status) {
  switch (status) {
    case 'Synced':
      return 'released';
    case 'Hash-Drifted':
    case 'Live-Drifted':
      return 'drift';
    case 'Suspended':
      return 'outline';
    default:
      return 'outline';
  }
}
