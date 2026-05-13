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

  // ----------------------------------------------------------------- core

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
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
