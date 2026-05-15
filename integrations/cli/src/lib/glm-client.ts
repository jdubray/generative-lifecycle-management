import { HttpError, ServerUnreachableError } from './errors.ts';

/**
 * Typed HTTP client for the GLM server's REST API.
 *
 * The CLI owns no shared types with the server module on purpose — the only
 * coupling is the wire protocol. Response shapes here are minimal: only the
 * fields the CLI actually reads. Add more as commands need them.
 *
 * `fetch` is injectable to keep unit tests offline and deterministic.
 */

export interface GlmClientOptions {
  /** Base URL of the GLM server, e.g. `http://localhost:3000`. No trailing slash. */
  baseUrl: string;
  /** Bearer token (Solo mode `GLM_SOLO_TOKEN`). Optional for `/health`. */
  token?: string | undefined;
  /** Inject a custom fetch (tests). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  createdAt?: string;
}

/**
 * Shape of `GET /api/v1/workspaces/:id/summary`. Mirrors the nested payload
 * the server emits (see src/server/routes/workspaces.ts) — keep in sync.
 */
export interface WorkspaceSummary {
  workspace: Workspace;
  nodes: { total: number; byStratum: Record<string, number> };
  scrs: { active: number; byStatus: Record<string, number> };
  drift: { drifted: number; byStatus: Record<string, number> };
  generation: {
    eventsConsidered: number;
    tokensIn: number;
    tokensOut: number;
    cacheHits: number;
    cacheMisses: number;
  };
  verifier: { id: string; ts: string; overallPass: boolean } | null;
  activity?: unknown[];
}

export interface ImportSekkeiRequest {
  slug: string;
  name?: string;
  /** Multi-document YAML produced by `glm vibe` (or supplied as a file). */
  yaml: string;
  /** Filename to record with the document — defaults to `sekkei.yaml`. */
  filename?: string;
  dryRun?: boolean;
}

export interface ImportSekkeiResult {
  workspaceId: string;
  workspace: Workspace;
  summary: {
    nodesInserted: number;
    nodesUpdated: number;
    nodesUnchanged: number;
    nodesRejected?: number;
    dryRun?: boolean;
  } & Record<string, unknown>;
}

export interface VerifierGate {
  name: string;
  passed: boolean;
  issues: string[];
}

export interface VerifierRun {
  id: string;
  workspaceId: string;
  ts: string;
  overallPass: boolean;
  gateResults: { gates: VerifierGate[] };
}

export interface SoloGenerateRequest {
  componentGlmId: string;
  /** Absolute path; persisted onto the workspace if provided. */
  sourceDir?: string;
  dryRun?: boolean;
}

export interface SoloGenerateResult {
  componentGlmId: string;
  outputDir: string;
  dryRun: boolean;
  filesWritten: Array<{ path: string; bytes: number; sha256: string }>;
  verifier: { command: string; exitCode: number; stdout: string; stderr: string };
  provenance: { id: string; subjectDigest: string } | null;
  durationMs: number;
}

export interface SekkeiNodeSummary {
  id: string;
  glmId: string;
  stratum: string;
  title: string;
  description: string;
  revisionStatus: string;
  systemRole?: string | null;
  specKind?: string | null;
}

export interface ComponentSpecPayload {
  component: SekkeiNodeSummary & { body: unknown; contentHash: string };
  specPrompt: SekkeiNodeSummary & { body: unknown; contentHash: string };
  specAcceptance: SekkeiNodeSummary & { body: unknown; contentHash: string };
  outputs: Array<{ path: string; description?: string }>;
  contextBundle: { text: string; bindingHash: string };
  hardConstraints: string;
  sourceDir: string | null;
  promptTemplate: string;
  verifierCommand: string;
}

export interface AcceptanceVerifyResult {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RecordGenerationRequest {
  componentId: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  verifierExitCode: number;
  bindingHash?: string;
  generatorIdentity?: string;
  durationMs?: number;
  note?: string | null;
}

export interface ProvenanceEvent {
  id: string;
  workspaceId: string;
  occurredAt: string;
  subjectFile: string;
  subjectDigest: string;
  sekkeiRoot: string;
  sekkeiRev: string;
  bindingHash: string;
  generatorLlm: string;
  generatorPromptVersion: string;
  durationMs: number;
  note: string | null;
}

export interface NodeWithChildren {
  node: {
    id: string;
    glmId: string;
    stratum: string;
    title: string;
    body: unknown;
    contentHash: string;
    revisionMajor: string;
    revisionIteration: number;
    revisionStatus: string;
    overrideKind: string;
    systemRole?: string | null;
    specKind?: string | null;
  };
  parameters: unknown[];
  constraints: unknown[];
  relationships: unknown[];
}

export class GlmClient {
  public readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GlmClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Unauthenticated server probe. Returns `null` if the server isn't reachable. */
  async health(): Promise<HealthResponse> {
    return this.get<HealthResponse>('/api/v1/health', { auth: false });
  }

  /** List all workspaces the caller belongs to. Requires auth. */
  async listWorkspaces(): Promise<Workspace[]> {
    const { workspaces } = await this.get<{ workspaces: Workspace[] }>('/api/v1/workspaces');
    return workspaces;
  }

  /** Workspace existence + identity. Requires auth. */
  async getWorkspace(id: string): Promise<Workspace> {
    const { workspace } = await this.get<{ workspace: Workspace }>(
      `/api/v1/workspaces/${encodeURIComponent(id)}`,
    );
    return workspace;
  }

  /** Aggregated dashboard counts for a workspace. Requires auth. */
  async getWorkspaceSummary(id: string): Promise<WorkspaceSummary> {
    return this.get<WorkspaceSummary>(`/api/v1/workspaces/${encodeURIComponent(id)}/summary`);
  }

  /**
   * PATCH /api/v1/workspaces/:id — partial update. v1 supports `sourceDir`.
   * Used by `glm generate --source-dir` to persist the path before driving
   * the spec / verifier / record-generation flow.
   */
  async setSourceDir(workspaceId: string, sourceDir: string): Promise<void> {
    await this.send<unknown>('PATCH', `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`, {
      sourceDir,
    });
  }

  /**
   * POST /api/v1/workspaces/import — create-or-update workspace from a sekkei
   * YAML document. The server creates the workspace if `slug` is new and
   * returns the import summary (inserted / updated / unchanged counts).
   */
  async importSekkei(req: ImportSekkeiRequest): Promise<ImportSekkeiResult> {
    return this.post<ImportSekkeiResult>('/api/v1/workspaces/import', {
      slug: req.slug,
      name: req.name ?? req.slug,
      documents: [{ filename: req.filename ?? 'sekkei.yaml', content: req.yaml }],
      dryRun: req.dryRun ?? false,
    });
  }

  /**
   * POST /api/v1/workspaces/:id/verify — run the 6-gate verifier and return
   * the persisted VerificationRun row. Requires auth.
   */
  async runVerifier(workspaceId: string): Promise<VerifierRun> {
    const { run } = await this.post<{ run: VerifierRun }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/verify`,
      {},
    );
    return run;
  }

  /**
   * POST /api/v1/workspaces/:id/solo-generate — Solo-mode UC-02. Resolves the
   * component's spec.prompt, spawns claude server-side, writes outputs to
   * `source_dir`, runs the acceptance verifier, returns the result.
   *
   * Long-running: the server holds the connection open for the duration of
   * the LLM call (typically 10-60s). Callers should not impose a short
   * client-side timeout.
   */
  async soloGenerate(
    workspaceId: string,
    req: SoloGenerateRequest,
  ): Promise<SoloGenerateResult> {
    const { result } = await this.post<{ result: SoloGenerateResult }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/solo-generate`,
      {
        component_id: req.componentGlmId,
        source_dir: req.sourceDir,
        dry_run: req.dryRun ?? false,
      },
    );
    return result;
  }

  /**
   * GET /api/v1/workspaces/:id/components/:glm_id/spec — composite endpoint
   * that bundles component + spec.prompt + spec.acceptance + resolved
   * context bundle + outputs[] + hard_constraints + source_dir. Used by
   * the CLI's client-side generate flow (and by the MCP server).
   */
  async getComponentSpec(workspaceId: string, componentGlmId: string): Promise<ComponentSpecPayload> {
    const { spec } = await this.get<{ spec: ComponentSpecPayload }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/components/${encodeURIComponent(componentGlmId)}/spec`,
    );
    return spec;
  }

  /**
   * POST /api/v1/workspaces/:id/acceptance-verify — run a component's
   * authoritative `spec.acceptance.verifier.command` in source_dir.
   * Returns { command, cwd, exitCode, stdout, stderr, durationMs }.
   */
  async runAcceptanceVerify(
    workspaceId: string,
    componentGlmId: string,
  ): Promise<AcceptanceVerifyResult> {
    const { result } = await this.post<{ result: AcceptanceVerifyResult }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/acceptance-verify`,
      { componentId: componentGlmId },
    );
    return result;
  }

  /**
   * POST /api/v1/workspaces/:id/record-generation — attest a completed
   * client-driven generation. Inserts provenance + audit; returns the
   * inserted provenance.
   */
  async recordGeneration(
    workspaceId: string,
    req: RecordGenerationRequest,
  ): Promise<ProvenanceEvent> {
    const { provenance } = await this.post<{ provenance: ProvenanceEvent }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/record-generation`,
      req,
    );
    return provenance;
  }

  /**
   * GET /api/v1/workspaces/:id/export — export all nodes as multi-document YAML.
   * Returns the raw YAML text (Content-Type: text/yaml). Requires auth.
   */
  async exportWorkspace(workspaceId: string): Promise<string> {
    const url = `${this.baseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/export`;
    const headers: Record<string, string> = { Accept: 'text/yaml' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers });
    } catch (err) {
      throw new ServerUnreachableError(this.baseUrl, err);
    }
    if (!response.ok) {
      const body = await safeReadText(response);
      throw new HttpError(url, response.status, body);
    }
    return response.text();
  }

  /** GET /api/v1/workspaces/:id/nodes/:glm_id */
  async getNode(workspaceId: string, glmId: string): Promise<NodeWithChildren> {
    return this.get<NodeWithChildren>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/nodes/${encodeURIComponent(glmId)}`,
    );
  }

  /**
   * PUT /api/v1/workspaces/:id/nodes/:glm_id — replace the node's body.
   * Requires the caller to hold the soft-lock (acquire via `acquireLock` first).
   */
  async updateNode(workspaceId: string, glmId: string, input: Record<string, unknown>): Promise<NodeWithChildren['node']> {
    const { node } = await this.put<{ node: NodeWithChildren['node'] }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/nodes/${encodeURIComponent(glmId)}`,
      input,
    );
    return node;
  }

  /** POST /api/v1/workspaces/:id/nodes/:glm_id/lock */
  async acquireLock(workspaceId: string, glmId: string): Promise<void> {
    await this.post<unknown>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/nodes/${encodeURIComponent(glmId)}/lock`,
      {},
    );
  }

  /** DELETE /api/v1/workspaces/:id/nodes/:glm_id/lock */
  async releaseLock(workspaceId: string, glmId: string): Promise<void> {
    await this.delete<unknown>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/nodes/${encodeURIComponent(glmId)}/lock`,
    );
  }

  // --------------------------------------------------------------------- core

  private async get<T>(path: string, opts: { auth?: boolean } = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.auth !== false && this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers });
    } catch (err) {
      throw new ServerUnreachableError(this.baseUrl, err);
    }

    if (!response.ok) {
      const body = await safeReadText(response);
      throw new HttpError(url, response.status, body);
    }

    return (await response.json()) as T;
  }

  private async post<T>(path: string, body: unknown, opts: { auth?: boolean } = {}): Promise<T> {
    return this.send<T>('POST', path, body, opts);
  }

  private async put<T>(path: string, body: unknown, opts: { auth?: boolean } = {}): Promise<T> {
    return this.send<T>('PUT', path, body, opts);
  }

  private async delete<T>(path: string, opts: { auth?: boolean } = {}): Promise<T> {
    return this.send<T>('DELETE', path, undefined, opts);
  }

  private async send<T>(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body: unknown,
    opts: { auth?: boolean } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.auth !== false && this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ServerUnreachableError(this.baseUrl, err);
    }

    if (!response.ok) {
      const text = await safeReadText(response);
      throw new HttpError(url, response.status, text);
    }

    // DELETE responses may be empty.
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return undefined as unknown as T;
    }
    const text = await response.text();
    if (text.length === 0) return undefined as unknown as T;
    return JSON.parse(text) as T;
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
