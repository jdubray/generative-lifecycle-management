import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import {
  resolveConfig,
  type ResolvedConfig,
  type ResolveConfigInput,
} from '../lib/config.ts';
import { GlmClient, type ImportSekkeiResult } from '../lib/glm-client.ts';
import { CliError, CliUsageError } from '../lib/errors.ts';
import type { ParsedArgs } from '../lib/argv.ts';

/**
 * `glm import-sekkei <file.yaml> --slug <id> [--name <name>] [--dry-run] [--json]`
 *
 * Thin wrapper over POST /api/v1/workspaces/import. Reads a (possibly multi-
 * document) YAML file from disk and posts it as a single `documents[0]`. The
 * server's importer splits on `---` and processes each document.
 *
 * Exit codes mirror the other commands: 0 ok, 1 unexpected, 64 usage,
 * 66 file not found, 69 server unreachable, 70 HTTP 5xx, 77 auth.
 */

export interface RunImportSekkeiOptions {
  io?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
  clientFactory?: (cfg: ResolvedConfig) => GlmClient;
  resolveOverrides?: Omit<ResolveConfigInput, 'args'>;
}

export async function runImportSekkei(
  args: ParsedArgs,
  opts: RunImportSekkeiOptions = {},
): Promise<number> {
  const io = opts.io ?? process;
  const stderr = io.stderr;
  const stdout = io.stdout;

  let config: ResolvedConfig;
  try {
    config = resolveConfig({ args, ...opts.resolveOverrides });
  } catch (err) {
    return reportError(err, stderr);
  }

  const filePath = args.positional[0];
  if (!filePath) {
    return reportError(new CliUsageError('a YAML file path is required (positional argument)'), stderr);
  }
  const slug = stringFlag(args, 'slug');
  if (!slug) {
    return reportError(new CliUsageError('--slug is required'), stderr);
  }
  const name = stringFlag(args, 'name') ?? slug;
  const dryRun = args.flags['dry-run'] === true;

  const abs = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  if (!existsSync(abs)) {
    return reportError(new CliUsageError(`file not found: ${abs}`), stderr);
  }
  let st;
  try {
    st = statSync(abs);
  } catch (err) {
    return reportError(
      new CliUsageError(`cannot read file ${abs}: ${(err as Error).message}`),
      stderr,
    );
  }
  if (!st.isFile()) {
    return reportError(new CliUsageError(`not a file: ${abs}`), stderr);
  }

  let yaml: string;
  try {
    yaml = readFileSync(abs, 'utf8');
  } catch (err) {
    return reportError(
      new CliUsageError(`failed to read ${abs}: ${(err as Error).message}`),
      stderr,
    );
  }

  const client = (opts.clientFactory ?? defaultClientFactory)(config);
  let result: ImportSekkeiResult;
  try {
    result = await client.importSekkei({
      slug,
      name,
      yaml,
      filename: basename(abs),
      dryRun,
    });
  } catch (err) {
    return reportError(err, stderr);
  }

  if (config.json) {
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  const s = result.summary;
  stdout.write(
    `import-sekkei: posted ${basename(abs)} → workspace '${result.workspace.slug}' (id ${result.workspaceId})\n` +
      `  inserted   ${s.nodesInserted}\n` +
      `  updated    ${s.nodesUpdated}\n` +
      `  unchanged  ${s.nodesUnchanged}\n` +
      (s.nodesRejected !== undefined ? `  rejected   ${s.nodesRejected}\n` : '') +
      (s.dryRun ? '  (dry-run — nothing committed)\n' : ''),
  );
  return 0;
}

// ---------------------------------------------------------------------- helpers

function defaultClientFactory(cfg: ResolvedConfig): GlmClient {
  return new GlmClient({ baseUrl: cfg.baseUrl, token: cfg.token });
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function reportError(err: unknown, stderr: NodeJS.WritableStream): number {
  if (err instanceof CliError) {
    stderr.write(`glm: ${err.message}\n`);
    return err.exitCode;
  }
  const message = err instanceof Error ? err.message : String(err);
  stderr.write(`glm: unexpected error: ${message}\n`);
  return 1;
}
