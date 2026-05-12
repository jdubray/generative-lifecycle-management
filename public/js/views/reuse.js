import { api } from '../api.js';
import { el, empty, kv, section } from '../components/index.js';

const STAGES = ['Variant-Local', 'Candidate-for-Promotion', 'Promoted-to-Library', 'Stewarded-by-Owner'];

/**
 * View 07 — Reuse & Inheritance.
 *
 * AC-28: "Find candidates" runs the server-side scan and surfaces any node
 * with ≥ 2 direct dependents as a Variant-Local candidate.
 * AC-29: "Open promotion SCR (Class I)" pre-fills the SCR form with the
 * subtree root as target.
 * AC-30: refuses to advance past Candidate-for-Promotion without a steward.
 */
export function reuseView(ctx) {
  const root = el('section', { class: 'view view-reuse' });
  root.appendChild(
    el(
      'div',
      { class: 'view-header' },
      el('span', { class: 'view-id mono' }, '07'),
      el('h1', {}, 'Reuse & Inheritance'),
      (() => {
        const btn = el('button', { class: 'primary' }, 'Find candidates');
        btn.addEventListener('click', findCandidates);
        return btn;
      })(),
    ),
  );

  const split = el('div', { class: 'split' });
  const listPane = el('div', { class: 'reuse-list' });
  const detailPane = el('div', { class: 'reuse-detail' });
  split.append(listPane, detailPane);
  root.appendChild(split);

  let candidates = [];
  let selectedId = null;

  async function load() {
    try {
      const data = await api.listReuse(ctx.workspaceId);
      candidates = data.candidates ?? [];
      renderList();
      if (candidates.length > 0) select(candidates[0].id);
      else detailPane.appendChild(empty('No candidates yet. Click "Find candidates" to scan.'));
    } catch (err) {
      listPane.appendChild(el('div', { class: 'banner offline' }, err.message));
    }
  }

  function renderList() {
    listPane.replaceChildren();
    if (candidates.length === 0) {
      listPane.appendChild(empty('No reuse candidates yet.'));
      return;
    }
    const tbody = el('tbody');
    for (const c of candidates) {
      const row = el(
        'tr',
        {},
        el(
          'td',
          {},
          el('div', {}, c.title),
          el('div', { class: 'mono muted2' }, c.subtree),
        ),
        el('td', {}, el('span', { class: 'pill outline' }, c.stage)),
        el('td', { class: 'mono' }, String(c.usages)),
      );
      row.addEventListener('click', () => select(c.id));
      if (c.id === selectedId) row.classList.add('selected');
      tbody.appendChild(row);
    }
    listPane.appendChild(
      el(
        'table',
        { class: 'table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Subtree'), el('th', {}, 'Stage'), el('th', {}, 'Usages'))),
        tbody,
      ),
    );
  }

  function select(id) {
    selectedId = id;
    renderList();
    const c = candidates.find((x) => x.id === id);
    if (!c) return;
    renderDetail(c);
  }

  function renderDetail(c) {
    detailPane.replaceChildren();
    detailPane.appendChild(
      el(
        'div',
        { class: 'detail-header' },
        el('h2', {}, c.title),
        el('div', { class: 'mono muted' }, c.subtree),
        el('div', { class: 'detail-header-row' }, el('span', { class: 'pill outline' }, c.stage)),
      ),
    );

    // Promotion lifecycle stepper
    const steps = el('div', { class: 'stepper' });
    const currentIdx = STAGES.indexOf(c.stage);
    for (let i = 0; i < STAGES.length; i++) {
      steps.appendChild(
        el(
          'span',
          {
            class: `step ${i <= currentIdx ? 'done' : 'todo'}`,
          },
          STAGES[i],
        ),
      );
    }
    detailPane.appendChild(section({ title: 'Promotion lifecycle' }, steps));

    detailPane.appendChild(section({ title: 'Rationale' }, el('p', {}, c.rationale || '—')));

    detailPane.appendChild(
      section(
        { title: 'Where-used signal' },
        kv([
          ['Live usages', String(c.usages)],
          ['Invariants held in', String(c.invariantsHeldIn)],
          ['Promotion threshold', '≥ 2 adopters + named steward'],
        ]),
      ),
    );

    const stewardBlock = (() => {
      if (c.steward) {
        return kv([
          ['Steward', c.steward],
          ['Maintenance SLA', 'Best-effort'],
        ]);
      }
      const wrap = el('div');
      wrap.appendChild(
        el(
          'div',
          { class: 'banner info' },
          'No steward yet. Stewardship is required to promote past Candidate-for-Promotion (AC-30).',
        ),
      );
      const btn = el('button', { class: 'primary' }, 'Accept stewardship');
      btn.addEventListener('click', async () => {
        const me = prompt('Enter your email to accept stewardship:');
        if (!me) return;
        try {
          const r = await api.setReuseSteward(ctx.workspaceId, c.id, me);
          const idx = candidates.findIndex((x) => x.id === c.id);
          candidates[idx] = r.candidate;
          select(c.id);
        } catch (err) {
          alert(err.message);
        }
      });
      wrap.appendChild(btn);
      return wrap;
    })();
    detailPane.appendChild(section({ title: 'Steward' }, stewardBlock));

    // Stage-contextual actions
    const actions = el('div', { class: 'detail-actions' });
    const button = (label, primary, onClick) => {
      const b = el('button', primary ? { class: 'primary' } : {}, label);
      b.addEventListener('click', onClick);
      return b;
    };

    if (c.stage === 'Variant-Local') {
      actions.appendChild(
        button('Mark as candidate', true, () => advance(c.id, 'Candidate-for-Promotion')),
      );
    } else if (c.stage === 'Candidate-for-Promotion') {
      actions.appendChild(
        // AC-29: pre-populate the new SCR with the subtree root + class=I.
        button('Open promotion SCR (Class I)', true, () => {
          location.hash = `#/changes?target=${encodeURIComponent(c.subtree)}`;
        }),
      );
      actions.appendChild(button('Promote to library', false, () => advance(c.id, 'Promoted-to-Library')));
    } else if (c.stage === 'Promoted-to-Library') {
      actions.appendChild(button('Mark stewarded', true, () => advance(c.id, 'Stewarded-by-Owner')));
    }
    detailPane.appendChild(section({ title: 'Actions' }, actions));
  }

  async function advance(id, stage) {
    try {
      const r = await api.advanceReuseStage(ctx.workspaceId, id, stage);
      const idx = candidates.findIndex((c) => c.id === id);
      if (idx >= 0) candidates[idx] = r.candidate;
      select(id);
    } catch (err) {
      alert(err.message);
    }
  }

  async function findCandidates() {
    try {
      const r = await api.findReuseCandidates(ctx.workspaceId);
      alert(`Scanned ${r.considered} nodes; created ${r.created.length} candidate(s).`);
      await load();
    } catch (err) {
      alert(err.message);
    }
  }

  load();
  return { element: root };
}
