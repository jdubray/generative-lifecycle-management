/**
 * Typed CLI errors. Each carries an `exitCode` so the dispatcher can translate
 * the failure into a deterministic shell exit status (BSD sysexits-style codes).
 *
 *   1   generic failure (default for uncaught Error)
 *   2   command misuse (handled before we throw, but reserved)
 *   64  usage / argv (CliUsageError)        — EX_USAGE
 *   66  no input / missing config           — EX_NOINPUT
 *   69  service unavailable                 — EX_UNAVAILABLE
 *   70  internal software error             — EX_SOFTWARE
 *   77  permission / auth                   — EX_NOPERM
 *   78  config error                        — EX_CONFIG
 */

export class CliError extends Error {
  public readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export class CliUsageError extends CliError {
  constructor(message: string) {
    super(message, 64);
    this.name = 'CliUsageError';
  }
}

export class ConfigError extends CliError {
  constructor(message: string) {
    super(message, 78);
    this.name = 'ConfigError';
  }
}

export class ServerUnreachableError extends CliError {
  public readonly baseUrl: string;
  constructor(baseUrl: string, cause?: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : '';
    super(
      `GLM server not responding at ${baseUrl}${detail}. ` +
        `Start it with 'bun run src/server/server.ts' from the main repo, or run 'glm init'.`,
      69,
    );
    this.name = 'ServerUnreachableError';
    this.baseUrl = baseUrl;
  }
}

export class HttpError extends CliError {
  public readonly status: number;
  public readonly url: string;
  constructor(url: string, status: number, body: string) {
    const exit = status === 401 || status === 403 ? 77 : status === 404 ? 66 : 70;
    super(`HTTP ${status} from ${url}: ${body.slice(0, 500)}`, exit);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}
