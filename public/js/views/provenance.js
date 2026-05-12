import { api } from '../api.js';
import { el, hash, kv, section, yamlBlock, empty } from '../components/index.js';

/**
 * View 08 — Provenance & Audit.
 *
 * Left: provenance events table. Right: selected event detail with the
 * in-toto Statement and DSSE envelope. AC-32: cache=miss events show
 * token counters. AC-33: cache=hit events show 0/0. AC-34: Export bundle.
 * AC-35: Verify signatures. AC-36: Rekor URL is shown when present.
 */
export function provenanceView(ctx, params = {}) {
  const root = el('section', { class: 'view view-provenance' });
  root.appendChild(
    el(
      'div',
      { class: 'view-header' },
      el('span', { class: 'view-id mono' }, '08'),
      el('h1', {}, 'Provenance & Audit'),
    ),
  );

  const toolbar = el(
    'div',
    { class: 'toolbar', style: 'padding-bottom: 12px;' },
    (() => {
      const btn = el('button', {}, 'Export DSSE bundle');
      btn.addEventListener('click', exportBundle);
      return btn;
    })(),
    (() => {
      const btn = el('button', {}, 'Verify signatures');
      btn.addEventListener('click', verifyAll);
      return btn;
    })(),
  );
  root.appendChild(toolbar);
  const status = el('div', { class: 'banner info', hidden: true });
  status.hidden = true;
  root.appendChild(status);

  const split = el('div', { class: 'split' });
  const listPane = el('div', { class: 'prov-list' });
  const detailPane = el('div', { class: 'prov-detail' });
  split.append(listPane, detailPane);
  root.appendChild(split);

  let events = [];
  let selectedId = params.event ?? null;
  let statusTimer = null;

  function setStatus(message, kind = 'info') {
    status.textContent = message;
    status.className = `banner ${kind}`;
    status.hidden = false;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      status.hidden = true;
      statusTimer = null;
    }, 4000);
  }

  async function exportBundle() {
    const res = await api.exportProvenance(ctx.workspaceId);
    if (!res.ok) return setStatus(`Export failed: ${res.status}`, 'offline');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `glm-${ctx.workspaceId}-dsse.ndjson`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus('Bundle downloaded.');
  }

  async function verifyAll() {
    try {
      const r = await api.verifyProvenance(ctx.workspaceId);
      setStatus(`Verified ${r.passed}/${r.total} signatures.`, r.failed === 0 ? 'info' : 'offline');
    } catch (err) {
      setStatus(`Verify failed: ${err.message}`, 'offline');
    }
  }

  function renderList() {
    listPane.replaceChildren();
    if (events.length === 0) {
      listPane.appendChild(empty('No provenance events yet.'));
      return;
    }
    const tbody = el('tbody');
    for (const e of events) {
      const row = el(
        'tr',
        {},
        el('td', { class: 'mono' }, e.occurredAt),
        el('td', { class: 'mono' }, e.subjectFile),
        el(
          'td',
          {},
          el('span', { class: `pill ${e.cache === 'hit' ? 'released' : 'warn'}` }, e.cache),
        ),
        el('td', { class: 'mono' }, `${e.tokensIn} / ${e.tokensOut}`),
      );
      row.addEventListener('click', () => select(e.id));
      if (e.id === selectedId) row.classList.add('selected');
      tbody.appendChild(row);
    }
    const table = el(
      'table',
      { class: 'table' },
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', {}, 'When'),
          el('th', {}, 'Artifact'),
          el('th', {}, 'Cache'),
          el('th', {}, 'In / Out'),
        ),
      ),
      tbody,
    );
    listPane.appendChild(table);
  }

  async function select(eventId) {
    selectedId = eventId;
    renderList();
    detailPane.replaceChildren(el('div', { class: 'loading' }, 'Loading event…'));
    try {
      const { event, attestation } = await api.getProvenance(ctx.workspaceId, eventId);
      detailPane.replaceChildren();
      detailPane.appendChild(
        section(
          { title: 'Event' },
          kv([
            ['id', el('span', { class: 'mono' }, event.id)],
            ['when', el('span', { class: 'mono' }, event.occurredAt)],
            ['subject', el('span', { class: 'mono' }, event.subjectFile)],
            ['subject_digest', hash(event.subjectDigest)],
            ['cache', el('span', { class: `pill ${event.cache === 'hit' ? 'released' : 'warn'}` }, event.cache)],
            ['signed', event.signed ? 'yes' : 'no'],
          ]),
        ),
      );
      detailPane.appendChild(
        section(
          { title: 'Sekkei' },
          kv([
            ['root_id', el('span', { class: 'mono' }, event.sekkeiRoot)],
            ['revision', event.sekkeiRev],
            ['lock', hash(event.sekkeiLock)],
            ['binding', hash(event.bindingHash)],
          ]),
        ),
      );
      detailPane.appendChild(
        section(
          { title: 'Generator' },
          kv([
            ['llm', el('span', { class: 'mono' }, event.generatorLlm)],
            ['prompt_version', hash(event.generatorPromptVersion)],
            ['tokens_in', String(event.tokensIn)],
            ['tokens_out', String(event.tokensOut)],
            ['duration_ms', String(event.durationMs)],
          ]),
        ),
      );

      if (attestation) {
        detailPane.appendChild(
          section(
            { title: 'in-toto Statement' },
            yamlBlock(JSON.stringify(attestation.statement, null, 2)),
          ),
        );
        const dsse = attestation.envelope;
        detailPane.appendChild(
          section(
            { title: 'DSSE envelope' },
            kv([
              ['payloadType', el('span', { class: 'mono' }, dsse.payloadType)],
              ['keyid', el('span', { class: 'mono' }, dsse.signatures[0]?.keyid ?? '—')],
              [
                'rekor',
                attestation.rekorUrl
                  ? (() => {
                      const a = el('a', { href: attestation.rekorUrl, target: '_blank', rel: 'noopener' }, attestation.rekorUrl);
                      return a;
                    })()
                  : '—',
              ],
            ]),
          ),
        );
      } else {
        detailPane.appendChild(empty('No attestation recorded for this event.'));
      }
    } catch (err) {
      detailPane.replaceChildren(empty(err.message));
    }
  }

  async function load() {
    try {
      const data = await api.listProvenance(ctx.workspaceId, 500);
      events = data.events ?? [];
      renderList();
      if (selectedId) await select(selectedId);
      else if (events.length > 0) await select(events[0].id);
      else detailPane.appendChild(empty('No events to inspect.'));
    } catch (err) {
      listPane.appendChild(el('div', { class: 'banner offline' }, `Failed: ${err.message}`));
    }
  }
  load();

  return {
    element: root,
    destroy: () => {
      if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }
    },
  };
}
