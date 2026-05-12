/**
 * Tiny REST client. Every call is same-origin so cookies travel automatically.
 * 401 responses bubble up — callers redirect to /login.
 */

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function call(method, path, body) {
  const headers = { accept: 'application/json' };
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api/v1${path}`, { method, headers, body: payload, credentials: 'same-origin' });
  const text = await res.text();
  const json = text ? safeParse(text) : null;
  if (!res.ok) {
    const message = json?.error?.message ?? `${res.status} ${res.statusText}`;
    throw new ApiError(message, res.status, json);
  }
  return json;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  // Auth
  me: () => call('GET', '/auth/me'),
  logout: () => call('POST', '/auth/logout'),

  // Workspaces
  listWorkspaces: () => call('GET', '/workspaces'),
  getWorkspace: (id) => call('GET', `/workspaces/${id}`),
  getSummary: (id) => call('GET', `/workspaces/${id}/summary`),
  createWorkspace: ({ slug, name }) => call('POST', '/workspaces', { slug, name }),
  importSekkei: ({ slug, name, documents, dryRun }) =>
    call('POST', '/workspaces/import', { slug, name, documents, dryRun: !!dryRun }),
  attachGitRemote: (workspaceId, { gitRemote, gitRef, gitForge, gitAutoPush }) =>
    call('POST', `/workspaces/${workspaceId}/git-remote`, { gitRemote, gitRef, gitForge, gitAutoPush }),
  detachGitRemote: (workspaceId) =>
    call('DELETE', `/workspaces/${workspaceId}/git-remote`),
  gitSync: (workspaceId) =>
    call('POST', `/workspaces/${workspaceId}/git-sync`),
  listGitConflicts: (workspaceId) =>
    call('GET', `/workspaces/${workspaceId}/git-conflicts`),

  // Nodes
  listNodes: (workspaceId, opts = {}) => {
    const params = new URLSearchParams();
    if (opts.stratum) params.set('stratum', opts.stratum);
    if (opts.status) params.set('status', opts.status);
    if (opts.include) params.set('include', opts.include);
    const qs = params.toString();
    return call('GET', `/workspaces/${workspaceId}/nodes${qs ? `?${qs}` : ''}`);
  },
  getNode: (workspaceId, glmId) =>
    call('GET', `/workspaces/${workspaceId}/nodes/${encodeURIComponent(glmId)}`),
  whereUsed: (workspaceId, glmId) =>
    call('GET', `/workspaces/${workspaceId}/nodes/${encodeURIComponent(glmId)}/where-used`),

  // Locks
  acquireLock: (workspaceId, glmId) =>
    call('POST', `/workspaces/${workspaceId}/nodes/${encodeURIComponent(glmId)}/lock`),
  heartbeatLock: (workspaceId, glmId) =>
    call('PUT', `/workspaces/${workspaceId}/nodes/${encodeURIComponent(glmId)}/lock/heartbeat`),
  releaseLock: (workspaceId, glmId) =>
    call('DELETE', `/workspaces/${workspaceId}/nodes/${encodeURIComponent(glmId)}/lock`),

  // SCRs
  listScrs: (workspaceId, status) => {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return call('GET', `/workspaces/${workspaceId}/scrs${qs}`);
  },
  getScr: (workspaceId, scrId) => call('GET', `/workspaces/${workspaceId}/scrs/${scrId}`),
  createScr: (workspaceId, body) =>
    call('POST', `/workspaces/${workspaceId}/scrs`, body),
  transitionScr: (workspaceId, scrId, event, reason) =>
    call('PUT', `/workspaces/${workspaceId}/scrs/${scrId}/status`, reason ? { event, reason } : { event }),
  approveScr: (workspaceId, scrId, decision, who) =>
    call('POST', `/workspaces/${workspaceId}/scrs/${scrId}/approvals`, who ? { decision, who } : { decision }),

  // Variants
  listVariants: (workspaceId) => call('GET', `/workspaces/${workspaceId}/variants`),
  createVariant: (workspaceId, body) => call('POST', `/workspaces/${workspaceId}/variants`, body),
  resolveVariant: (workspaceId, variantId, body) =>
    call('POST', `/workspaces/${workspaceId}/variants/${variantId}/resolve`, body),
  publishVariant: (workspaceId, variantId, body) =>
    call('POST', `/workspaces/${workspaceId}/variants/${variantId}/publish`, body),
  getRollout: (workspaceId, variantId) =>
    call('GET', `/workspaces/${workspaceId}/variants/${variantId}/rollout`),
  advanceRollout: (workspaceId, variantId, nodeId) =>
    call('PUT', `/workspaces/${workspaceId}/variants/${variantId}/rollout/${nodeId}/advance`),
  setPinPolicy: (workspaceId, variantId, nodeId, pinRev) =>
    call('PUT', `/workspaces/${workspaceId}/variants/${variantId}/rollout/${nodeId}/pin-policy`, { pinRev }),

  // Drift
  listDrift: (workspaceId, status) => {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return call('GET', `/workspaces/${workspaceId}/drift${qs}`);
  },
  sweepDrift: (workspaceId) => call('POST', `/workspaces/${workspaceId}/drift/sweep`),
  bulkAutoHeal: (workspaceId) => call('POST', `/workspaces/${workspaceId}/drift/auto-heal`),
  resolveDrift: (workspaceId, recordId, body) =>
    call('PUT', `/workspaces/${workspaceId}/drift/${recordId}/resolve`, body),

  // Reuse
  listReuse: (workspaceId, stage) => {
    const qs = stage ? `?stage=${encodeURIComponent(stage)}` : '';
    return call('GET', `/workspaces/${workspaceId}/reuse${qs}`);
  },
  findReuseCandidates: (workspaceId) =>
    call('POST', `/workspaces/${workspaceId}/reuse/find-candidates`),
  createReuse: (workspaceId, body) => call('POST', `/workspaces/${workspaceId}/reuse`, body),
  advanceReuseStage: (workspaceId, id, stage, steward) =>
    call('PUT', `/workspaces/${workspaceId}/reuse/${id}/stage`, steward ? { stage, steward } : { stage }),
  setReuseSteward: (workspaceId, id, steward) =>
    call('PUT', `/workspaces/${workspaceId}/reuse/${id}/steward`, { steward }),

  // Vibe Mode
  vibeScripts: () => call('GET', '/vibe/scripts'),
  vibeIntent: (message) => call('POST', '/vibe/intent', { message }),
  vibeContinue: (scenario, kind, payload) =>
    call('POST', '/vibe/continue', { scenario, kind, payload }),
  vibeLlmFallback: (message) => call('POST', '/vibe/llm-fallback', { message }),

  // Provenance
  listProvenance: (workspaceId, limit = 100) =>
    call('GET', `/workspaces/${workspaceId}/provenance?limit=${limit}`),
  getProvenance: (workspaceId, eventId) =>
    call('GET', `/workspaces/${workspaceId}/provenance/${eventId}`),
  exportProvenance: (workspaceId) =>
    fetch(`/api/v1/workspaces/${workspaceId}/provenance/export`, {
      method: 'POST',
      credentials: 'same-origin',
    }),
  verifyProvenance: (workspaceId) =>
    call('POST', `/workspaces/${workspaceId}/provenance/verify`),
};
