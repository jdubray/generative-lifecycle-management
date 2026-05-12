import { api } from '../api.js';
import { el, section, statusPill, stratumTag, empty } from '../components/index.js';

/**
 * View 04 — Where-Used.
 *
 * Pre-selects the node passed via `?glm=<glm_id>` (AC-15). Left pane picks
 * the target; right pane shows direct dependents (composes-of first, AC-16),
 * transitive consumers with depth, and an empty-state message (AC-17).
 */
export function whereUsedView(ctx, params = {}) {
  const root = el('section', { class: 'view view-whereused' });
  root.appendChild(
    el(
      'div',
      { class: 'view-header' },
      el('span', { class: 'view-id mono' }, '04'),
      el('h1', {}, 'Where-Used'),
    ),
  );
  const split = el('div', { class: 'split' });
  const pickerPane = el('div', { class: 'picker-pane' });
  const analysisPane = el('div', { class: 'analysis-pane' });
  split.append(pickerPane, analysisPane);
  root.appendChild(split);

  let nodes = [];
  let target = params.glm ?? null;

  function renderPicker() {
    pickerPane.replaceChildren(
      el('div', { class: 'toolbar' }, el('input', { type: 'search', placeholder: 'find a node…', id: 'wu-filter' })),
    );
    const list = el('div', { class: 'tree' });
    pickerPane.appendChild(list);
    let q = '';
    pickerPane.querySelector('#wu-filter')?.addEventListener('input', (e) => {
      q = e.target.value.toLowerCase().trim();
      renderRows();
    });

    function renderRows() {
      list.replaceChildren();
      const items = q ? nodes.filter((n) => `${n.glmId} ${n.title}`.toLowerCase().includes(q)) : nodes;
      for (const n of items) {
        const row = el(
          'div',
          { class: `row${target === n.glmId ? ' selected' : ''}` },
          el('span', { class: 'caret' }, '·'),
          stratumTag(n.stratum),
          el('span', { class: 'title' }, n.title || n.glmId),
          el('span', { class: 'rev' }, `${n.revisionMajor}.${n.revisionIteration}`),
          statusPill(n.revisionStatus),
        );
        row.addEventListener('click', () => select(n.glmId));
        list.appendChild(row);
      }
    }
    renderRows();
  }

  async function select(glmId) {
    target = glmId;
    history.replaceState(null, '', `#/where-used?glm=${encodeURIComponent(glmId)}`);
    renderPicker();
    analysisPane.replaceChildren(el('div', { class: 'loading' }, 'Computing where-used…'));
    try {
      const res = await api.whereUsed(ctx.workspaceId, glmId);
      renderAnalysis(res);
    } catch (err) {
      analysisPane.replaceChildren(empty(err.message));
    }
  }

  function renderAnalysis(res) {
    analysisPane.replaceChildren();
    const target = nodes.find((n) => n.glmId === res.target);
    analysisPane.appendChild(
      el(
        'div',
        { class: 'wu-target' },
        target ? stratumTag(target.stratum) : null,
        el('h2', {}, target?.title ?? res.target),
        el('div', { class: 'mono muted' }, res.target),
      ),
    );

    // Direct dependents (AC-16: composes-of first; already sorted server-side).
    const directRows = res.direct.map((d) =>
      el(
        'tr',
        {},
        el('td', {}, el('span', { class: 'tag' }, d.kind)),
        el('td', {}, stratumTag(d.source.stratum)),
        el(
          'td',
          {},
          (() => {
            const a = el('a', { href: `#/sekkei?glm=${encodeURIComponent(d.source.glmId)}` }, d.source.title || d.source.glmId);
            return a;
          })(),
        ),
        el('td', { class: 'mono' }, `${d.source.revisionMajor}.${d.source.revisionIteration}`),
        el('td', {}, statusPill(d.source.revisionStatus)),
      ),
    );
    const directTable = el(
      'table',
      { class: 'table' },
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', {}, 'Kind'),
          el('th', {}, 'Stratum'),
          el('th', {}, 'Source'),
          el('th', {}, 'Rev'),
          el('th', {}, 'Status'),
        ),
      ),
      el('tbody', {}, ...directRows),
    );
    analysisPane.appendChild(
      section(
        { title: `Direct dependents (${res.direct.length})` },
        res.direct.length === 0 ? empty('Nothing references this node directly.') : directTable,
      ),
    );

    // Transitive consumers
    if (res.transitive.length === 0) {
      analysisPane.appendChild(
        section(
          { title: 'Transitive consumers' },
          empty('No transitive consumers — this node has no upstream dependents.'),
        ),
      );
    } else {
      const list = el('div', { class: 'tree' });
      for (const t of res.transitive) {
        const row = el(
          'div',
          { class: 'row', style: `padding-left: ${8 + t.depth * 16}px` },
          stratumTag(t.source.stratum),
          (() => {
            const link = el(
              'a',
              { href: `#/where-used?glm=${encodeURIComponent(t.source.glmId)}` },
              t.source.title || t.source.glmId,
            );
            link.addEventListener('click', (e) => {
              e.preventDefault();
              select(t.source.glmId);
            });
            return link;
          })(),
          el('span', { class: 'rev' }, `${t.source.revisionMajor}.${t.source.revisionIteration}`),
        );
        list.appendChild(row);
      }
      analysisPane.appendChild(section({ title: `Transitive consumers (${res.transitive.length})` }, list));
    }
  }

  async function loadNodes() {
    pickerPane.appendChild(el('div', { class: 'loading' }, 'Loading nodes…'));
    try {
      const data = await api.listNodes(ctx.workspaceId);
      nodes = data.nodes ?? [];
      renderPicker();
      if (target) await select(target);
      else if (nodes.length > 0) await select(nodes[0].glmId);
      else analysisPane.appendChild(empty('No nodes yet.'));
    } catch (err) {
      pickerPane.appendChild(el('div', { class: 'banner offline' }, `Failed: ${err.message}`));
    }
  }
  loadNodes();

  return { element: root };
}
