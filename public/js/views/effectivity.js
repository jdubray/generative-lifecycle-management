import { api } from '../api.js';
import { el, empty, kv, section, statusPill, stratumTag } from '../components/index.js';

/**
 * View 05 — Effectivity & Rollout.
 *
 * AC-19: per-node pin policy override persists; toggling variants reloads
 * the rollout list and the override map starts empty for that variant (AC-22).
 * AC-20: "Advance →" disabled when `pinRev === availableRev`.
 * AC-21: advancing emits a `rollout.advance` audit event (server-side).
 */
export function effectivityView(ctx) {
  const root = el('section', { class: 'view view-effectivity' });
  root.appendChild(
    el(
      'div',
      { class: 'view-header' },
      el('span', { class: 'view-id mono' }, '05'),
      el('h1', {}, 'Effectivity & Rollout'),
    ),
  );

  let variants = [];
  let currentVariantId = null;
  let rollout = [];
  let pinPolicyOverrides = {}; // per-variant, per-node

  const toolbar = el('div', { class: 'toolbar' });
  const summary = el('div', { class: 'summary' });
  const list = el('div', { class: 'rollout-list' });
  root.appendChild(toolbar);
  root.appendChild(summary);
  root.appendChild(list);

  async function selectVariant(variantId) {
    currentVariantId = variantId;
    // AC-22: per-node overrides are scoped to the variant we're looking at.
    pinPolicyOverrides = pinPolicyOverrides[variantId] ? pinPolicyOverrides : { ...pinPolicyOverrides, [variantId]: {} };
    try {
      const data = await api.getRollout(ctx.workspaceId, variantId);
      rollout = data.rollout ?? [];
      renderToolbar();
      renderSummary();
      renderList();
    } catch (err) {
      list.replaceChildren(el('div', { class: 'banner offline' }, err.message));
    }
  }

  function renderToolbar() {
    toolbar.replaceChildren();
    const sel = el('select');
    for (const v of variants) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `${v.label} (${v.channel})`;
      if (v.id === currentVariantId) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', (e) => selectVariant(e.target.value));
    toolbar.appendChild(sel);
    const variant = variants.find((v) => v.id === currentVariantId);
    if (variant) {
      toolbar.appendChild(el('span', { class: 'pill outline' }, variant.channel));
      toolbar.appendChild(el('span', { class: 'pill outline' }, variant.pinPolicyDefault));
    }
  }

  function renderSummary() {
    const pinned = rollout.filter((r) => r.pinRev).length;
    const advanceable = rollout.filter((r) => r.availableRev && r.pinRev !== r.availableRev).length;
    summary.replaceChildren(
      kv([
        ['Nodes pinned', String(pinned)],
        ['Advanceable', String(advanceable)],
        ['Total', String(rollout.length)],
      ]),
    );
  }

  function renderList() {
    list.replaceChildren();
    if (rollout.length === 0) {
      list.appendChild(empty('No rollout entries for this variant.'));
      return;
    }
    const tbody = el('tbody');
    for (const r of rollout) {
      const advanceable = r.availableRev && r.pinRev !== r.availableRev;
      const advanceBtn = (() => {
        const b = el('button', advanceable ? { class: 'primary' } : { disabled: 'disabled' }, 'Advance →');
        // AC-20: "Advance →" is disabled when the pin already matches available.
        if (advanceable) b.addEventListener('click', () => advance(r.nodeId));
        return b;
      })();
      const policySel = el('select');
      const overrideValue = pinPolicyOverrides[currentVariantId]?.[r.nodeId] ?? '';
      for (const p of ['', 'pin-on-release', 'track-latest', 'frozen']) {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p || '(default)';
        if (p === overrideValue) opt.selected = true;
        policySel.appendChild(opt);
      }
      policySel.addEventListener('change', async (e) => {
        const value = e.target.value || null;
        // AC-19: persist the override locally and to the server.
        pinPolicyOverrides[currentVariantId] = {
          ...(pinPolicyOverrides[currentVariantId] ?? {}),
          [r.nodeId]: value ?? '',
        };
        try {
          await api.setPinPolicy(ctx.workspaceId, currentVariantId, r.nodeId, value);
        } catch (err) {
          alert(err.message);
        }
      });
      tbody.appendChild(
        el(
          'tr',
          {},
          el('td', { class: 'mono' }, r.nodeId),
          el('td', { class: 'mono' }, r.availableRev ?? '—'),
          el('td', {}, policySel),
          el('td', { class: 'mono' }, r.pinRev ?? '—'),
          el('td', {}, el('span', { class: 'tag' }, r.state)),
          el('td', {}, advanceBtn),
        ),
      );
    }
    list.appendChild(
      el(
        'table',
        { class: 'table' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', {}, 'Node'),
            el('th', {}, 'Available'),
            el('th', {}, 'Policy'),
            el('th', {}, 'Pinned'),
            el('th', {}, 'State'),
            el('th', {}, 'Action'),
          ),
        ),
        tbody,
      ),
    );
  }

  async function advance(nodeId) {
    try {
      const res = await api.advanceRollout(ctx.workspaceId, currentVariantId, nodeId);
      const idx = rollout.findIndex((r) => r.nodeId === nodeId);
      if (idx >= 0) rollout[idx] = res.rollout;
      renderSummary();
      renderList();
    } catch (err) {
      alert(err.message);
    }
  }

  async function load() {
    try {
      const data = await api.listVariants(ctx.workspaceId);
      variants = data.variants ?? [];
      if (variants.length === 0) {
        toolbar.appendChild(empty('No variants in this workspace yet. Create one in Variant Resolution.'));
        return;
      }
      await selectVariant(variants[0].id);
    } catch (err) {
      toolbar.appendChild(el('div', { class: 'banner offline' }, err.message));
    }
  }
  load();

  return { element: root };
}
