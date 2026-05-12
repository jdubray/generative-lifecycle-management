import { api } from '../api.js';
import { el, section, kv, empty } from '../components/index.js';

/**
 * View 00 — Dashboard.
 *
 * Reads the workspace summary endpoint, renders three cards (sekkei graph,
 * change requests, drift) plus generation cost + a live activity feed.
 * Activity is filled from the WebSocket via the app-wide store, falling
 * back to `change_log` rows fetched at boot.
 */
export function dashboardView(ctx) {
  const root = el('section', { class: 'view view-dashboard' });
  const header = el(
    'div',
    { class: 'view-header' },
    el('span', { class: 'view-id mono' }, '00'),
    el('h1', {}, 'Dashboard'),
  );
  root.appendChild(header);

  const cardsRow = el('div', { class: 'cards' });
  root.appendChild(cardsRow);
  const sekkeiCard = el('div', { class: 'card' });
  const scrCard = el('div', { class: 'card' });
  const driftCard = el('div', { class: 'card' });
  cardsRow.append(sekkeiCard, scrCard, driftCard);

  const costSection = section({ title: 'Generation cost (recent)' }, empty('Loading…'));
  const gitSection = section({ title: 'Git binding' });
  const gitBody = gitSection.querySelector('.sec-body');
  const activitySection = section({ title: 'Recent activity', right: 'live' });
  const activityBody = el('div', { id: 'activity-feed' });
  activitySection.querySelector('.sec-body')?.appendChild(activityBody);
  root.appendChild(costSection);
  root.appendChild(gitSection);
  root.appendChild(activitySection);

  const renderActivity = (entries) => {
    activityBody.replaceChildren();
    if (entries.length === 0) {
      activityBody.appendChild(empty('No activity in this workspace yet.'));
      return;
    }
    for (const entry of entries) {
      activityBody.appendChild(
        el(
          'div',
          { class: 'activity-row' },
          el('span', { class: 'ts mono' }, entry.ts),
          el('span', { class: 'ev mono' }, entry.op ?? entry.type ?? '?'),
          el(
            'span',
            { class: 'subj' },
            entry.subject ?? entry.nodeId ?? entry.scrId ?? '(workspace event)',
          ),
          el('span', { class: 'actor mono' }, entry.userId ?? entry.by ?? '—'),
        ),
      );
    }
  };

  // Live updates from the store
  let activity = [];
  const onStoreChange = (state) => {
    activity = state.activity ?? [];
    renderActivity(activity.slice(0, 30));
  };
  const unsub = ctx.store.subscribe(onStoreChange);

  async function loadGit() {
    try {
      const { workspace } = await api.getWorkspace(ctx.workspaceId);
      renderGitSection(gitBody, workspace, ctx.workspaceId, loadGit);
    } catch (err) {
      gitBody.replaceChildren(el('div', { class: 'banner offline' }, `Failed to load git info: ${err.message}`));
    }
  }

  async function load() {
    try {
      const summary = await api.getSummary(ctx.workspaceId);
      renderSummary(summary, sekkeiCard, scrCard, driftCard, costSection);
      // Seed the store with persisted change_log rows
      ctx.store.set({
        activity: [
          ...summary.activity.map((a) => ({
            ts: a.ts,
            op: a.op,
            subject: a.nodeId ?? '(workspace)',
            userId: a.userId,
          })),
        ],
      });
    } catch (err) {
      root.appendChild(el('div', { class: 'banner offline' }, `Failed to load summary: ${err.message}`));
    }
  }
  load();
  loadGit();

  return { element: root, destroy: () => unsub() };
}

function renderSummary(s, sekkeiCard, scrCard, driftCard, costSection) {
  sekkeiCard.replaceChildren(
    el('h3', {}, 'Sekkei graph'),
    el('div', { class: 'big' }, String(s.nodes.total)),
    el('div', { class: 'muted' }, 'nodes total'),
    legend(s.nodes.byStratum),
  );
  scrCard.replaceChildren(
    el('h3', {}, 'Change requests'),
    el('div', { class: 'big' }, String(s.scrs.active)),
    el('div', { class: 'muted' }, 'active'),
    legend(s.scrs.byStatus),
  );
  driftCard.replaceChildren(
    el('h3', {}, 'Drift'),
    el('div', { class: 'big' }, String(s.drift.drifted)),
    el('div', { class: 'muted' }, 'drifted'),
    legend(s.drift.byStatus),
  );

  const cost = s.generation;
  const hitRatio = cost.cacheHits + cost.cacheMisses === 0
    ? '—'
    : `${Math.round((100 * cost.cacheHits) / (cost.cacheHits + cost.cacheMisses))}%`;
  const body = costSection.querySelector('.sec-body');
  body.replaceChildren(
    kv([
      ['Tokens in', String(cost.tokensIn.toLocaleString())],
      ['Tokens out', String(cost.tokensOut.toLocaleString())],
      ['Cache hits', String(cost.cacheHits)],
      ['Cache misses', String(cost.cacheMisses)],
      ['Hit ratio', hitRatio],
      ['Events considered', String(cost.eventsConsidered)],
    ]),
  );
}

function legend(obj) {
  const wrap = el('div', { class: 'legend' });
  for (const [k, v] of Object.entries(obj)) {
    wrap.appendChild(el('span', {}, `${k}: ${v}`));
  }
  return wrap;
}

/**
 * Render the git binding panel.
 *
 * When a remote is attached: shows the remote URL, ref, and HEAD commit with a
 * "Detach" button. When no remote is attached: shows an attach form.
 *
 * @param {HTMLElement} body - The `.sec-body` container to render into.
 * @param {object} workspace - The workspace record from the API.
 * @param {string} workspaceId - Used for API calls.
 * @param {() => void} reload - Called after attach/detach to refresh the panel.
 */
function renderGitSection(body, workspace, workspaceId, reload) {
  body.replaceChildren();

  if (workspace.gitRemote) {
    // Bound state
    body.appendChild(
      kv([
        ['Remote', workspace.gitRemote],
        ['Ref', workspace.gitRef ?? '—'],
        ['HEAD', workspace.gitCommit ? workspace.gitCommit.slice(0, 12) : '—'],
        ['Clone dir', workspace.gitCloneDir ?? '—'],
        ['Forge', workspace.gitForge ?? 'none'],
        ['Auto-push', workspace.gitAutoPush ? 'yes' : 'no'],
      ]),
    );

    const actionsRow = el('div', { class: 'git-actions' });

    const syncBtn = el('button', { class: 'btn btn-primary btn-sm' }, 'Sync');
    const statusDiv = el('div', { class: 'git-sync-status' });
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = 'Syncing…';
      statusDiv.textContent = '';
      statusDiv.className = 'git-sync-status';
      try {
        const result = await api.gitSync(workspaceId);
        if (result.conflict) {
          statusDiv.textContent = 'Conflict: remote has diverged. Detach and re-attach to recover.';
          statusDiv.classList.add('git-sync-conflict');
        } else if (result.newCommit) {
          statusDiv.textContent = `Synced → ${result.newCommit.slice(0, 12)} (${result.nodesUpdated} node${result.nodesUpdated === 1 ? '' : 's'} updated)`;
          statusDiv.classList.add('git-sync-ok');
          reload();
        } else {
          statusDiv.textContent = 'Already up to date.';
          statusDiv.classList.add('git-sync-ok');
        }
      } catch (err) {
        statusDiv.textContent = `Sync failed: ${err.message}`;
        statusDiv.classList.add('git-sync-conflict');
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = 'Sync';
      }
    });

    const detachBtn = el('button', { class: 'btn btn-ghost btn-sm' }, 'Detach');
    detachBtn.addEventListener('click', async () => {
      detachBtn.disabled = true;
      detachBtn.textContent = 'Detaching…';
      try {
        await api.detachGitRemote(workspaceId);
        reload();
      } catch (err) {
        detachBtn.disabled = false;
        detachBtn.textContent = 'Detach';
        body.appendChild(el('div', { class: 'banner error' }, `Detach failed: ${err.message}`));
      }
    });

    actionsRow.append(syncBtn, detachBtn);
    body.append(actionsRow, statusDiv);
    return;
  }

  // Unbound state — show attach form
  const form = el('form', { class: 'git-attach-form' });
  const remoteInput = el('input', {
    type: 'text',
    name: 'gitRemote',
    placeholder: 'git@github.com:org/repo.git',
    required: '',
    class: 'git-input',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const refInput = el('input', {
    type: 'text',
    name: 'gitRef',
    placeholder: 'refs/heads/main (optional)',
    class: 'git-input',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const submitBtn = el('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, 'Attach remote');
  const errDiv = el('div', { class: 'banner error', style: 'display:none' });

  form.append(
    el('label', { class: 'git-label' }, 'Remote URL', remoteInput),
    el('label', { class: 'git-label' }, 'Branch / ref', refInput),
    submitBtn,
    errDiv,
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errDiv.style.display = 'none';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Cloning…';
    try {
      await api.attachGitRemote(workspaceId, {
        gitRemote: remoteInput.value.trim(),
        gitRef: refInput.value.trim() || undefined,
      });
      reload();
    } catch (err) {
      errDiv.textContent = `Attach failed: ${err.message}`;
      errDiv.style.display = '';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Attach remote';
    }
  });

  body.appendChild(form);
}
