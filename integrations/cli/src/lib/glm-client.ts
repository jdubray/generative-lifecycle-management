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

export interface WorkspaceSummary {
  workspace: Workspace;
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
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (opts.auth !== false && this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
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
