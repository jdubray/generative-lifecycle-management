import { writeFileSync } from 'node:fs';
import {
  resolveConfig,
  type ResolvedConfig,
  type ResolveConfigInput,
} from '../lib/config.ts';
import { GlmClient } from '../lib/glm-client.ts';
import { CliError, CliUsageError } from '../lib/errors.ts';
import type { ParsedArgs } from '../lib/argv.ts';

/**
 * `glm export-sekkei --workspace <id|slug> [--out <file.yaml>]`
 *
 * Fetches the full node tree for a workspace from the server and writes it
 * as a multi-document YAML file. The output is suitable for re-importing via
 * `glm import-sekkei` or storing in version control.
 *
 * Exit codes: 0 ok, 1 unexpected, 64 usage, 69 server unreachable, 77 auth.
 */

export interface RunExportOptions {
  io?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
  clientFactory?: (cfg: ResolvedConfig) => GlmClient;
  resolveOverrides?: Omit<ResolveConfigInput, 'args'>;
}

export async function runExport(args: ParsedArgs, opts: RunExportOptions = {}): Promise<number> {
  const io = opts.io ?? process;
  const stderr = io.stderr;
  const stdout = io.stdout;

  let config: ResolvedConfig;
  try {
    config = resolveConfig({ args, ...opts.resolveOverrides });
  } catch (err) {
    return reportError(err, stderr);
  }

  const outFile = stringFlag(args, 'out');
  const client = (opts.clientFactory ?? defaultClientFactory)(config);

  let yaml: string;
  try {
    yaml = await client.exportWorkspace(config.workspace);
  } catch (err) {
    return reportError(err, stderr);
  }

  if (outFile) {
    try {
      writeFileSync(outFile, yaml, 'utf8');
      stderr.write(`export-sekkei: wrote ${yaml.length} bytes to ${outFile}\n`);
    } catch (err) {
      return reportError(
        new CliUsageError(`failed to write ${outFile}: ${(err as Error).message}`),
        stderr,
      );
    }
  } else {
    stdout.write(yaml);
  }

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
