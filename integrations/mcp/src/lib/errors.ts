/**
 * Typed errors for the MCP server. The MCP transport converts thrown errors to
 * tool error responses; callers don't need to catch these.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class ServerUnreachableError extends Error {
  public readonly baseUrl: string;
  public readonly cause: unknown;
  constructor(baseUrl: string, cause: unknown) {
    super(`GLM server not responding at ${baseUrl} (${describeCause(cause)})`);
    this.name = 'ServerUnreachableError';
    this.baseUrl = baseUrl;
    this.cause = cause;
  }
}

export class HttpError extends Error {
  public readonly url: string;
  public readonly status: number;
  public readonly body: string;
  constructor(url: string, status: number, body: string) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
    this.url = url;
    this.status = status;
    this.body = body;
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
