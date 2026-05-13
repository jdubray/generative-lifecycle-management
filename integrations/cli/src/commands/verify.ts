import {
  resolveConfig,
  type ResolvedConfig,
  type ResolveConfigInput,
} from '../lib/config.ts';
import { GlmClient, type VerifierGate, type VerifierRun } from '../lib/glm-client.ts';
import { CliError } from '../lib/errors.ts';
import { makeColorize, shouldUseColor, type Colorize } from '../lib/color.ts';
import type { ParsedArgs } from '../lib/argv.ts';

/**
 * `glm verify` — UC-03. POST /workspaces/:id/verify, render results
 * gate-by-gate, exit 0 if every gate passed, 1 otherwise.
 *
 * v0.1 hits the existing JSON endpoint. Each gate completes server-side
 * before the response lands, so "streaming" output is cosmetic — the
 * verifier finishes in well under a second for typical workspaces. SSE
 * upgrade tracked as a future polish item.
 *
 * Output:
 *   - Pretty (default): one line per gate with ✓/✗ glyph, plus indented
 *     issue list under failing gates (capped at 5 unless --verbose).
 *   - JSON (--json): the full VerificationRun on one line.
 *
 * Exit codes:
 *   0   overallPass = true
 *   1   overallPass = false (verifier ran successfully but at least one gate failed)
 *   69  server unreachable
 *   66  workspace not found
 *   77  auth failure
 */

export interface RunVerifyOptions {
  io?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
  clientFactory?: (cfg: ResolvedConfig) => GlmClient;
  resolveOverrides?: Omit<ResolveConfigInput, 'args'>;
  /** Force-enable / force-disable color (tests). */
  colorEnabled?: boolean;
}

const DEFAULT_ISSUE_LIMIT = 5;

export async function runVerify(args: ParsedArgs, opts: RunVerifyOptions = {}): Promise<number> {
  const io = opts.io ?? process;
  const stdout = io.stdout;
  const stderr = io.stderr;

  let config: ResolvedConfig;
  try {
    config = resolveConfig({ args, ...opts.resolveOverrides });
  } catch (err) {
    return reportError(err, stderr);
  }

  const client = (opts.clientFactory ?? defaultClientFactory)(config);

  let run: VerifierRun;
  try {
    run = await client.runVerifier(config.workspace);
  } catch (err) {
    return reportError(err, stderr);
  }

  if (config.json) {
    stdout.write(`${JSON.stringify(run)}\n`);
    return run.overallPass ? 0 : 1;
  }

  const useColor = shouldUseColor({
    enabled: opts.colorEnabled,
    stream: stdout as NodeJS.WritableStream & { isTTY?: boolean },
    flags: args.flags,
  });
  const c = makeColorize(useColor);
  // Use --verbose (not -v) since the dispatcher reserves -v for --version.
  const verbose = args.flags.verbose === true;

  renderPretty(stdout, run, c, verbose);
  return run.overallPass ? 0 : 1;
}

// ---------------------------------------------------------------------- render

function renderPretty(
  out: NodeJS.WritableStream,
  run: VerifierRun,
  c: Colorize,
  verbose: boolean,
): void {
  const gates = run.gateResults.gates ?? [];
  const longestName = gates.reduce((max, g) => Math.max(max, g.name.length), 0);

  out.write(c.bold(`Verifier run ${run.id} @ ${run.ts}\n`));
  out.write('\n');
  for (let i = 0; i < gates.length; i++) {
    const g = gates[i] as VerifierGate;
    const glyph = g.passed ? c.green('✓') : c.red('✗');
    const name = g.name.padEnd(longestName);
    out.write(`  ${glyph} gate ${i + 1}: ${name}  ${g.passed ? c.dim('pass') : c.red('FAIL')}\n`);
    if (!g.passed && g.issues.length > 0) {
      const shown = verbose ? g.issues : g.issues.slice(0, DEFAULT_ISSUE_LIMIT);
      for (const issue of shown) {
        out.write(`      ${c.dim('└')} ${issue}\n`);
      }
      const hidden = g.issues.length - shown.length;
      if (hidden > 0) {
        out.write(`      ${c.dim(`└ … ${hidden} more (use --verbose to show all)`)}\n`);
      }
    }
  }
  out.write('\n');
  const passCount = gates.filter((g) => g.passed).length;
  if (run.overallPass) {
    out.write(`${c.green('PASS')}: ${passCount}/${gates.length} gates passed\n`);
  } else {
    out.write(`${c.red('FAIL')}: ${passCount}/${gates.length} gates passed\n`);
  }
}

// --------------------------------------------------------------------- helpers

function defaultClientFactory(cfg: ResolvedConfig): GlmClient {
  return new GlmClient({ baseUrl: cfg.baseUrl, token: cfg.token });
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
