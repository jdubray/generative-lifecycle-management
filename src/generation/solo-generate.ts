import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { NodeRepository } from '../repository/node-repository.ts';
import type { ProvenanceRepository } from '../repository/provenance-repository.ts';
import type { AuditRepository } from '../repository/audit-repository.ts';
import type { WorkspaceRepository } from '../repository/workspace-repository.ts';
import type { ProvenanceEvent, SekkeiNode } from '../types.ts';
import {
  buildContextBundle,
  HARD_CONSTRAINTS,
  type AcceptanceBody,
  type PromptBody,
} from './component-spec.ts';

/**
 * Solo-mode code generation (docs/solo-mode-spec.md UC-02).
 *
 * Flow:
 *   1. Resolve the target component and its spec.prompt + spec.acceptance nodes.
 *   2. Resolve the context bundle (every glm-id ref → that node's body YAML).
 *   3. Build a system prompt: prompt_template + context bundle + outputs list +
 *      HARD CONSTRAINTS (no fences, multi-file delimiter format, etc.).
 *   4. Spawn `claude --print` to produce a single multi-file response.
 *   5. Parse the response into `{ path → content }`, validate paths stay
 *      inside `workspace.source_dir`, write the files.
 *   6. Run the acceptance verifier (`spec.acceptance.body.verifier.command`)
 *      with `cwd = source_dir`.
 *   7. Record a provenance_events row + audit entry.
 *
 * Phase 6 ships the synchronous JSON variant. SSE streaming (per spec §5.2)
 * is a future polish item — the heavy step is the LLM call, and that already
 * runs to completion before the response is parseable, so per-step progress
 * is cosmetic.
 */

// --- Public types ----------------------------------------------------------

export class SoloGenerateError extends Error {
  public readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = 'SoloGenerateError';
    this.status = status;
  }
}

export interface SoloGenerateInput {
  workspaceId: string;
  /** glm_id of the Component node to generate (NOT the spec.prompt). */
  componentGlmId: string;
  /** When true, write files to a temp staging dir and discard. */
  dryRun?: boolean;
  /** Override the Claude runner (tests). Defaults to spawning the real CLI. */
  claudeRunner?: ClaudeRunner;
  /** Override the verifier runner (tests). Defaults to spawnSync. */
  verifierRunner?: VerifierRunner;
}

export interface SoloGenerateResult {
  componentGlmId: string;
  outputDir: string;
  dryRun: boolean;
  filesWritten: Array<{ path: string; bytes: number; sha256: string }>;
  verifier: { command: string; exitCode: number; stdout: string; stderr: string };
  provenance: ProvenanceEvent | null;
  durationMs: number;
}

export interface ClaudeRunner {
  (opts: {
    userText: string;
    systemPromptFile: string;
    model: string;
  }): Promise<{ stdout: string; stderr: string }>;
}

export interface VerifierRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface VerifierRunner {
  (opts: { command: string; cwd: string }): VerifierRunResult | Promise<VerifierRunResult>;
}

export interface SoloGenerateDeps {
  repos: {
    nodes: NodeRepository;
    workspaces: WorkspaceRepository;
    provenance: ProvenanceRepository;
    audit: AuditRepository;
  };
  /** Defaults to env GLM_CLAUDE_MODEL or 'claude-sonnet-4-6'. */
  model?: string;
  /** Identity recorded on provenance rows. */
  generatorIdentity?: string;
  clock?: () => Date;
  userId?: string;
}

// --- Entry point -----------------------------------------------------------

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const FILE_HEADER_RE = /^===\s*FILE:\s*(.+?)\s*===\s*$/;

export async function runSoloGenerate(
  deps: SoloGenerateDeps,
  input: SoloGenerateInput,
): Promise<SoloGenerateResult> {
  const start = Date.now();
  const model = deps.model ?? process.env.GLM_CLAUDE_MODEL ?? DEFAULT_MODEL;
  const clock = deps.clock ?? (() => new Date());
  const generatorIdentity = deps.generatorIdentity ?? `claude-cli/${model}`;
  const log = (event: string, extra: Record<string, unknown> = {}): void => {
    if (process.env.NODE_ENV === 'test') return;
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        component: 'solo-generate',
        event,
        component_glm_id: input.componentGlmId,
        ...extra,
      }),
    );
  };
  log('start', { workspace_id: input.workspaceId, dry_run: input.dryRun ?? false });

  // 1. Resolve workspace + source_dir.
  const ws = deps.repos.workspaces.findById(input.workspaceId);
  if (!ws) throw new SoloGenerateError(`workspace ${input.workspaceId} not found`, 404);
  const sourceDir = ws.sourceDir;
  if (!sourceDir) {
    throw new SoloGenerateError(
      `workspace '${ws.slug}' has no source_dir. Set one via PATCH /api/v1/workspaces/${ws.id} or 'glm init --source-dir'.`,
      409,
    );
  }

  // 2. Resolve the Component + spec.prompt + spec.acceptance.
  const componentFound = deps.repos.nodes.findByGlmId(input.workspaceId, input.componentGlmId);
  if (!componentFound) {
    throw new SoloGenerateError(`component '${input.componentGlmId}' not found`, 404);
  }
  if (componentFound.node.stratum !== 'component') {
    throw new SoloGenerateError(
      `'${input.componentGlmId}' is stratum '${componentFound.node.stratum}', not 'component'`,
      422,
    );
  }

  const promptId = `${input.componentGlmId}.spec.prompt`;
  const acceptanceId = `${input.componentGlmId}.spec.acceptance`;
  const promptFound = deps.repos.nodes.findByGlmId(input.workspaceId, promptId);
  if (!promptFound) throw new SoloGenerateError(`spec node '${promptId}' not found`, 422);
  const acceptanceFound = deps.repos.nodes.findByGlmId(input.workspaceId, acceptanceId);
  if (!acceptanceFound) throw new SoloGenerateError(`spec node '${acceptanceId}' not found`, 422);

  const promptBody = promptFound.node.body as PromptBody;
  const acceptanceBody = acceptanceFound.node.body as AcceptanceBody;

  const outputs = Array.isArray(promptBody.outputs) ? promptBody.outputs : [];
  if (outputs.length === 0) {
    throw new SoloGenerateError(`spec.prompt for '${input.componentGlmId}' lists no outputs`, 422);
  }
  const verifierCommand = acceptanceBody.verifier?.command;
  if (!verifierCommand || verifierCommand.trim().length === 0) {
    throw new SoloGenerateError(
      `spec.acceptance for '${input.componentGlmId}' has no verifier.command`,
      422,
    );
  }

  log('resolved', {
    expected_outputs: outputs.map((o) => o.path),
    verifier_command: verifierCommand,
  });

  // 3. Build the context bundle from spec.prompt.body.context_bundle[].
  const contextRefs = Array.isArray(promptBody.context_bundle) ? promptBody.context_bundle : [];
  const bundle = buildContextBundle(deps.repos.nodes, input.workspaceId, contextRefs);
  log('context_bundle_built', {
    refs_total: contextRefs.length,
    bytes: Buffer.byteLength(bundle.text, 'utf8'),
  });

  // 4. Compose system prompt + user prompt.
  const systemPrompt = buildSystemPrompt(promptBody, bundle.text, outputs);
  const userPrompt = buildUserPrompt(componentFound.node, outputs);

  // 5. Spawn Claude via injectable runner.
  const claudeRunner = input.claudeRunner ?? defaultClaudeRunner();
  const tmp = mkdtempSync(join(tmpdir(), 'glm-gen-'));
  const systemPromptFile = join(tmp, 'system-prompt.txt');

  let llmStdout = '';
  let llmStderr = '';
  try {
    writeFileSync(systemPromptFile, systemPrompt, 'utf8');
    log('claude_spawn', {
      model,
      system_prompt_bytes: Buffer.byteLength(systemPrompt, 'utf8'),
      user_prompt_bytes: Buffer.byteLength(userPrompt, 'utf8'),
    });
    const llmStart = Date.now();
    const result = await claudeRunner({ userText: userPrompt, systemPromptFile, model });
    llmStdout = result.stdout;
    llmStderr = result.stderr;
    log('claude_done', {
      duration_ms: Date.now() - llmStart,
      stdout_bytes: Buffer.byteLength(llmStdout, 'utf8'),
      stderr_bytes: Buffer.byteLength(llmStderr, 'utf8'),
    });
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  // 6. Parse the multi-file response.
  const files = parseMultiFileResponse(llmStdout, outputs.map((o) => o.path));
  log('parsed', { files_parsed: files.length });

  // 7. Write files (under source_dir, or a staging dir when dry-run).
  const outputDir = input.dryRun ? mkdtempSync(join(tmpdir(), 'glm-gen-dry-')) : sourceDir;
  const written: SoloGenerateResult['filesWritten'] = [];
  try {
    for (const file of files) {
      const safePath = resolveSafePath(outputDir, file.path);
      mkdirSync(dirname(safePath), { recursive: true });
      writeFileSync(safePath, file.content, 'utf8');
      const sha256 = `sha256:${createHash('sha256').update(file.content, 'utf8').digest('hex')}`;
      written.push({ path: file.path, bytes: Buffer.byteLength(file.content, 'utf8'), sha256 });
    }
  } catch (err) {
    if (input.dryRun) {
      try {
        rmSync(outputDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
    throw err;
  }
  log('files_written', {
    output_dir: outputDir,
    files: written.map((f) => ({ path: f.path, bytes: f.bytes })),
  });

  // 8. Run the verifier.
  const verifierRunner = input.verifierRunner ?? defaultVerifierRunner;
  log('verifier_spawn', { command: verifierCommand, cwd: outputDir });
  const verifierStart = Date.now();
  const verifier = await verifierRunner({ command: verifierCommand, cwd: outputDir });
  log('verifier_done', {
    exit_code: verifier.exitCode,
    duration_ms: Date.now() - verifierStart,
  });

  // 9. Record provenance (only on success, and not for dry-run).
  let provenance: ProvenanceEvent | null = null;
  const success = verifier.exitCode === 0;
  if (success && !input.dryRun) {
    provenance = deps.repos.provenance.insert({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      occurredAt: clock().toISOString(),
      subjectFile: outputs.map((o) => o.path).join(','),
      subjectDigest: aggregateDigest(written),
      sekkeiRoot: input.componentGlmId,
      sekkeiRev: componentFound.node.contentHash,
      sekkeiLock: '',
      bindingHash: bundle.bindingHash,
      generatorLlm: generatorIdentity,
      generatorPromptVersion: promptFound.node.contentHash,
      durationMs: Date.now() - start,
      cache: 'miss',
      signed: false,
      note: null,
    });

    deps.repos.audit.append({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      userId: deps.userId ?? 'solo',
      eventType: 'solo.generate',
      payload: {
        componentGlmId: input.componentGlmId,
        filesWritten: written.length,
        verifierExit: verifier.exitCode,
        provenanceId: provenance.id,
      },
    });
  }

  // 10. Clean up dry-run staging dir.
  if (input.dryRun) {
    try {
      rmSync(outputDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  if (!success) {
    // Files are on disk (or were, for dry-run); the caller can decide whether to
    // rollback. We still throw so the HTTP route returns 422.
    throw new SoloGenerateError(
      `verifier failed (exit ${verifier.exitCode}): ${verifier.stderr.trim().slice(0, 500)}`,
      422,
    );
  }

  return {
    componentGlmId: input.componentGlmId,
    outputDir,
    dryRun: input.dryRun ?? false,
    filesWritten: written,
    verifier: { command: verifierCommand, ...verifier },
    provenance,
    durationMs: Date.now() - start,
  };
}

// --- Prompt assembly -------------------------------------------------------
// Types and shared helpers live in `./component-spec.ts` so the MCP composite
// endpoint and this server-side flow stay in lock-step. `buildSystemPrompt`
// and `buildUserPrompt` below remain here — they're specific to the
// claude-CLI invocation path and disappear with this file in Phase F.

function buildSystemPrompt(
  promptBody: PromptBody,
  contextBundleText: string,
  outputs: Array<{ path: string; description?: string }>,
): string {
  const tpl = (promptBody.prompt_template ?? '').trim();
  const outputBlock = outputs
    .map((o) => `  - path: ${o.path}\n    description: ${o.description ?? ''}`)
    .join('\n');
  return [
    tpl,
    '',
    'CONTEXT BUNDLE:',
    contextBundleText,
    '',
    'OUTPUTS to produce:',
    outputBlock,
    '',
    HARD_CONSTRAINTS,
  ].join('\n');
}

function buildUserPrompt(
  component: SekkeiNode,
  outputs: Array<{ path: string; description?: string }>,
): string {
  return [
    `Generate the implementation of component '${component.glmId}' (${component.title}).`,
    `Produce exactly ${outputs.length} file${outputs.length === 1 ? '' : 's'}:`,
    ...outputs.map((o) => `  - ${o.path}`),
    '',
    'Each file must start with `=== FILE: <path> ===` on its own line.',
  ].join('\n');
}

// --- Multi-file response parser -------------------------------------------

interface ParsedFile {
  path: string;
  content: string;
}

export function parseMultiFileResponse(stdout: string, expectedPaths: string[]): ParsedFile[] {
  const lines = stdout.split(/\r?\n/);
  const files: ParsedFile[] = [];
  let current: { path: string; lines: string[] } | null = null;

  for (const line of lines) {
    const m = line.match(FILE_HEADER_RE);
    if (m) {
      if (current) files.push({ path: current.path, content: current.lines.join('\n') });
      current = { path: (m[1] ?? '').trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) files.push({ path: current.path, content: current.lines.join('\n') });

  if (files.length === 0) {
    throw new SoloGenerateError(
      `Claude response contained no \`=== FILE: <path> ===\` markers. ` +
        `Did the model emit prose instead of the multi-file format?`,
    );
  }

  // Each parsed path must match one of the expected outputs[].path values.
  const expectedSet = new Set(expectedPaths.map(normalize));
  for (const f of files) {
    const normalized = normalize(f.path);
    if (!expectedSet.has(normalized)) {
      throw new SoloGenerateError(
        `Claude emitted unexpected file path '${f.path}'. ` +
          `Expected one of: ${[...expectedSet].join(', ')}`,
      );
    }
  }

  // Strip a single trailing empty line (artifact of split('\n')).
  return files.map((f) => ({
    path: f.path,
    content: f.content.endsWith('\n') ? f.content : `${f.content}\n`,
  }));
}

// --- Path-safety + filesystem helpers -------------------------------------

function resolveSafePath(baseDir: string, candidate: string): string {
  if (isAbsolute(candidate)) {
    throw new SoloGenerateError(`output path '${candidate}' must be relative`);
  }
  if (candidate.includes('..')) {
    throw new SoloGenerateError(`output path '${candidate}' must not contain '..'`);
  }
  const baseAbs = resolve(baseDir);
  const target = resolve(baseAbs, candidate);
  if (target !== baseAbs && !target.startsWith(baseAbs + sep)) {
    throw new SoloGenerateError(`output path '${candidate}' escapes source_dir`);
  }
  return target;
}

function aggregateDigest(files: Array<{ sha256: string }>): string {
  if (files.length === 0) {
    return 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  }
  const h = createHash('sha256');
  for (const f of files) h.update(f.sha256);
  return `sha256:${h.digest('hex')}`;
}

// --- Default subprocess runners -------------------------------------------
//
// Both runners use async `spawn` rather than `spawnSync` so the Hono request
// handler does NOT block Bun's event loop for the duration of the LLM call
// (30-90s typical). With the sync version, Windows TCP would close the idle
// client socket before the response could be written. Async spawn keeps the
// loop turning and keep-alive frames flowing for the whole duration.
//
// NOTE — server-side spawn of `claude.exe` hangs on Windows when this file
// is loaded inside the long-running GLM server (see docs/mcp-fork-plan.md).
// MCP replaces this path; the comment below stashes the Puffin recipe in
// case we ever revive headless server-side generation (e.g. for CI).
//
// === Puffin's recipe for spawning Claude from a long-running Windows process ===
// Source: C:\Users\jjdub\code\puffin\plugins\code-review-plugin\lib\review-runner.js:110-156
//
//   import { spawn } from 'node:child_process';        // NOT Bun.spawn
//   const proc = spawn('claude', [
//     '--print',
//     '--dangerously-skip-permissions',
//     '--disallowedTools', 'AskUserQuestion',
//   ], {
//     cwd: projectPath,
//     shell: true,                                     // ← key on Windows: cmd.exe /d /s /c
//     stdio: ['pipe', 'pipe', 'pipe'],
//     env: { ...process.env },
//   });
//   proc.stdin.write(prompt);                          // prompt via stdin pipe
//   proc.stdin.end();
//   // drain stdout/stderr via 'data' events; resolve on 'close'.
//
// The `shell: true` is what makes it work: Windows routes the launch through
// cmd.exe which re-isolates console handles before exec-ing node.exe, so the
// grandchild doesn't inherit the parent's listening sockets / WAL locks.

/**
 * Default claude runner — Bun.spawn invoking `claude --print "<prompt>"`.
 *
 * Why no stdin: on Windows, `claude` is a `.cmd` shim that wraps node. Stdin
 * piping through the cmd.exe layer is fragile — neither node:child_process
 * nor Bun.spawn reliably delivered our piped user prompt to the underlying
 * node process. The CLI happily reads from a terminal-like pipe (PowerShell
 * `| claude --print` works), but a programmatic pipe via spawn hangs.
 *
 * The fix is to pass the user prompt as the last positional argument. Bun's
 * spawn builds the OS-level argv array directly, so multi-line and
 * special-character content is delivered byte-perfect without shell escaping.
 *
 * A 240-second internal timeout ensures we fail fast if claude hangs, before
 * Bun.serve's 255s idleTimeout kills the upstream HTTP connection.
 */
const CLAUDE_TIMEOUT_MS = 240_000;

function defaultClaudeRunner(): ClaudeRunner {
  return async ({ userText, systemPromptFile, model }) => {
    // Diagnostic: log the resolved binary path so we know what Bun is launching.
    if (process.env.NODE_ENV !== 'test') {
      const resolved = Bun.which('claude') ?? '<not found>';
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        component: 'solo-generate',
        event: 'claude_resolved',
        path: resolved,
      }));
    }

    let proc;
    try {
      proc = Bun.spawn({
        cmd: [
          'claude',
          '--print',
          '--model', model,
          '--system-prompt-file', systemPromptFile,
          userText,
        ],
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (err) {
      if (isMissingBinary(err)) throw missingClaudeError(err);
      throw err;
    }

    // Tee stdout/stderr through arrays so we can include partial output in the
    // timeout error (otherwise we have no signal whether claude is mute, partly
    // writing, or actively producing).
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    const drainStdout = (async () => {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) stdoutChunks.push(chunk);
    })();
    const drainStderr = (async () => {
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) stderrChunks.push(chunk);
    })();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch { /* ignore */ }
    }, CLAUDE_TIMEOUT_MS);

    const exitCode = await proc.exited;
    await Promise.all([drainStdout, drainStderr]);
    clearTimeout(timer);

    const stdout = new TextDecoder().decode(Buffer.concat(stdoutChunks.map((c) => Buffer.from(c))));
    const stderr = new TextDecoder().decode(Buffer.concat(stderrChunks.map((c) => Buffer.from(c))));

    if (timedOut) {
      throw new SoloGenerateError(
        `claude CLI timed out after ${CLAUDE_TIMEOUT_MS}ms ` +
          `(stdout=${stdout.length}B, stderr=${stderr.length}B). ` +
          (stdout.length > 0 ? `stdout head: ${stdout.slice(0, 200)}` : '') +
          (stderr.length > 0 ? ` stderr head: ${stderr.slice(0, 200)}` : ''),
        502,
      );
    }
    if (exitCode !== 0) {
      throw new SoloGenerateError(
        `claude CLI exited ${exitCode}: ${stderr.trim().slice(0, 500) || '(no stderr)'}`,
        502,
      );
    }
    return { stdout, stderr };
  };
}

function defaultVerifierRunner(opts: { command: string; cwd: string }): Promise<VerifierRunResult> {
  // The verifier command is a shell line (e.g. 'bun test test/*.test.ts').
  // Execute via the platform shell so glob/redirection/composition work.
  const shell = process.platform === 'win32' ? 'cmd' : 'sh';
  const shellArg = process.platform === 'win32' ? '/c' : '-c';
  return new Promise<VerifierRunResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(shell, [shellArg, opts.command], {
        cwd: opts.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

function isMissingBinary(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function missingClaudeError(cause?: unknown): SoloGenerateError {
  const detail = cause instanceof Error ? `: ${cause.message}` : '';
  return new SoloGenerateError(
    `claude CLI not found on PATH${detail}. Install Claude Code: https://claude.ai/code`,
    503,
  );
}
