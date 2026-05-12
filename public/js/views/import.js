import { api } from '../api.js';
import { el, empty, kv, section } from '../components/index.js';

/**
 * Import Sekkei wizard.
 *
 *   Step 1 — workspace identity (slug, name) + multi-file picker
 *   Step 2 — dry-run preview (counts, warnings)
 *   Step 3 — confirm + real import; navigate to the imported workspace
 *
 * Inline mode only — the browser reads each picked file with `FileReader`
 * and posts the contents as `documents: [{ filename, content }]`. Tarball
 * + server-side directory modes remain CLI-only (`scripts/import-sekkei.ts`).
 */
export function importView(ctx) {
  const root = el('section', { class: 'view view-import' });
  root.appendChild(
    el(
      'div',
      { class: 'view-header' },
      el('span', { class: 'view-id mono' }, '↥'),
      el('h1', {}, 'Import sekkei'),
    ),
  );

  let documents = []; // Array<{ filename, content }>
  let dryRunSummary = null;
  let stage = 'pick'; // 'pick' | 'preview' | 'done'

  const slugInput = el('input', { type: 'text', placeholder: 'e.g. glm-self', value: '' });
  const nameInput = el('input', { type: 'text', placeholder: 'Display name (defaults to slug)', value: '' });
  const fileInput = el('input', {
    type: 'file',
    multiple: 'multiple',
    accept: '.yaml,.yml',
    // webkitdirectory lets the user pick a directory; browsers send every file inside.
    webkitdirectory: 'webkitdirectory',
    directory: 'directory',
  });

  function render() {
    root.replaceChildren();
    root.appendChild(
      el(
        'div',
        { class: 'view-header' },
        el('span', { class: 'view-id mono' }, '↥'),
        el('h1', {}, 'Import sekkei'),
      ),
    );
    root.appendChild(stepper(stage));

    if (stage === 'pick') renderPick();
    else if (stage === 'preview') renderPreview();
    else renderDone();
  }

  function renderPick() {
    const body = el('div', { class: 'import-pick' });
    body.appendChild(
      el(
        'p',
        { class: 'muted' },
        'Pick a directory containing your sekkei YAML files. Only `.yaml` and `.yml` files are read; everything else is ignored.',
      ),
    );
    body.appendChild(labeled('Workspace slug (URL-safe)', slugInput));
    body.appendChild(labeled('Display name', nameInput));
    body.appendChild(labeled('Sekkei folder', fileInput));

    const status = el('div', { class: 'muted' });
    fileInput.addEventListener('change', async (e) => {
      const files = [...(e.target.files ?? [])].filter((f) =>
        f.name.endsWith('.yaml') || f.name.endsWith('.yml'),
      );
      documents = await Promise.all(
        files.map(async (f) => ({
          filename: f.webkitRelativePath || f.name,
          content: await f.text(),
        })),
      );
      status.textContent = `${documents.length} YAML file(s) selected.`;
    });
    body.appendChild(status);

    const actions = el('div', { class: 'detail-actions' });
    const previewBtn = el('button', { class: 'primary' }, 'Preview import');
    previewBtn.addEventListener('click', () => runPreview());
    actions.appendChild(previewBtn);
    body.appendChild(actions);

    root.appendChild(section({ title: '1 · Pick' }, body));
  }

  async function runPreview() {
    const slug = slugInput.value.trim();
    const name = nameInput.value.trim() || slug;
    if (!slug) return alert('Slug is required.');
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(slug)) return alert('Slug must match ^[a-z][a-z0-9-]{0,63}$');
    if (documents.length === 0) return alert('No YAML files selected.');
    try {
      const res = await api.importSekkei({ slug, name, documents, dryRun: true });
      dryRunSummary = res.summary;
      stage = 'preview';
      render();
    } catch (err) {
      alert(err.message);
    }
  }

  function renderPreview() {
    const body = el('div', { class: 'import-preview' });
    body.appendChild(
      kv([
        ['Files scanned', String(dryRunSummary.filesScanned)],
        ['Nodes to insert', String(dryRunSummary.nodesInserted)],
        ['Nodes to update', String(dryRunSummary.nodesUpdated)],
        ['Nodes unchanged', String(dryRunSummary.nodesUnchanged)],
        ['derives_from resolved', String(dryRunSummary.derivesFromResolved)],
        ['derives_from missing', String(dryRunSummary.derivesFromMissing.length)],
        ['Warnings', String(dryRunSummary.warnings.length)],
      ]),
    );
    if (dryRunSummary.warnings.length > 0) {
      const list = el('ul', { class: 'import-warnings' });
      for (const w of dryRunSummary.warnings.slice(0, 50))
        list.appendChild(el('li', {}, w));
      if (dryRunSummary.warnings.length > 50) {
        list.appendChild(
          el('li', { class: 'muted' }, `… and ${dryRunSummary.warnings.length - 50} more`),
        );
      }
      body.appendChild(section({ title: 'Warnings (preview only)' }, list));
    }
    if (dryRunSummary.derivesFromMissing.length > 0) {
      const list = el('ul', { class: 'import-warnings' });
      for (const m of dryRunSummary.derivesFromMissing.slice(0, 50)) {
        list.appendChild(el('li', { class: 'mono' }, `${m.glmId} → ${m.missingTarget}`));
      }
      body.appendChild(
        section(
          { title: 'Cross-revision lineage (kept as advisory)' },
          list,
        ),
      );
    }

    const actions = el('div', { class: 'detail-actions' });
    const backBtn = el('button', {}, 'Back');
    backBtn.addEventListener('click', () => {
      stage = 'pick';
      render();
    });
    const confirmBtn = el('button', { class: 'primary' }, 'Confirm import');
    confirmBtn.addEventListener('click', () => runImport());
    actions.append(backBtn, confirmBtn);
    body.appendChild(actions);
    root.appendChild(section({ title: '2 · Preview' }, body));
  }

  async function runImport() {
    const slug = slugInput.value.trim();
    const name = nameInput.value.trim() || slug;
    try {
      const res = await api.importSekkei({ slug, name, documents, dryRun: false });
      stage = 'done';
      dryRunSummary = res.summary;
      // Navigate to the new workspace after a short success card.
      setTimeout(() => {
        const url = new URL(location.href);
        url.searchParams.set('workspace', slug);
        url.hash = '#/sekkei';
        location.assign(url.toString());
      }, 600);
      render();
    } catch (err) {
      alert(err.message);
    }
  }

  function renderDone() {
    root.appendChild(
      section(
        { title: '3 · Done' },
        el(
          'div',
          { class: 'import-done' },
          el('p', {}, `Imported ${dryRunSummary.nodesInserted} new + ${dryRunSummary.nodesUpdated} updated + ${dryRunSummary.nodesUnchanged} unchanged nodes.`),
          el('p', { class: 'muted' }, 'Redirecting to the new workspace…'),
        ),
      ),
    );
  }

  render();
  return { element: root };
}

function stepper(stage) {
  const map = { pick: 0, preview: 1, done: 2 };
  const labels = ['Pick', 'Preview', 'Done'];
  const idx = map[stage];
  const wrap = el('div', { class: 'stepper', style: 'margin-bottom: 16px;' });
  for (let i = 0; i < labels.length; i++) {
    wrap.appendChild(
      el('span', { class: `step ${i <= idx ? 'done' : 'todo'}` }, `${i + 1}. ${labels[i]}`),
    );
  }
  return wrap;
}

function labeled(label, input) {
  return el(
    'label',
    { style: 'display: grid; gap: 4px; margin: 10px 0;' },
    el('span', { class: 'muted' }, label),
    input,
  );
}
