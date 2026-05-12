import { api } from '../api.js';
import { diffBlock, el, empty, hash, kv } from '../components/index.js';

/**
 * View ✦ — Vibe Mode.
 *
 *   - Left pane: chat transcript with rich cards.
 *   - Right pane: process console (timestamped log lines).
 *   - Server-driven: intent classification and continuations are fetched
 *     from /vibe/* endpoints so the script catalog can evolve without a
 *     PWA redeploy.
 *
 * AC-37: scripted scenarios produce the documented sequence of cards.
 * AC-38: gate / clarifier / choice actions disable themselves after a response.
 * AC-39: result.link.tab navigates to the correct view via the router.
 * AC-40: LLM fallback returns a canned reply when the model is unreachable.
 * AC-41: suggestion chips disappear after the first user message.
 */
export function vibeModeView(ctx) {
  const root = el('section', { class: 'view view-vibe' });
  root.appendChild(
    el(
      'div',
      { class: 'view-header' },
      el('span', { class: 'view-id mono' }, '✦'),
      el('h1', {}, 'Vibe Mode'),
    ),
  );

  const shell = el('div', { class: 'vibe-shell' });
  const chat = el('div', { class: 'vibe-chat' });
  const transcript = el('div', { class: 'vibe-transcript' });
  const inputWrap = el('div', { class: 'vibe-input-wrap' });
  chat.append(transcript, inputWrap);

  const consolePane = el('div', { class: 'vibe-console' });
  shell.append(chat, consolePane);
  root.appendChild(shell);

  let scripts = null;
  let messages = [];
  let busy = false;
  let consoleEvents = [];
  let firstUserSent = false;

  bootstrap();

  async function bootstrap() {
    transcript.replaceChildren(el('div', { class: 'loading' }, 'Loading scripts…'));
    try {
      scripts = await api.vibeScripts();
    } catch (err) {
      transcript.replaceChildren(el('div', { class: 'banner offline' }, err.message));
      return;
    }
    appendCard({
      kind: 'agent_text',
      body:
        'Vibe Mode. Describe what you want to change in plain language — I\'ll run the lifecycle. I won\'t skip the formal gates. Try a suggestion below to see me work.',
    });
    pushConsole({ level: 'info', text: 'vibe › session opened' });
    pushConsole({ level: 'ok', text: `graph › workspace ${ctx.workspaceId} loaded` });
    renderInput();
    renderConsole();
  }

  // -- transcript helpers ----------------------------------------------------

  function appendCard(card, scenario) {
    messages.push({ ...card, scenario });
    renderTranscript();
  }

  async function appendScript(cards, scenario) {
    busy = true;
    renderInput();
    for (const card of cards) {
      if (card.kind === 'console') {
        for (const line of card.stream) {
          pushConsole({ level: 'info', text: line });
          await sleep(60);
        }
      } else {
        appendCard(card, scenario);
        await sleep(80);
      }
    }
    busy = false;
    renderInput();
  }

  function renderTranscript() {
    transcript.replaceChildren();
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      transcript.appendChild(renderMessage(m, i));
    }
    if (busy) transcript.appendChild(typingIndicator());
    transcript.scrollTop = transcript.scrollHeight;
  }

  function renderMessage(m, idx) {
    if (m.kind === 'user') {
      return el('div', { class: 'vibe-msg user' }, el('div', { class: 'vibe-bubble user' }, String(m.body)));
    }
    const wrap = el('div', { class: 'vibe-msg agent' });
    const avatar = el('div', { class: 'vibe-avatar' }, '✦');
    wrap.appendChild(avatar);
    const card = renderAgentCard(m, idx);
    wrap.appendChild(card);
    return wrap;
  }

  function renderAgentCard(m, idx) {
    switch (m.kind) {
      case 'agent_text':
        return el('div', { class: 'vibe-bubble agent' }, m.body);
      case 'plan':
        return planCard(m);
      case 'clarifier':
        return clarifierCard(m, idx);
      case 'scr_draft':
        return scrDraftCard(m);
      case 'drift_card':
        return driftSummaryCard(m);
      case 'choice':
        return choiceCard(m, idx);
      case 'gate':
        return gateCard(m, idx);
      case 'resolution_card':
        return resolutionCard(m);
      case 'result':
        return resultCard(m);
      default:
        return el('div', { class: 'vibe-bubble agent' }, `(unknown card: ${m.kind})`);
    }
  }

  function planCard(card) {
    const wrap = el('div', { class: 'vibe-card plan' });
    wrap.appendChild(el('div', { class: 'vibe-card-title' }, card.title));
    for (const step of card.steps) {
      wrap.appendChild(
        el(
          'div',
          { class: 'plan-step' },
          el('span', { class: 'plan-num mono' }, step.id),
          el('span', { class: 'tag' }, step.proc),
          el('span', { class: 'plan-text' }, step.text),
        ),
      );
    }
    return wrap;
  }

  function clarifierCard(card, idx) {
    const wrap = el('div', { class: 'vibe-card clarifier' });
    wrap.appendChild(el('div', { class: 'vibe-card-title' }, card.question));
    const actions = el('div', { class: 'card-actions' });
    for (const opt of card.options) {
      const b = el('button', {}, opt.label);
      b.addEventListener('click', async () => {
        disableCardButtons(wrap);
        appendCard({ kind: 'user', body: `chose: ${opt.label}` });
        const { cards } = await api.vibeContinue('archive', 'clarifier', { choice: opt.id });
        await appendScript(cards, 'archive');
      });
      actions.appendChild(b);
    }
    wrap.appendChild(actions);
    return wrap;
  }

  function scrDraftCard(card) {
    const wrap = el('div', { class: 'vibe-card scr-draft' });
    wrap.appendChild(
      el(
        'div',
        { class: 'vibe-card-title' },
        el('span', { class: 'mono' }, card.scrId),
        el('span', { class: `pill ${card.scrClass === 'I' ? 'warn' : 'outline'}` }, `Class ${card.scrClass}`),
        ' ',
        card.title,
      ),
    );
    wrap.appendChild(
      el(
        'div',
        { class: 'target-nodes' },
        ...card.targets.map((t) =>
          el('span', { class: 'tag' }, el('a', { href: `#/sekkei?glm=${encodeURIComponent(t)}` }, t)),
        ),
      ),
    );
    wrap.appendChild(diffBlock(card.diff));
    wrap.appendChild(
      kv([
        ['Variants', String(card.impact.variants)],
        ['Tokens', String(card.impact.tokens.toLocaleString())],
        ['Cache misses', String(card.impact.cacheMisses)],
      ]),
    );
    return wrap;
  }

  function driftSummaryCard(card) {
    const wrap = el('div', { class: 'vibe-card drift-card' });
    wrap.appendChild(
      el(
        'div',
        { class: 'vibe-card-title' },
        el('span', { class: 'pill drift' }, 'live-state drift'),
        ' ',
        el('span', { class: 'mono' }, card.file),
      ),
    );
    wrap.appendChild(el('div', { class: 'mono muted' }, card.node));
    wrap.appendChild(el('p', {}, card.detail));
    return wrap;
  }

  function choiceCard(card, idx) {
    const wrap = el('div', { class: 'vibe-card choice' });
    const grid = el('div', { class: 'choice-grid' });
    for (const opt of card.options) {
      const btn = el('button', { class: 'choice-btn' });
      btn.append(
        el('div', { class: 'choice-label' }, opt.label),
        el('div', { class: 'choice-sub' }, opt.subtitle),
      );
      btn.addEventListener('click', async () => {
        disableCardButtons(wrap);
        appendCard({ kind: 'user', body: `chose: ${opt.label}` });
        const { cards } = await api.vibeContinue('drift', 'choice', { choice: opt.id });
        await appendScript(cards, 'drift');
      });
      grid.appendChild(btn);
    }
    wrap.appendChild(grid);
    return wrap;
  }

  function gateCard(card, idx) {
    const wrap = el('div', { class: 'vibe-card gate' });
    wrap.appendChild(el('div', { class: 'vibe-card-title' }, card.label));
    if (card.detail) wrap.appendChild(el('div', { class: 'muted' }, card.detail));
    const actions = el('div', { class: 'card-actions' });
    const scenario = messages[idx]?.scenario;
    for (const action of card.actions) {
      const b = el('button', action.variant === 'primary' ? { class: 'primary' } : action.variant === 'ghost' ? { class: 'ghost' } : {}, action.label);
      b.addEventListener('click', async () => {
        disableCardButtons(wrap);
        appendCard({ kind: 'user', body: action.label });
        const { cards } = await api.vibeContinue(scenario ?? 'archive', 'gate', { action: action.id });
        await appendScript(cards, scenario);
      });
      actions.appendChild(b);
    }
    wrap.appendChild(actions);
    return wrap;
  }

  function resolutionCard(card) {
    const wrap = el('div', { class: 'vibe-card resolution' });
    wrap.appendChild(
      el(
        'div',
        { class: 'vibe-card-title' },
        el('span', { class: 'mono' }, card.target),
        ' ',
        el('span', { class: `pill ${card.ok ? 'released' : 'warn'}` }, card.ok ? 'OK' : 'FAIL'),
      ),
    );
    wrap.appendChild(
      kv([
        ['design', hash(card.designHash)],
        ['generation', hash(card.generationHash)],
        ['pins', String(card.pins)],
        ['cache misses', String(card.misses)],
      ]),
    );
    return wrap;
  }

  function resultCard(card) {
    const wrap = el('div', { class: 'vibe-card result' });
    wrap.appendChild(el('div', { class: 'vibe-card-title' }, card.title));
    const list = el('ul');
    for (const line of card.lines) list.appendChild(el('li', {}, line));
    wrap.appendChild(list);
    if (card.link) {
      // AC-39: navigate to the named view tab.
      const a = el('a', { href: `#/${card.link.tab}` }, card.link.label);
      wrap.appendChild(a);
    }
    return wrap;
  }

  function typingIndicator() {
    return el('div', { class: 'vibe-typing' }, el('span'), el('span'), el('span'));
  }

  function disableCardButtons(cardEl) {
    // AC-38: greying out buttons once a response is submitted.
    for (const b of cardEl.querySelectorAll('button')) {
      b.setAttribute('disabled', 'disabled');
      b.classList.add('disabled');
    }
  }

  // -- input -----------------------------------------------------------------

  function renderInput() {
    inputWrap.replaceChildren();
    // AC-41: suggestion chips visible only before the first user message.
    if (!firstUserSent && scripts?.suggestions) {
      const sugs = el('div', { class: 'vibe-sugs' });
      for (const s of scripts.suggestions) {
        const b = el('button', { class: 'vibe-sug' });
        b.append(
          el('div', { class: 'vibe-sug-text' }, s.text),
          el('div', { class: 'vibe-sug-hint muted' }, s.hint),
        );
        b.addEventListener('click', () => runSuggestion(s));
        sugs.appendChild(b);
      }
      inputWrap.appendChild(sugs);
    }

    const row = el('div', { class: 'vibe-input' });
    const textarea = el('textarea', { placeholder: 'Describe a change in plain language…', rows: '1' });
    if (busy) textarea.setAttribute('disabled', 'disabled');
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit(textarea.value);
        textarea.value = '';
      }
    });
    const sendBtn = el('button', { class: 'primary' }, busy ? 'Working…' : 'Send');
    if (busy) sendBtn.setAttribute('disabled', 'disabled');
    sendBtn.addEventListener('click', () => {
      submit(textarea.value);
      textarea.value = '';
    });
    row.append(textarea, sendBtn);
    inputWrap.appendChild(row);

    inputWrap.appendChild(
      el(
        'div',
        { class: 'vibe-foot muted2 mono' },
        '⚠ Vibe Mode never bypasses approval gates. Class I SCRs still route to platform-review; drift policy still gates auto-heal.',
      ),
    );
  }

  async function submit(raw) {
    const text = (raw ?? '').trim();
    if (!text || busy) return;
    firstUserSent = true;
    appendCard({ kind: 'user', body: text });
    renderInput();
    try {
      const intent = await api.vibeIntent(text);
      pushConsole({ level: 'info', text: `vibe › intent = ${intent.scenario ?? 'fallback'} (${intent.reason})` });
      if (intent.scenario && scripts?.scripts?.[intent.scenario]) {
        await appendScript(scripts.scripts[intent.scenario], intent.scenario);
      } else {
        const fb = await api.vibeLlmFallback(text);
        appendCard({ kind: 'agent_text', body: fb.text });
        pushConsole({
          level: fb.reachable ? 'info' : 'warn',
          text: fb.reachable ? 'vibe › llm fallback ok' : 'vibe › llm unreachable (graceful fallback)',
        });
      }
    } catch (err) {
      appendCard({ kind: 'agent_text', body: `Sorry — ${err.message}` });
    }
  }

  async function runSuggestion(s) {
    firstUserSent = true;
    appendCard({ kind: 'user', body: s.text });
    renderInput();
    pushConsole({ level: 'ok', text: `vibe › matched intent → ${s.key}` });
    if (scripts?.scripts?.[s.key]) await appendScript(scripts.scripts[s.key], s.key);
  }

  // -- console pane ----------------------------------------------------------

  function pushConsole(entry) {
    consoleEvents = [...consoleEvents, { t: nowStamp(), ...entry }];
    renderConsole();
  }

  function renderConsole() {
    consolePane.replaceChildren(
      el(
        'div',
        { class: 'vibe-console-h' },
        el('span', { class: 'mono' }, 'Process Console'),
        el('span', { class: 'mono muted2' }, `${consoleEvents.length} events`),
      ),
    );
    const body = el('div', { class: 'vibe-console-body' });
    for (const e of consoleEvents) {
      body.appendChild(
        el(
          'div',
          { class: `cons-line lvl-${e.level}` },
          el('span', { class: 'cons-t mono' }, e.t),
          el('span', { class: 'cons-x' }, e.text),
        ),
      );
    }
    consolePane.appendChild(body);
    body.scrollTop = body.scrollHeight;
  }

  return { element: root };
}

function nowStamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
