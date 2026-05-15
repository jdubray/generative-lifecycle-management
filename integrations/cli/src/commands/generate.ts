import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import {
  resolveConfig,
  type ResolvedConfig,
  type ResolveConfigInput,
} from '../lib/config.ts';
import {
  GlmClient,
  type AcceptanceVerifyResult,
  type ComponentSpecPayload,
  type ProvenanceEvent,
} from '../lib/glm-client.ts';
import { CliError, CliUsageError } from '../lib/errors.ts';
import { makeColorize, shouldUseColor } from '../lib/color.ts';
import { runOneShot, type RunOneShotOptions } from '../lib/claude-cli.ts';
import {
  buildSystemPrompt,
  buildUserPrompt,
  GenerateError,
  lintGeneratedFiles,
  parseMultiFileResponse,
  resolveSafePath,
} from '../lib/generate-spec.ts';
import type { ParsedArgs } from '../lib/argv.ts';

/**
 * `glm generate` — UC-02.
 *
 * Drives a full client-side generation: fetch the component spec from the
 * server, spawn claude in the user's shell (the same path `glm vibe` uses —
 * proven to work cross-platform), parse the multi-file response, write the
 * files under `source_dir`, run the acceptance verifier server-side, and
 * record provenance.
 *
 * This replaces the previous server-side `/solo-generate` invocation, which
 * hangs on Windows when Bun.spawn launches claude.exe from inside a long-
 * running Bun.serve. The server-side route is preserved but unused by the
 * CLI; see docs/mcp-fork-plan.md for context.
 *
 * Required:
 *   --component <glm-id>     e.g. acme:web.shop.catalog.product_repository
 * Optional:
 *   --source-dir <abs-path>  persisted onto the workspace; required if
 *                            the workspace has no source_dir set
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
 *   70  claude CLI failed / spec error
 *   77  auth failure
 */

export interface RunGenerateOptions {
  io?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
  clientFactory?: (cfg: ResolvedConfig) => GlmClient;
  resolveOverrides?: Omit<ResolveConfigInput, 'args'>;
  colorEnabled?: boolean;
  /** Override claude-cli spawn for tests. */
  claudeRunner?: (opts: RunOneShotOptions) => Promise<{ stdout: string; stderr: string }>;
  /**
   * Override `process.platform` for tests. The CLI refuses to run `generate`
   * on Windows because spawning claude from a CLI process there has the same
   * hang we hit server-side — see docs/mcp-fork-plan.md. Windows users are
   * redirected to `/glm-generate` in Claude Code (via the MCP integration).
   */
  platform?: NodeJS.Platform;
  /** Bypass the Windows guard (escape hatch for diagnostics). */
  allowUnsupportedPlatform?: boolean;
}

export interface GenerateResult {
  componentGlmId: string;
  outputDir: string;
  dryRun: boolean;
  filesWritten: Array<{ path: string; bytes: number; sha256: string }>;
  verifier: AcceptanceVerifyResult;
  provenance: ProvenanceEvent | null;
  durationMs: number;
}

export async function runGenerate(args: ParsedArgs, opts: RunGenerateOptions = {}): Promise<number> {
  const io = opts.io ?? process;
  const stdout = io.stdout;
  const stderr = io.stderr;

  // Platform note: an earlier build blocked Windows here because we believed
  // spawning claude.exe from a CLI process hung indefinitely. End-to-end
  // testing showed it was actually slow (~10 min on large prompts), not
  // hung — the original 240s server-side timeout was killing it mid-flight.
  // The guard is removed; Windows users may just see a long quiet pause
  // until claude finishes. Future work: stream claude's stdout to stderr
  // so generation has a progress signal.
  void opts.platform;
  void opts.allowUnsupportedPlatform;
  void args.flags['allow-unsupported-platform'];

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

  let sourceDirOverride: string | undefined;
  const sourceDirRaw = stringFlag(args, 'source-dir');
  if (sourceDirRaw !== undefined) {
    const abs = isAbsolute(sourceDirRaw)
      ? sourceDirRaw
      : resolvePath(process.cwd(), sourceDirRaw);
    sourceDirOverride = abs;
  }

  const dryRun = args.flags['dry-run'] === true;
  const start = Date.now();
  const client = (opts.clientFactory ?? defaultClientFactory)(config);

  // 1. Persist --source-dir on the workspace (if provided) so the acceptance
  // verifier endpoint and the spec endpoint both see it.
  if (sourceDirOverride !== undefined) {
    try {
      await client.setSourceDir(config.workspace, sourceDirOverride);
    } catch (err) {
      return reportError(err, stderr);
    }
  }

  // 2. Fetch the resolved component spec.
  stderr.write(`generate: resolving spec for '${componentGlmId}'…\n`);
  let spec: ComponentSpecPayload;
  try {
    spec = await client.getComponentSpec(config.workspace, componentGlmId);
  } catch (err) {
    return reportError(err, stderr);
  }

  const sourceDir = spec.sourceDir;
  if (!sourceDir && !dryRun) {
    return reportError(
      new CliError(
        `workspace '${config.workspace}' has no source_dir. Pass --source-dir <abs-path> or set it first.`,
        66,
      ),
      stderr,
    );
  }

  // 3. Compose system + user prompts, spawn claude in the user's shell.
  const systemPrompt = buildSystemPrompt({
    promptTemplate: spec.promptTemplate,
    contextBundleText: spec.contextBundle.text,
    outputs: spec.outputs,
  });
  const userPrompt = buildUserPrompt({
    glmId: spec.component.glmId,
    title: spec.component.title,
    outputs: spec.outputs,
  });

  // The tmp dir holds the system-prompt file we pass to claude and a copy of
  // claude's raw stdout. We deliberately do NOT cleanup on error — keeping
  // the response on disk is the only way for the user to inspect what claude
  // emitted when parsing fails (the most common failure mode is "model
  // emitted prose instead of FILE markers"). Successful runs cleanup at the
  // end of the function.
  const tmp = mkdtempSync(join(tmpdir(), 'glm-gen-'));
  const systemPromptFile = join(tmp, 'system-prompt.txt');
  const responseFile = join(tmp, 'claude-response.txt');
  let llmStdout = '';
  let llmStderr = '';
  try {
    writeFileSync(systemPromptFile, systemPrompt, 'utf8');
    stderr.write(`generate: invoking ${config.model} on component '${componentGlmId}'…\n`);
    const claudeRunner = opts.claudeRunner ?? defaultClaudeRunner;
    const result = await claudeRunner({
      userText: userPrompt,
      systemPromptFile,
      model: config.model,
    });
    llmStdout = result.stdout;
    llmStderr = result.stderr;
    // Persist stdout immediately so it's available for inspection even if the
    // process is killed before we finish parsing.
    writeFileSync(responseFile, llmStdout, 'utf8');
  } catch (err) {
    stderr.write(`(claude invocation failed; diagnostics in ${tmp})\n`);
    return reportError(err, stderr);
  }
  void llmStderr; // captured for future diagnostics; unused today

  // 4. Parse the multi-file response.
  let parsed;
  try {
    parsed = parseMultiFileResponse(llmStdout, spec.outputs.map((o) => o.path));
  } catch (err) {
    stderr.write(`(raw claude response preserved at ${responseFile})\n`);
    return reportError(err, stderr);
  }

  // 5. Write files (under source_dir, or a staging dir when --dry-run).
  const outputDir = dryRun ? mkdtempSync(join(tmpdir(), 'glm-gen-dry-')) : (sourceDir as string);
  const written: GenerateResult['filesWritten'] = [];
  try {
    for (const file of parsed) {
      const safePath = resolveSafePath(outputDir, file.path);
      mkdirSync(dirname(safePath), { recursive: true });
      writeFileSync(safePath, file.content, 'utf8');
      const sha256 = `sha256:${createHash('sha256').update(file.content, 'utf8').digest('hex')}`;
      written.push({
        path: file.path,
        bytes: Buffer.byteLength(file.content, 'utf8'),
        sha256,
      });
    }
  } catch (err) {
    if (dryRun) {
      try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return reportError(err, stderr);
  }

  // 5b. Lint generated files for interface-suppressing casts (P1-A).
  // Any `as unknown as`, `as any`, `@ts-ignore`, or `@ts-expect-error` in a
  // generated TS file is treated as a hard failure: the model noticed a type
  // mismatch and papered over it rather than surfacing it, which turns a
  // compile-time error into a silent runtime crash (see interface-hallucination-
  // analysis.md §4). Fail here so the user sees the exact file + line, not a
  // confusing runtime stack trace after wiring the components together.
  const lintViolations = lintGeneratedFiles(parsed);
  if (lintViolations.length > 0) {
    stderr.write('generate: LINT FAILURE — interface-suppressing casts in generated output:\n');
    for (const v of lintViolations) {
      stderr.write(`  ${v.file}:${v.line}: [${v.pattern}]  ${v.text.slice(0, 120)}\n`);
    }
    stderr.write(
      'These casts indicate a cross-component interface mismatch.\n' +
      'See docs/interface-hallucination-analysis.md §Prevention approach 5.\n',
    );
    if (dryRun) {
      try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return 70;
  }

  // 6. Run the acceptance verifier (skipped for dry-run since the staging
  // dir doesn't have a test harness pointed at it).
  let verifier: AcceptanceVerifyResult;
  if (dryRun) {
    verifier = {
      command: spec.verifierCommand,
      cwd: outputDir,
      exitCode: 0,
      stdout: '(skipped — dry-run)',
      stderr: '',
      durationMs: 0,
    };
  } else {
    stderr.write('generate: running acceptance verifier…\n');
    try {
      verifier = await client.runAcceptanceVerify(config.workspace, componentGlmId);
    } catch (err) {
      return reportError(err, stderr);
    }
  }

  // 7. Record provenance (only on success, and only when not dry-run).
  let provenance: ProvenanceEvent | null = null;
  const success = verifier.exitCode === 0;
  if (success && !dryRun) {
    try {
      provenance = await client.recordGeneration(config.workspace, {
        componentId: componentGlmId,
        files: written,
        verifierExitCode: verifier.exitCode,
        bindingHash: spec.contextBundle.bindingHash,
        generatorIdentity: `claude-cli/${config.model}`,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      return reportError(err, stderr);
    }
  }

  // 8. Clean up dry-run staging.
  if (dryRun) {
    try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // Cleanup the generation tmp dir on full success. On any error path above
  // we return early WITHOUT this cleanup so the user can inspect the raw
  // claude response. Use `glm-gen-*` glob to reap stale dirs if needed.
  if (success) {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  } else {
    stderr.write(`(diagnostics preserved at ${tmp})\n`);
  }

  if (!success) {
    stderr.write(
      `verifier failed (exit ${verifier.exitCode}). ` +
        (verifier.stderr.trim().slice(0, 500) || '(no stderr)') +
        '\n',
    );
    return 1;
  }

  const useColor = shouldUseColor({
    enabled: opts.colorEnabled,
    stream: stdout as NodeJS.WritableStream & { isTTY?: boolean },
    flags: args.flags,
  });
  const c = makeColorize(useColor);

  const result: GenerateResult = {
    componentGlmId,
    outputDir,
    dryRun,
    filesWritten: written,
    verifier,
    provenance,
    durationMs: Date.now() - start,
  };

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

async function defaultClaudeRunner(opts: RunOneShotOptions): Promise<{ stdout: string; stderr: string }> {
  const result = await runOneShot(opts);
  return { stdout: result.stdout, stderr: result.stderr };
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function reportError(err: unknown, stderr: NodeJS.WritableStream): number {
  if (err instanceof GenerateError) {
    stderr.write(`glm: ${err.message}\n`);
    return err.exitCode;
  }
  if (err instanceof CliError) {
    stderr.write(`glm: ${err.message}\n`);
    return err.exitCode;
  }
  const message = err instanceof Error ? err.message : String(err);
  stderr.write(`glm: unexpected error: ${message}\n`);
  return 1;
}
