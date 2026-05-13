import { isAbsolute, resolve } from 'node:path';
import {
  resolveConfig,
  type ResolvedConfig,
  type ResolveConfigInput,
} from '../lib/config.ts';
import { GlmClient, type SoloGenerateResult } from '../lib/glm-client.ts';
import { CliError, CliUsageError } from '../lib/errors.ts';
import { makeColorize, shouldUseColor } from '../lib/color.ts';
import type { ParsedArgs } from '../lib/argv.ts';

/**
 * `glm generate` — UC-02. POST /workspaces/:id/solo-generate, render the
 * server's SoloGenerateResult, exit 0/1.
 *
 * The server is doing the heavy work (claude subprocess + file I/O + verifier).
 * The CLI just relays a single HTTP round-trip and pretty-prints the result.
 *
 * Required:
 *   --component <glm-id>     e.g. acme:web.shop.catalog.product_repository
 * Optional:
 *   --source-dir <abs-path>  persisted onto the workspace
 *   --dry-run                files written to a staging dir, no provenance
 *   --json                   machine-readable result on stdout
 *   --no-color               disable ANSI even on a TTY
 *
 * Exit codes:
 *   0   success — files on disk + verifier green + provenance recorded
 *   1   verifier failed or other non-CliError error
 *   64  usage (missing --component, relative --source-dir)
 *   66  workspace or component not found
 *   69  GLM server unreachable
 *   70  HTTP 4xx/5xx from server
 *   77  auth failure
 */

export interface RunGenerateOptions {
  io?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
  clientFactory?: (cfg: ResolvedConfig) => GlmClient;
  resolveOverrides?: Omit<ResolveConfigInput, 'args'>;
  colorEnabled?: boolean;
}

export async function runGenerate(args: ParsedArgs, opts: RunGenerateOptions = {}): Promise<number> {
  const io = opts.io ?? process;
  const stdout = io.stdout;
  const stderr = io.stderr;

  let config: ResolvedConfig;
  try {
    config = resolveConfig({ args, ...opts.resolveOverrides });
  } catch (err) {
    return reportError(err, stderr);
  }

  const componentGlmId = stringFlag(args, 'component');
  if (!componentGlmId) {
    return reportError(new CliUsageError('--component is required'), stderr);
  }

  let sourceDir: string | undefined;
  const sourceDirRaw = stringFlag(args, 'source-dir');
  if (sourceDirRaw !== undefined) {
    // Resolve to absolute now so the server gets an unambiguous path even if
    // the user passed a relative one. The server still validates.
    const abs = isAbsolute(sourceDirRaw) ? sourceDirRaw : resolve(process.cwd(), sourceDirRaw);
    sourceDir = abs;
  }

  const dryRun = args.flags['dry-run'] === true;

  const client = (opts.clientFactory ?? defaultClientFactory)(config);

  stderr.write(`generate: invoking ${config.model} on component '${componentGlmId}'…\n`);
  let result: SoloGenerateResult;
  try {
    result = await client.soloGenerate(config.workspace, {
      componentGlmId,
      sourceDir,
      dryRun,
    });
  } catch (err) {
    return reportError(err, stderr);
  }

  const useColor = shouldUseColor({
    enabled: opts.colorEnabled,
    stream: stdout as NodeJS.WritableStream & { isTTY?: boolean },
    flags: args.flags,
  });
  const c = makeColorize(useColor);

  if (config.json) {
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  stdout.write(`${c.bold('Generated')} ${componentGlmId}\n`);
  stdout.write(`  output dir:  ${result.outputDir}${result.dryRun ? c.yellow(' (dry-run)') : ''}\n`);
  stdout.write(`  files:       ${result.filesWritten.length}\n`);
  for (const f of result.filesWritten) {
    stdout.write(`    ${c.dim('└')} ${f.path}  (${f.bytes} bytes)\n`);
  }
  stdout.write(
    `  verifier:    ${c.green('PASS')}  (exit ${result.verifier.exitCode}, ${result.durationMs} ms total)\n`,
  );
  if (result.provenance) {
    stdout.write(`  provenance:  ${result.provenance.id}\n`);
  } else if (result.dryRun) {
    stdout.write(`  provenance:  ${c.dim('(skipped — dry-run)')}\n`);
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
