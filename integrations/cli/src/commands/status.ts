import { resolveConfig, type ResolvedConfig, type ResolveConfigInput } from '../lib/config.ts';
import { GlmClient, type WorkspaceSummary, type HealthResponse } from '../lib/glm-client.ts';
import { CliError } from '../lib/errors.ts';
import type { ParsedArgs } from '../lib/argv.ts';

/**
 * `glm status` — probe the GLM server and print a workspace summary.
 *
 * Exit codes:
 *   0   — server reachable, workspace exists, output written.
 *   69  — server unreachable.
 *   66  — workspace not found.
 *   77  — auth failure.
 *
 * Output: pretty text by default; JSON when `--json` is set.
 */
export interface RunStatusOptions {
  io?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
  clientFactory?: (cfg: ResolvedConfig) => GlmClient;
  /** Overrides for resolveConfig (env/file injection for tests). */
  resolveOverrides?: Omit<ResolveConfigInput, 'args'>;
}

export async function runStatus(args: ParsedArgs, opts: RunStatusOptions = {}): Promise<number> {
  const io = opts.io ?? process;
  const clientFactory = opts.clientFactory ?? defaultClientFactory;

  let config: ResolvedConfig;
  try {
    config = resolveConfig({ args, ...opts.resolveOverrides });
  } catch (err) {
    return reportError(err, io.stderr);
  }

  const client = clientFactory(config);

  let health: HealthResponse;
  try {
    health = await client.health();
  } catch (err) {
    return reportError(err, io.stderr);
  }

  let summary: WorkspaceSummary | undefined;
  let summaryError: Error | undefined;
  try {
    summary = await client.getWorkspaceSummary(config.workspace);
  } catch (err) {
    summaryError = err instanceof Error ? err : new Error(String(err));
  }

  if (config.json) {
    io.stdout.write(
      `${JSON.stringify({
        baseUrl: config.baseUrl,
        workspace: config.workspace,
        health,
        summary: summary ?? null,
        summaryError: summaryError?.message,
      })}\n`,
    );
  } else {
    formatPretty(io.stdout, config, health, summary, summaryError);
  }

  if (summaryError instanceof CliError) return summaryError.exitCode;
  if (summaryError) return 1;
  return 0;
}

function defaultClientFactory(cfg: ResolvedConfig): GlmClient {
  return new GlmClient({ baseUrl: cfg.baseUrl, token: cfg.token });
}

function formatPretty(
  out: NodeJS.WritableStream,
  config: ResolvedConfig,
  health: HealthResponse,
  summary: WorkspaceSummary | undefined,
  summaryError: Error | undefined,
): void {
  const lines: string[] = [];
  lines.push(`Server:     ${config.baseUrl}  (${health.service} ${health.version})`);
  lines.push(`Workspace:  ${config.workspace}`);
  lines.push(`Auth:       ${config.token ? 'token configured' : 'no token (anonymous)'}`);
  lines.push('');

  if (!summary) {
    lines.push('Workspace summary: unavailable');
    if (summaryError) lines.push(`  → ${summaryError.message}`);
  } else {
    lines.push(`Nodes:      ${summary.nodes.total} total`);
    for (const [stratum, count] of Object.entries(summary.nodes.byStratum)) {
      lines.push(`  ${stratum.padEnd(12)} ${count}`);
    }
    lines.push('');
    lines.push(`SCRs:       ${summary.scrs.active} active`);
    lines.push(`Drift:      ${summary.drift.drifted} open`);
    if (summary.verifier) {
      const v = summary.verifier;
      lines.push(`Verifier:   ${v.overallPass ? 'PASS' : 'FAIL'}  (ran ${v.ts})`);
    } else {
      lines.push('Verifier:   never run');
    }
  }

  out.write(`${lines.join('\n')}\n`);
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
