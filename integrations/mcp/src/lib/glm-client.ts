import { HttpError, ServerUnreachableError } from './errors.ts';

/**
 * Minimal HTTP client for the GLM server, owning only the endpoints this MCP
 * server needs. Kept separate from the CLI's `glm-client.ts` so the two
 * packages can evolve independently — the wire protocol is the only shared
 * contract.
 *
 * `fetch` is injectable for tests.
 */

export interface GlmClientOptions {
  baseUrl: string;
  token: string | undefined;
  fetch?: typeof fetch;
}

export interface WorkspaceSummary {
  workspace: { id: string; slug: string; name: string };
  nodesByStratum: Record<string, number>;
  scrsByStatus: Record<string, number>;
  driftByStatus: Record<string, number>;
  tokens?: { in: number; out: number; hits: number; misses: number };
  lastVerifier?: {
    id: string;
    passed: boolean;
    completedAt: string;
    gateCount: number;
    passCount: number;
  } | null;
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

export interface NodeWithChildren {
  node: SekkeiNodeSummary & {
    body: unknown;
    contentHash: string;
    revisionMajor: string;
    revisionIteration: number;
  };
  parameters: unknown[];
  constraints: unknown[];
  relationships: Array<{ kind: string; targetGlmId: string } & Record<string, unknown>>;
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

export interface AcceptanceVerifyResult {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
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

  /** GET /api/v1/workspaces/:id/summary */
  async getWorkspaceSummary(workspaceId: string): Promise<WorkspaceSummary> {
    return this.get<WorkspaceSummary>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/summary`,
    );
  }

  /**
   * GET /api/v1/workspaces/:id/nodes?stratum=<s>
   *
   * Lists nodes in a workspace. When `stratum` is supplied (e.g. 'component'),
   * the server filters server-side. Returns the bare node array — no
   * relationships, no params.
   */
  async listNodes(
    workspaceId: string,
    opts: { stratum?: string } = {},
  ): Promise<{ nodes: SekkeiNodeSummary[] }> {
    const query = opts.stratum ? `?stratum=${encodeURIComponent(opts.stratum)}` : '';
    return this.get<{ nodes: SekkeiNodeSummary[] }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/nodes${query}`,
    );
  }

  /** GET /api/v1/workspaces/:id/nodes/:glm_id */
  async getNode(workspaceId: string, glmId: string): Promise<NodeWithChildren> {
    return this.get<NodeWithChildren>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/nodes/${encodeURIComponent(glmId)}`,
    );
  }

  /**
   * GET /api/v1/workspaces/:id/components/:glm_id/spec
   *
   * Composite endpoint backing `glm_get_component_spec`. Returns the
   * component node plus its `spec.prompt` and `spec.acceptance` children,
   * the resolved context bundle, the outputs list, the hard-constraints
   * suffix, and the workspace's `source_dir`.
   */
  async getComponentSpec(
    workspaceId: string,
    componentGlmId: string,
  ): Promise<ComponentSpecPayload> {
    const { spec } = await this.get<{ spec: ComponentSpecPayload }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/components/${encodeURIComponent(componentGlmId)}/spec`,
    );
    return spec;
  }

  /**
   * POST /api/v1/workspaces/:id/verify
   *
   * Run the 7-gate sekkei verifier and return the persisted VerificationRun.
   * Server-side operation; the gates are pure-code, no LLM.
   */
  async runVerifier(workspaceId: string): Promise<VerifierRun> {
    const { run } = await this.post<{ run: VerifierRun }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/verify`,
      {},
    );
    return run;
  }

  /**
   * POST /api/v1/workspaces/:id/acceptance-verify
   *
   * Run a component's authoritative `spec.acceptance.verifier.command`
   * via the platform shell with cwd = workspace.source_dir. The command
   * comes from the sekkei (not from the caller) so it can't be injected.
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

  // ----------------------------------------------------------------- core

  private async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let bodyInit: BodyInit | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyInit = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, { method, headers, body: bodyInit });
    } catch (err) {
      throw new ServerUnreachableError(this.baseUrl, err);
    }

    if (!response.ok) {
      const text = await safeReadText(response);
      throw new HttpError(url, response.status, text);
    }
    return (await response.json()) as T;
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
