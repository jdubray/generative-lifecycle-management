import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from './errors.ts';
import type { ParsedArgs } from './argv.ts';

/**
 * Resolved CLI configuration. The precedence is:
 *
 *   1. argv flags     (--port, --workspace, --token, --model, --json)
 *   2. environment    (PORT, GLM_WORKSPACE, GLM_SOLO_TOKEN, GLM_CLAUDE_MODEL)
 *   3. config file    (~/.glm/config.json)
 *   4. built-in defaults
 *
 * The config file is optional. Missing or unreadable file is not an error;
 * malformed JSON is.
 */

export interface FileConfig {
  port?: number;
  workspace?: string;
  token?: string;
  model?: string;
}

export interface ResolvedConfig {
  /** TCP port of the local GLM server. */
  port: number;
  /** Workspace id to address. */
  workspace: string;
  /** Solo-mode bearer token (or undefined if unset). */
  token: string | undefined;
  /** Claude model name passed to `claude --model`. */
  model: string;
  /** When true, commands emit machine-readable JSON instead of pretty text. */
  json: boolean;
  /** Computed base URL, e.g. `http://localhost:3000`. */
  baseUrl: string;
}

export const DEFAULT_CONFIG: Required<Omit<FileConfig, 'token'>> & { model: string } = {
  port: 3000,
  workspace: 'default',
  model: 'claude-sonnet-4-6',
};

export function defaultConfigPath(home: string = homedir()): string {
  return join(home, '.glm', 'config.json');
}

export interface ResolveConfigInput {
  args: ParsedArgs;
  env?: Record<string, string | undefined>;
  configPath?: string;
  readFile?: (path: string) => string;
  fileExists?: (path: string) => boolean;
}

export function resolveConfig(input: ResolveConfigInput): ResolvedConfig {
  const env = input.env ?? process.env;
  const path = input.configPath ?? defaultConfigPath();
  const exists = input.fileExists ?? existsSync;
  const reader = input.readFile ?? ((p) => readFileSync(p, 'utf8'));

  const file: FileConfig = exists(path) ? parseFile(path, reader(path)) : {};

  const port = pickNumber(
    'port',
    input.args.flags.port,
    env.PORT,
    file.port,
    DEFAULT_CONFIG.port,
  );

  const workspace = pickString(
    input.args.flags.workspace,
    env.GLM_WORKSPACE,
    file.workspace,
    DEFAULT_CONFIG.workspace,
  );

  const token = pickStringOrUndefined(input.args.flags.token, env.GLM_SOLO_TOKEN, file.token);
  const model = pickString(input.args.flags.model, env.GLM_CLAUDE_MODEL, file.model, DEFAULT_CONFIG.model);

  return {
    port,
    workspace,
    token,
    model,
    json: input.args.flags.json === true,
    baseUrl: `http://localhost:${port}`,
  };
}

function parseFile(path: string, text: string): FileConfig {
  try {
    const parsed = JSON.parse(text) as FileConfig;
    if (typeof parsed !== 'object' || parsed === null) {
      throw new ConfigError(`config file ${path} must contain a JSON object`);
    }
    return parsed;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`failed to parse config file ${path}: ${message}`);
  }
}

function pickNumber(
  fieldName: string,
  ...candidates: Array<string | boolean | number | undefined>
): number {
  for (const c of candidates) {
    if (c === undefined || c === '' || typeof c === 'boolean') continue;
    const n = typeof c === 'number' ? c : Number.parseInt(String(c), 10);
    if (Number.isFinite(n) && n > 0) return n;
    throw new ConfigError(`invalid ${fieldName} value: ${String(c)}`);
  }
  // Unreachable when DEFAULT_CONFIG always supplies a fallback.
  throw new ConfigError(`no value resolved for ${fieldName}`);
}

function pickString(...candidates: Array<string | boolean | number | undefined>): string {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  throw new ConfigError('no value resolved');
}

function pickStringOrUndefined(
  ...candidates: Array<string | boolean | number | undefined>
): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return undefined;
}
