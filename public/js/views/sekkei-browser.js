import { api } from '../api.js';
import { el, hash, kv, section, statusPill, stratumTag, yamlBlock, empty } from '../components/index.js';

/**
 * View 01 — Sekkei Browser.
 *
 * Two-pane layout. Left: filterable tree, grouped by stratum + composes-of
 * relationships. Right: detail for the selected node. AC-01 covers
 * scroll-to-top on selection; AC-02 navigates to where-used; AC-04 makes
 * derives_from clickable; AC-05 truncates content_hash with full tooltip.
 */

const STRATUM_ORDER = ['system', 'capability', 'component', 'interaction', 'spec'];
const STRATUM_SHORT = { system: 'S', capability: 'C', component: 'O', interaction: 'I', spec: 'P' };
export function sekkeiBrowserView(ctx, params = {}) {
  const root = el('section', { class: 'view view-sekkei' });
  root.appendChild(
    el(
      'div',
      { class: 'view-header' },
      el('span', { class: 'view-id mono' }, '01'),
      el('h1', {}, 'Sekkei Browser'),
    ),
  );
  const split = el('div', { class: 'split' });
  const treePane = el('div', { class: 'tree-pane' });
  const detailPane = el('div', { class: 'detail-pane' });
  split.append(treePane, detailPane);
  root.appendChild(split);

  let nodes = [];
  let selectedGlm = params.glm ?? null;
  let filter = '';
  /** glmId → bool. Missing key defaults to expanded. */
  const expanded = new Map();
  // Which stratum level the user last applied a bulk expand-to via the
  // [S][C][O][I][P] buttons. Index into STRATUM_ORDER. `spec` (4) = fully
  // open by default, matching the natural state of the `expanded` map.
  let activeLevel = 4;

  function renderTree() {
    treePane.replaceChildren();
    const toolbar = el('div', { class: 'toolbar' });
    const search = el('input', { type: 'search', placeholder: 'filter nodes…', value: filter });
    search.addEventListener('input', (e) => {
      filter = e.target.value.trim().toLowerCase();
      renderRows();
    });
    // Stratum-level buttons [S][C][O][I][P]. Clicking [O] opens the tree
    // down to the component layer: every node whose stratum sits ABOVE
    // the target is expanded so children stay visible; every node whose
    // stratum is AT or BELOW the target is collapsed so deeper layers
    // are hidden. The currently-active level keeps a colored outline.
    const levelBar = el('div', { class: 'level-buttons' });
    for (let i = 0; i < STRATUM_ORDER.length; i++) {
      const stratum = STRATUM_ORDER[i];
      const btn = el(
        'button',
        {
          class: `level-btn level-btn-${stratum}${i === activeLevel ? ' active' : ''}`,
          title: `Expand tree down to ${stratum} level`,
          type: 'button',
        },
        STRATUM_SHORT[stratum],
      );
      btn.addEventListener('click', () => applyLevel(i));
      levelBar.appendChild(btn);
    }
    toolbar.append(search, levelBar);
    treePane.appendChild(toolbar);
    const list = el('div', { class: 'tree' });
    treePane.appendChild(list);

    function applyLevel(level) {
      activeLevel = level;
      // The level acts as a HARD visibility cap: any node whose stratum
      // index exceeds `activeLevel` is filtered out at render time (see
      // renderTreeRow). We also reset per-row collapse state so the cap
      // is immediately visible — the user can still drill into individual
      // rows via the carets afterwards, but only within the cap.
      expanded.clear();
      renderTree();
    }

    function renderRows() {
      list.replaceChildren();
      if (nodes.length === 0) {
        list.appendChild(empty('No nodes in this workspace yet.'));
        return;
      }
      const { roots, childrenByParent } = buildHierarchy(nodes);
      const matchSet = filter ? matchClosure(nodes, childrenByParent, filter) : null;
      if (matchSet && matchSet.size === 0) {
        list.appendChild(empty('No nodes match.'));
        return;
      }
      for (const root of roots) renderTreeRow(list, root, 0, childrenByParent, matchSet);
    }
    renderRows();
  }

  function renderTreeRow(container, node, depth, childrenByParent, matchSet) {
    if (matchSet && !matchSet.has(node.glmId)) return;
    // Hard stratum cap from the [S][C][O][I][P] selector — never render a
    // node whose stratum sits below the current level. The cap also hides
    // any deeper children, even if their parent row claims to be expanded.
    const nodeIdx = STRATUM_ORDER.indexOf(node.stratum);
    if (nodeIdx > activeLevel) return;
    const allKids = childrenByParent.get(node.glmId) ?? [];
    const kids = allKids.filter((k) => {
      const i = STRATUM_ORDER.indexOf(k.stratum);
      return i === -1 || i <= activeLevel;
    });
    const isOpen = expanded.get(node.glmId) !== false; // default open
    const hasKids = kids.length > 0;
    const caret = el(
      'span',
      // Use `caret-leaf` (not `empty`) for the no-children variant: the bare
      // `.empty` class is a view-level helper (min-height: 240px, padding: 36px)
      // and would otherwise stretch every leaf row to 240px tall.
      { class: `caret${hasKids ? '' : ' caret-leaf'}` },
      hasKids ? (isOpen ? '▾' : '▸') : '·',
    );
    if (hasKids) {
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        expanded.set(node.glmId, !isOpen);
        const treeList = container.closest('.tree') ?? container;
        // Re-render only the tree list; toolbar state is unaffected.
        treeList.replaceChildren();
        const { roots, childrenByParent: cbp } = buildHierarchy(nodes);
        const ms = filter ? matchClosure(nodes, cbp, filter) : null;
        for (const r of roots) renderTreeRow(treeList, r, 0, cbp, ms);
      });
    }
    const row = el(
      'div',
      {
        class: `row${selectedGlm === node.glmId ? ' selected' : ''}`,
        style: `padding-left: ${6 + depth * 16}px`,
      },
      caret,
      stratumTag(node.stratum),
      el('span', { class: 'title' }, node.title || node.glmId),
      el('span', { class: 'rev' }, `${node.revisionMajor}.${node.revisionIteration}`),
      statusPill(node.revisionStatus),
    );
    row.addEventListener('click', () => select(node.glmId));
    container.appendChild(row);
    if (hasKids && isOpen) {
      for (const child of kids) renderTreeRow(container, child, depth + 1, childrenByParent, matchSet);
    }
  }

  async function select(glmId) {
    selectedGlm = glmId;
    history.replaceState(null, '', `#/sekkei?glm=${encodeURIComponent(glmId)}`);
    renderTree();
    detailPane.replaceChildren(el('div', { class: 'loading' }, 'Loading node…'));
    try {
      const data = await api.getNode(ctx.workspaceId, glmId);
      renderDetail(data);
      // AC-01: scroll the right pane to the top whenever a node is selected.
      detailPane.scrollTop = 0;
    } catch (err) {
      detailPane.replaceChildren(empty(err.message ?? 'failed to load'));
    }
  }

  function renderDetail({ node, parameters, constraints, relationships }) {
    detailPane.replaceChildren();
    const header = el(
      'div',
      { class: 'detail-header' },
      el(
        'div',
        { class: 'detail-header-row' },
        stratumTag(node.stratum),
        statusPill(node.revisionStatus),
        el('span', { class: 'mono muted' }, `${node.revisionMajor}.${node.revisionIteration}`),
        el('span', { class: 'tag' }, node.overrideKind),
      ),
      el('h2', {}, node.title || node.glmId),
      el('div', { class: 'mono muted' }, node.glmId),
      el('p', {}, node.description || ''),
      el(
        'div',
        { class: 'detail-actions' },
        el(
          'button',
          {
            class: 'primary',
            onClick: () => {
              // AC-02: navigate to where-used with this node as the target.
              location.hash = `#/where-used?glm=${encodeURIComponent(node.glmId)}`;
            },
          },
          'Where used →',
        ),
      ),
    );
    detailPane.appendChild(header);

    // Envelope (AC-04: derives_from is clickable if present; AC-05: hash component).
    const derivesFromControl = node.derivesFromNodeId
      ? (() => {
          const parent = nodes.find((n) => n.id === node.derivesFromNodeId);
          if (!parent) return el('span', { class: 'mono muted' }, node.derivesFromNodeId);
          const link = el('a', { href: `#/sekkei?glm=${encodeURIComponent(parent.glmId)}` }, parent.glmId);
          link.addEventListener('click', (e) => {
            e.preventDefault();
            select(parent.glmId);
          });
          return link;
        })()
      : el('span', { class: 'muted2' }, '—');

    detailPane.appendChild(
      section(
        { title: 'Envelope' },
        kv([
          ['id', el('span', { class: 'mono' }, node.glmId)],
          ['stratum', node.stratum],
          ['revision', `${node.revisionMajor}.${node.revisionIteration}`],
          ['status', statusPill(node.revisionStatus)],
          ['override_kind', node.overrideKind],
          ['derives_from', derivesFromControl],
          ['content_hash', hash(node.contentHash)],
          ['authored_by', node.authoredBy],
        ]),
      ),
    );

    if (parameters?.length) {
      const rows = parameters.map((p) =>
        el(
          'tr',
          {},
          el('td', { class: 'mono' }, p.name),
          el('td', {}, p.type),
          el('td', { class: 'mono' }, JSON.stringify(p.defaultValue ?? null)),
          el('td', {}, p.bindingScope),
        ),
      );
      const table = el(
        'table',
        { class: 'table' },
        el(
          'thead',
          {},
          el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Type'), el('th', {}, 'Default'), el('th', {}, 'Scope')),
        ),
        el('tbody', {}, ...rows),
      );
      detailPane.appendChild(section({ title: `Parameters (${parameters.length})` }, table));
    }

    if (constraints?.length) {
      const list = el('div', { class: 'constraints' });
      for (const c of constraints) {
        list.appendChild(
          el(
            'div',
            { class: 'constraint-row' },
            el('span', { class: 'tag' }, c.kind),
            el('span', { class: `pill ${c.severity === 'error' ? 'warn' : 'outline'}` }, c.severity),
            el('code', { class: 'mono' }, c.expression),
          ),
        );
      }
      detailPane.appendChild(section({ title: `Constraints (${constraints.length})` }, list));
    }

    detailPane.appendChild(section({ title: 'Body' }, renderBody(node.body)));

    if (relationships?.length) {
      const list = el('div', { class: 'relationships' });
      for (const r of relationships) {
        const link = el(
          'a',
          { href: `#/sekkei?glm=${encodeURIComponent(r.targetGlmId)}` },
          r.targetGlmId,
        );
        link.addEventListener('click', (e) => {
          e.preventDefault();
          select(r.targetGlmId);
        });
        list.appendChild(
          el(
            'div',
            { class: 'rel-row' },
            el('span', { class: 'tag' }, r.kind),
            link,
          ),
        );
      }
      detailPane.appendChild(section({ title: `Relationships (${relationships.length})` }, list));
    }
  }

  async function loadNodes() {
    treePane.appendChild(el('div', { class: 'loading' }, 'Loading nodes…'));
    try {
      const data = await api.listNodes(ctx.workspaceId, { include: 'relationships' });
      nodes = data.nodes ?? [];
      renderTree();
      if (selectedGlm) await select(selectedGlm);
      else if (nodes.length > 0) await select(nodes[0].glmId);
      else detailPane.appendChild(empty('No nodes in this workspace yet.'));
    } catch (err) {
      treePane.appendChild(el('div', { class: 'banner offline' }, `Failed: ${err.message}`));
    }
  }
  loadNodes();

  return { element: root };
}

/**
 * Build a composes-of hierarchy from a flat node list.
 *
 * - `childrenByParent`: parent glmId → ordered child nodes.
 * - `roots`: nodes that are not targeted by any composes-of edge. We fall back
 *   to stratum order (system → spec) for ties so screens stay deterministic.
 *
 * Nodes that lack `relationships` on the wire still appear — just as roots.
 */
function buildHierarchy(nodes) {
  const byGlm = new Map(nodes.map((n) => [n.glmId, n]));
  const childrenByParent = new Map();
  const childIds = new Set();
  for (const n of nodes) {
    const rels = n.relationships ?? [];
    for (const r of rels) {
      if (r.kind !== 'composes-of') continue;
      if (!byGlm.has(r.targetGlmId)) continue; // dangling — ignore for tree purposes
      const list = childrenByParent.get(n.glmId) ?? [];
      list.push(byGlm.get(r.targetGlmId));
      childrenByParent.set(n.glmId, list);
      childIds.add(r.targetGlmId);
    }
  }

  // Fallback: any node that has no inbound composes-of edge AND whose glmId is
  // namespaced under another node (e.g. `…component.spec.functional`) gets
  // attached to its longest matching ancestor. This recovers the implicit
  // parent that the source YAML expressed only via naming convention.
  // System-stratum nodes are never re-parented (they're the legitimate roots).
  const sortedByLengthDesc = [...byGlm.keys()].sort((a, b) => b.length - a.length);
  for (const n of nodes) {
    if (n.stratum === 'system') continue;
    if (childIds.has(n.glmId)) continue;
    const parentGlmId = findGlmIdPrefixParent(n.glmId, sortedByLengthDesc);
    if (!parentGlmId) continue;
    const list = childrenByParent.get(parentGlmId) ?? [];
    list.push(n);
    childrenByParent.set(parentGlmId, list);
    childIds.add(n.glmId);
  }

  const stratumOrder = { system: 0, capability: 1, component: 2, interaction: 3, spec: 4 };
  const roots = nodes
    .filter((n) => !childIds.has(n.glmId))
    .sort((a, b) => (stratumOrder[a.stratum] ?? 9) - (stratumOrder[b.stratum] ?? 9));
  return { roots, childrenByParent };
}

/**
 * Return the longest glmId from `candidates` that is a strict dot-segment
 * prefix of `glmId`. e.g. parent of
 *   kizo:web.todomvc.web_ui.add_todo_input.spec.functional
 * is
 *   kizo:web.todomvc.web_ui.add_todo_input
 * Returns null if no candidate matches.
 */
function findGlmIdPrefixParent(glmId, candidates) {
  for (const cand of candidates) {
    if (cand === glmId) continue;
    if (cand.length >= glmId.length) continue;
    if (glmId.startsWith(cand + '.')) return cand;
  }
  return null;
}

/**
 * Closure used to keep ancestors visible when the user filters in tree mode:
 * if any descendant matches the filter, every ancestor stays in the result set
 * so the matched row's path is reachable.
 */
function matchClosure(nodes, childrenByParent, filter) {
  const direct = new Set(
    nodes
      .filter((n) => `${n.glmId} ${n.title}`.toLowerCase().includes(filter))
      .map((n) => n.glmId),
  );
  if (direct.size === 0) return direct;
  // Reverse map child → parent for path-up.
  const parentOf = new Map();
  for (const [parent, kids] of childrenByParent) {
    for (const k of kids) parentOf.set(k.glmId, parent);
  }
  const keep = new Set(direct);
  for (const id of direct) {
    let p = parentOf.get(id);
    while (p) {
      if (keep.has(p)) break;
      keep.add(p);
      p = parentOf.get(p);
    }
  }
  // Also keep descendants of a matched ancestor so the user can drill in.
  const stack = [...direct];
  while (stack.length) {
    const cur = stack.pop();
    const kids = childrenByParent.get(cur) ?? [];
    for (const k of kids) {
      if (!keep.has(k.glmId)) {
        keep.add(k.glmId);
        stack.push(k.glmId);
      }
    }
  }
  return keep;
}

/**
 * Render `body_json` as a structured field list rather than a JSON dump.
 * Top-level scalars and strings show in a 2-column key/value grid;
 * arrays of scalars show as bullet lists; nested objects or arrays of
 * objects fall back to a YAML block under the key so the structure
 * stays inspectable.
 */
function renderBody(body) {
  if (body === null || body === undefined) return empty('No body.');
  if (typeof body !== 'object') return yamlBlock(String(body));
  const entries = Object.entries(body);
  if (entries.length === 0) return empty('Body is empty.');

  const wrap = el('div', { class: 'body-fields' });
  for (const [key, value] of entries) {
    wrap.appendChild(
      el(
        'div',
        { class: 'body-field' },
        el('div', { class: 'body-field-key mono' }, key),
        renderBodyValue(value),
      ),
    );
  }
  return wrap;
}

function renderBodyValue(value) {
  if (value === null || value === undefined) {
    return el('div', { class: 'body-field-value muted2' }, '—');
  }
  if (typeof value === 'string') {
    return el('div', { class: 'body-field-value body-field-value--text' }, value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return el('div', { class: 'body-field-value mono' }, String(value));
  }
  if (Array.isArray(value)) {
    const scalar = value.every(
      (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v),
    );
    if (scalar) {
      const ul = el('ul', { class: 'body-field-list' });
      for (const v of value) ul.appendChild(el('li', {}, v === null ? '—' : String(v)));
      return ul;
    }
  }
  // Nested object or array of objects — show the original structure.
  return yamlBlock(JSON.stringify(value, null, 2));
}
