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
