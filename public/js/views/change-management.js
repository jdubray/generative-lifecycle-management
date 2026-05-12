import { api } from '../api.js';
import { classBadge, diffBlock, el, empty, kv, section, statusPill } from '../components/index.js';

/**
 * View 02 — Change Management.
 *
 * Left: filterable SCR list. Right: detail with transition buttons +
 * approvals + diff. The "New SCR" form pre-populates `targetNodes` from
 * the `?target=<glm_id>` query param (AC-06). Clicking a target node
 * navigates back to Sekkei Browser (AC-10). The token estimate in the
 * impact section recomputes when `targetNodes` changes (AC-09).
 */
export function changeManagementView(ctx, params = {}) {
  const root = el('section', { class: 'view view-changes' });
  root.appendChild(
    el(
      'div',
      { class: 'view-header' },
      el('span', { class: 'view-id mono' }, '02'),
      el('h1', {}, 'Change Management'),
      (() => {
        const btn = el('button', { class: 'primary' }, '+ New SCR');
        btn.addEventListener('click', () => openNewScrForm());
        return btn;
      })(),
    ),
  );

  const split = el('div', { class: 'split' });
  const listPane = el('div', { class: 'scr-list' });
  const detailPane = el('div', { class: 'scr-detail' });
  split.append(listPane, detailPane);
  root.appendChild(split);

  let scrs = [];
  let selectedId = params.scr ?? null;
  let filter = { cls: 'all', status: 'all' };

  function renderList() {
    listPane.replaceChildren();
    const toolbar = el(
      'div',
      { class: 'toolbar' },
      makeSelect(['all', 'I', 'II'], filter.cls, (v) => {
        filter.cls = v;
        renderList();
      }),
      makeSelect(
        ['all', 'Draft', 'Submitted', 'Under Review', 'Approved', 'Returned', 'Rejected', 'Implemented', 'Released'],
        filter.status,
        (v) => {
          filter.status = v;
          renderList();
        },
      ),
    );
    listPane.appendChild(toolbar);
    const filtered = scrs.filter(
      (s) =>
        (filter.cls === 'all' || s.scrClass === filter.cls) &&
        (filter.status === 'all' || s.status === filter.status),
    );
    if (filtered.length === 0) {
      listPane.appendChild(empty('No SCRs match those filters.'));
      return;
    }
    const tbody = el('tbody');
    for (const s of filtered) {
      const row = el(
        'tr',
        {},
        el('td', { class: 'mono' }, s.id),
        el(
          'td',
          {},
          el('div', {}, s.title),
          el('div', { class: 'muted2 mono' }, `${s.proposer} · ${s.proposedAt.slice(0, 10)}`),
        ),
        el('td', {}, classBadge(s.scrClass)),
        el('td', {}, statusBadge(s.status)),
      );
      row.addEventListener('click', () => select(s.id));
      if (s.id === selectedId) row.classList.add('selected');
      tbody.appendChild(row);
    }
    listPane.appendChild(
      el(
        'table',
        { class: 'table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'ID'), el('th', {}, 'Title'), el('th', {}, 'Class'), el('th', {}, 'Status'))),
        tbody,
      ),
    );
  }

  async function select(scrId) {
    selectedId = scrId;
    history.replaceState(null, '', `#/changes?scr=${scrId}`);
    renderList();
    detailPane.replaceChildren(el('div', { class: 'loading' }, 'Loading SCR…'));
    try {
      const { scr, approvals } = await api.getScr(ctx.workspaceId, scrId);
      renderDetail(scr, approvals);
    } catch (err) {
      detailPane.replaceChildren(empty(err.message));
    }
  }

  function renderDetail(scr, approvals) {
    detailPane.replaceChildren();
    detailPane.appendChild(
      el(
        'div',
        { class: 'detail-header' },
        el(
          'div',
          { class: 'detail-header-row' },
          el('span', { class: 'mono muted' }, scr.id),
          classBadge(scr.scrClass),
          statusBadge(scr.status),
        ),
        el('h2', {}, scr.title),
        el('div', { class: 'muted mono' }, `${scr.proposer} · ${scr.proposedAt}`),
        renderActions(scr),
      ),
    );

    if (scr.status === 'Returned' && scr.returnReason) {
      detailPane.appendChild(
        el('div', { class: 'banner offline' }, `Returned: ${scr.returnReason}`),
      );
    }

    detailPane.appendChild(section({ title: 'Problem' }, el('p', {}, scr.problem)));

    if (scr.targetNodes?.length) {
      const list = el('div', { class: 'target-nodes' });
      for (const glmId of scr.targetNodes) {
        // AC-10: clicking a target navigates to Sekkei Browser.
        const link = el('a', { href: `#/sekkei?glm=${encodeURIComponent(glmId)}` }, glmId);
        list.appendChild(el('div', { class: 'tag' }, link));
      }
      detailPane.appendChild(section({ title: `Target nodes (${scr.targetNodes.length})` }, list));
    }

    if (scr.diffYaml?.length) {
      detailPane.appendChild(section({ title: 'Proposed delta' }, diffBlock(scr.diffYaml)));
    }

    const impact = scr.impact ?? {
      variantsAffected: 0,
      tokensEst: estimateTokens(scr.targetNodes ?? []),
      cacheMissCount: 0,
    };
    detailPane.appendChild(
      section(
        { title: 'Impact closure' },
        kv([
          ['Variants affected', String(impact.variantsAffected)],
          ['Est. tokens', String(impact.tokensEst.toLocaleString())],
          ['Cache misses', String(impact.cacheMissCount)],
          ['Effectivity', scr.effectivity ?? '—'],
        ]),
      ),
    );

    const approvalRows = (approvals ?? []).map((a) =>
      el(
        'tr',
        {},
        el('td', { class: 'mono' }, a.who),
        el(
          'td',
          {},
          el('span', { class: `pill ${a.decision === 'approve' ? 'released' : a.decision === 'reject' ? 'warn' : 'outline'}` }, a.decision),
        ),
        el('td', { class: 'mono' }, a.decidedAt ?? '—'),
      ),
    );
    detailPane.appendChild(
      section(
        { title: `Approvals (${approvalRows.length})` },
        approvalRows.length === 0
          ? empty('No approval decisions yet.')
          : el(
              'table',
              { class: 'table' },
              el('thead', {}, el('tr', {}, el('th', {}, 'Reviewer'), el('th', {}, 'Decision'), el('th', {}, 'When'))),
              el('tbody', {}, ...approvalRows),
            ),
      ),
    );
  }

  function renderActions(scr) {
    const actions = el('div', { class: 'detail-actions' });
    const button = (label, primary, onClick) => {
      const b = el('button', primary ? { class: 'primary' } : {}, label);
      b.addEventListener('click', onClick);
      return b;
    };

    if (scr.status === 'Draft') {
      actions.appendChild(button('Submit', true, () => doTransition(scr.id, 'submit')));
    } else if (scr.status === 'Submitted') {
      actions.appendChild(button('Start review', true, () => doTransition(scr.id, 'startReview')));
    } else if (scr.status === 'Under Review') {
      actions.appendChild(button('Approve', true, () => doApprove(scr.id)));
      actions.appendChild(
        button('Return', false, () => {
          const reason = prompt('Return reason:');
          if (reason) doTransition(scr.id, 'return', reason);
        }),
      );
      actions.appendChild(
        button('Reject', false, () => {
          if (confirm('Reject this SCR?')) doTransition(scr.id, 'reject');
        }),
      );
    } else if (scr.status === 'Approved') {
      actions.appendChild(button('Implement →', true, () => doTransition(scr.id, 'implement')));
    } else if (scr.status === 'Implemented') {
      actions.appendChild(button('Release', true, () => doTransition(scr.id, 'release')));
    } else if (scr.status === 'Returned') {
      actions.appendChild(button('Reopen', false, () => doTransition(scr.id, 'reopen')));
    }
    return actions;
  }

  async function doTransition(scrId, event, reason) {
    try {
      await api.transitionScr(ctx.workspaceId, scrId, event, reason);
      await refresh();
      await select(scrId);
    } catch (err) {
      alert(err.message);
    }
  }

  async function doApprove(scrId) {
    try {
      // AC-08: approving updates status to Approved and creates an approval row.
      await api.approveScr(ctx.workspaceId, scrId, 'approve');
      await refresh();
      await select(scrId);
    } catch (err) {
      alert(err.message);
    }
  }

  function openNewScrForm() {
    const overlay = el('div', { class: 'overlay' });
    const card = el('div', { class: 'overlay-card' });
    overlay.appendChild(card);
    const initialTargets = params.target ? [params.target] : [];

    const idField = el('input', { type: 'text', placeholder: 'SCR-####' });
    const titleField = el('input', { type: 'text', placeholder: 'Imperative summary' });
    const classField = makeSelect(['I', 'II'], 'II', () => {});
    const problemField = el('textarea', { rows: '4', placeholder: 'Why is this needed?' });
    const targetsField = el('input', {
      type: 'text',
      placeholder: 'glm:capability.checkout, glm:component.web',
      value: initialTargets.join(', '),
    });

    const tokenEstimate = el('div', { class: 'muted' });
    const updateEstimate = () => {
      const targets = targetsField.value.split(',').map((s) => s.trim()).filter(Boolean);
      tokenEstimate.textContent = `Estimated tokens: ${estimateTokens(targets).toLocaleString()}`;
    };
    targetsField.addEventListener('input', updateEstimate);
    updateEstimate();

    card.append(
      el('h3', {}, 'New SCR'),
      labeled('ID', idField),
      labeled('Title', titleField),
      labeled('Class', classField),
      labeled('Problem', problemField),
      labeled('Target nodes (comma-separated glm_ids)', targetsField),
      tokenEstimate,
      el(
        'div',
        { class: 'overlay-actions' },
        (() => {
          const c = el('button', {}, 'Cancel');
          c.addEventListener('click', () => overlay.remove());
          return c;
        })(),
        (() => {
          const ok = el('button', { class: 'primary' }, 'Create');
          ok.addEventListener('click', async () => {
            const targets = targetsField.value.split(',').map((s) => s.trim()).filter(Boolean);
            try {
              const res = await api.createScr(ctx.workspaceId, {
                id: idField.value || undefined,
                title: titleField.value,
                scrClass: classField.value,
                problem: problemField.value,
                targetNodes: targets,
                diffYaml: [],
              });
              overlay.remove();
              await refresh();
              await select(res.scr.id);
            } catch (err) {
              alert(err.message);
            }
          });
          return ok;
        })(),
      ),
    );
    document.body.appendChild(overlay);
  }

  async function refresh() {
    try {
      const data = await api.listScrs(ctx.workspaceId);
      scrs = data.scrs ?? [];
      renderList();
    } catch (err) {
      listPane.appendChild(el('div', { class: 'banner offline' }, err.message));
    }
  }

  refresh().then(() => {
    if (selectedId) select(selectedId);
  });
  return { element: root };
}

function statusBadge(status) {
  const cls = {
    Draft: 'outline',
    Submitted: 'in_review',
    'Under Review': 'in_review',
    Approved: 'released',
    Implemented: 'released',
    Released: 'released',
    Returned: 'warn',
    Rejected: 'warn',
  }[status] ?? 'outline';
  return el('span', { class: `pill ${cls}` }, status);
}

function estimateTokens(targets) {
  return targets.length * 1800;
}

function labeled(label, input) {
  return el('label', { style: 'display: grid; gap: 4px; margin: 8px 0;' }, el('span', { class: 'muted' }, label), input);
}

function makeSelect(options, value, onChange) {
  const sel = el('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o;
    if (o === value) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', (e) => onChange(e.target.value));
  return sel;
}
