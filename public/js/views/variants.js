import { api } from '../api.js';
import { el, empty, hash, kv, section, yamlBlock } from '../components/index.js';

/**
 * View 03 — Variant Resolution.
 *
 * Left: parameter binding panel. Right: pipeline result. AC-11 covers the
 * "binding change resets the result" behavior; AC-12 maps a constraint
 * failure to a failed pipeline; AC-13 ensures the lock YAML carries
 * `for_sekkei` + every pinned node; AC-14 shows all five cache key hashes
 * regardless of pass/fail.
 */
export function variantsView(ctx) {
  const root = el('section', { class: 'view view-variants' });
  root.appendChild(
    el(
      'div',
      { class: 'view-header' },
      el('span', { class: 'view-id mono' }, '03'),
      el('h1', {}, 'Variant Resolution'),
    ),
  );

  const split = el('div', { class: 'split' });
  const inputPane = el('div', { class: 'variant-input' });
  const resultPane = el('div', { class: 'variant-result' });
  split.append(inputPane, resultPane);
  root.appendChild(split);

  let variants = [];
  let nodes = [];
  let currentVariantId = null;
  let bindingState = {};

  function renderInput() {
    inputPane.replaceChildren();
    const variantPicker = makeSelect(
      [{ value: '', label: '— choose variant —' }, ...variants.map((v) => ({ value: v.id, label: v.label }))],
      currentVariantId ?? '',
      (v) => {
        currentVariantId = v || null;
        renderInput();
        // AC-11: changing the variant resets the result panel.
        resultPane.replaceChildren(empty('Pick a variant + bindings, then run resolve.'));
      },
    );
    inputPane.appendChild(section({ title: 'Variant' }, variantPicker));

    const rootPicker = makeSelect(
      [{ value: '', label: '— choose root —' }, ...nodes.map((n) => ({ value: n.glmId, label: `${n.stratum}: ${n.title}` }))],
      bindingState.rootGlmId ?? '',
      (v) => {
        bindingState.rootGlmId = v || null;
        // AC-11: any input change resets the result panel.
        resultPane.replaceChildren(empty('Configure bindings, then run resolve.'));
      },
    );
    inputPane.appendChild(section({ title: 'Sekkei root' }, rootPicker));

    const bindingForm = el('div', { class: 'bindings' });
    bindingForm.appendChild(
      el(
        'p',
        { class: 'muted' },
        'Parameter values (JSON-shaped, one per line: name = value).',
      ),
    );
    const bindingArea = el('textarea', { rows: '8' });
    bindingArea.value = bindingState.text ?? '';
    bindingArea.addEventListener('input', (e) => {
      bindingState.text = e.target.value;
      // AC-11: clears stale results so the user knows they're looking at the new inputs.
      resultPane.replaceChildren(empty('Inputs changed — run resolve.'));
    });
    bindingForm.appendChild(bindingArea);
    inputPane.appendChild(section({ title: 'Parameter binding' }, bindingForm));

    const generatorArea = el('textarea', { rows: '4' });
    generatorArea.value = bindingState.generatorText ?? JSON.stringify(
      { llm: 'claude-sonnet-4-6', promptVersion: 'sha256:dev', toolChain: 'sha256:dev' },
      null,
      2,
    );
    generatorArea.addEventListener('input', (e) => {
      bindingState.generatorText = e.target.value;
    });
    inputPane.appendChild(section({ title: 'Generator identity' }, generatorArea));

    const closureHashInput = el('input', { type: 'text', placeholder: 'sha256:…' });
    closureHashInput.value = bindingState.closureHash ?? 'sha256:dev';
    closureHashInput.addEventListener('input', (e) => {
      bindingState.closureHash = e.target.value;
    });
    inputPane.appendChild(section({ title: 'Closure hash (cache key)' }, closureHashInput));

    const runBtn = el('button', { class: 'primary' }, 'Resolve variant');
    runBtn.addEventListener('click', () => runResolve());
    inputPane.appendChild(runBtn);
  }

  async function runResolve() {
    if (!currentVariantId) return alert('Pick a variant.');
    if (!bindingState.rootGlmId) return alert('Pick a sekkei root.');
    const binding = parseBindingText(bindingState.text ?? '');
    let generator;
    try {
      generator = JSON.parse(bindingState.generatorText ?? '{}');
    } catch {
      return alert('Generator identity must be valid JSON.');
    }
    resultPane.replaceChildren(el('div', { class: 'loading' }, 'Resolving…'));
    try {
      const res = await api.resolveVariant(ctx.workspaceId, currentVariantId, {
        rootGlmId: bindingState.rootGlmId,
        binding,
        generatorIdentity: generator,
      });
      renderResult(res.result);
    } catch (err) {
      resultPane.replaceChildren(empty(err.message));
    }
  }

  function renderResult(r) {
    resultPane.replaceChildren();
    const overallClass = r.overall.passed ? 'released' : 'warn';
    resultPane.appendChild(
      el(
        'div',
        { class: `banner ${r.overall.passed ? 'info' : 'offline'}` },
        r.overall.passed
          ? `Resolution passed (${r.closure.length} nodes pinned).`
          : `Failed at step ${r.overall.failedAtStep}.`,
      ),
    );

    // Pipeline steps
    const stepsTable = el('table', { class: 'table' });
    stepsTable.appendChild(
      el('thead', {}, el('tr', {}, el('th', {}, 'Step'), el('th', {}, 'Result'), el('th', {}, 'Detail'))),
    );
    const tbody = el('tbody');
    for (const [name, label] of [
      ['closureWalk', '1. Closure walk'],
      ['parameterBinding', '2. Parameter binding'],
      ['constraintValidation', '3. Constraint validation'],
      ['externalDependencies', '4. External dependencies'],
      ['cacheKeys', '5. Cache key computation'],
      ['lockEmission', '6. sekkei.lock emission'],
    ]) {
      const step = r.steps[name];
      tbody.appendChild(
        el(
          'tr',
          {},
          el('td', {}, label),
          el('td', {}, el('span', { class: `pill ${step.ok ? 'released' : 'warn'}` }, step.ok ? 'OK' : 'FAIL')),
          el('td', {}, step.detail),
        ),
      );
    }
    stepsTable.appendChild(tbody);
    resultPane.appendChild(section({ title: 'Pipeline' }, stepsTable));

    // Constraints
    if (r.constraints.length > 0) {
      const ctable = el('table', { class: 'table' });
      ctable.appendChild(
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', {}, 'Node'),
            el('th', {}, 'Kind'),
            el('th', {}, 'Severity'),
            el('th', {}, 'Expression'),
            el('th', {}, 'Result'),
          ),
        ),
      );
      const cbody = el('tbody');
      for (const c of r.constraints) {
        cbody.appendChild(
          el(
            'tr',
            {},
            el('td', { class: 'mono' }, c.nodeGlmId),
            el('td', {}, c.kind),
            el('td', {}, el('span', { class: `pill ${c.severity === 'error' ? 'warn' : 'outline'}` }, c.severity)),
            el('td', { class: 'mono' }, c.expression),
            el('td', {}, el('span', { class: `pill ${c.passed ? 'released' : 'warn'}` }, c.passed ? 'PASS' : 'FAIL')),
          ),
        );
      }
      ctable.appendChild(cbody);
      resultPane.appendChild(section({ title: 'Constraints' }, ctable));
    }

    // AC-14: always show all five hashes regardless of overall pass/fail.
    resultPane.appendChild(
      section(
        { title: 'Cache keys' },
        kv([
          ['closure', hash(r.hashes.closureHash)],
          ['binding', hash(r.hashes.bindingHash)],
          ['design', hash(r.hashes.designHash)],
          ['generator identity', hash(r.hashes.generatorIdentityHash)],
          ['generation', hash(r.hashes.generationHash)],
        ]),
      ),
    );

    // AC-13: lock YAML with for_sekkei + pinned nodes.
    const lockSection = section(
      {
        title: 'sekkei.lock',
        right: (() => {
          const btn = el('button', {}, 'Copy YAML');
          btn.addEventListener('click', () => navigator.clipboard?.writeText(toYaml(r.lock)));
          return btn;
        })(),
      },
      yamlBlock(toYaml(r.lock)),
    );
    resultPane.appendChild(lockSection);
  }

  async function load() {
    try {
      const [vs, ns] = await Promise.all([api.listVariants(ctx.workspaceId), api.listNodes(ctx.workspaceId)]);
      variants = vs.variants ?? [];
      nodes = ns.nodes ?? [];
      renderInput();
      resultPane.appendChild(empty('Configure bindings, then run resolve.'));
    } catch (err) {
      inputPane.replaceChildren(el('div', { class: 'banner offline' }, err.message));
    }
  }
  load();

  return { element: root };
}

function parseBindingText(text) {
  const binding = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z_][\w.]*)\s*[:=]\s*(.+)$/);
    if (!m) continue;
    const key = m[1];
    const raw = m[2];
    try {
      binding[key] = JSON.parse(raw);
    } catch {
      binding[key] = raw;
    }
  }
  return binding;
}

function toYaml(value) {
  // Cheap YAML emitter — `value` here is always JSON-shaped.
  return JSON.stringify(value, null, 2);
}

function makeSelect(options, value, onChange) {
  const sel = el('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === value) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', (e) => onChange(e.target.value));
  return sel;
}
