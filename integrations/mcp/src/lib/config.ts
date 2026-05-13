import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from './errors.ts';

/**
 * Resolved server configuration for the MCP process.
 *
 * Reads `~/.glm/config.json` (same file `glm init` writes for the CLI), then
 * applies env overrides:
 *
 *   - `PORT`             → port
 *   - `GLM_WORKSPACE`    → workspace
 *   - `GLM_SOLO_TOKEN`   → token
 *
 * Stdio MCP servers can't take CLI flags — the host (Claude Code) launches
 * them via stdio with whatever `args`/`env` are in its settings.json. So
 * config-file + env are the only knobs.
 */

export interface FileConfig {
  port?: number;
  workspace?: string;
  token?: string;
}

export interface ResolvedConfig {
  port: number;
  workspace: string;
  token: string | undefined;
  baseUrl: string;
}

export const DEFAULTS = {
  port: 3000,
  workspace: 'default',
} as const;

export function defaultConfigPath(home: string = homedir()): string {
  return join(home, '.glm', 'config.json');
}

export interface ResolveConfigInput {
  env?: Record<string, string | undefined>;
  configPath?: string;
  readFile?: (path: string) => string;
  fileExists?: (path: string) => boolean;
}

export function resolveConfig(input: ResolveConfigInput = {}): ResolvedConfig {
  const env = input.env ?? process.env;
  const path = input.configPath ?? defaultConfigPath();
  const exists = input.fileExists ?? existsSync;
  const reader = input.readFile ?? ((p) => readFileSync(p, 'utf8'));

  const file: FileConfig = exists(path) ? parseFile(path, reader(path)) : {};

  const port = pickNumber(env.PORT, file.port, DEFAULTS.port);
  const workspace = pickString(env.GLM_WORKSPACE, file.workspace, DEFAULTS.workspace);
  const token = pickStringOrUndefined(env.GLM_SOLO_TOKEN, file.token);

  return {
    port,
    workspace,
    token,
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

function pickNumber(...candidates: Array<string | number | undefined>): number {
  for (const c of candidates) {
    if (c === undefined || c === '') continue;
    const n = typeof c === 'number' ? c : Number.parseInt(String(c), 10);
    if (Number.isFinite(n) && n > 0) return n;
    throw new ConfigError(`invalid port value: ${String(c)}`);
  }
  throw new ConfigError('no port resolved');
}

function pickString(...candidates: Array<string | undefined>): string {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  throw new ConfigError('no value resolved');
}

function pickStringOrUndefined(...candidates: Array<string | undefined>): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return undefined;
}
