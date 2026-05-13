import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { CliError } from './errors.ts';

/**
 * Spawn the `claude` CLI as a subprocess for one-shot text generation.
 *
 * This is the only module in the CLI that touches the `claude` binary directly.
 * Per docs/solo-mode-spec.md §5.1.1, one-shot invocations use:
 *
 *   claude --print [--model <model>] [--system-prompt-file <path>] < user.txt
 *
 * `--print` makes claude exit after a single turn (no interactive loop). The
 * user-turn content comes in on stdin; the model's response comes out on
 * stdout. Stderr is captured for error reporting.
 *
 * Streaming `--input-format stream-json` mode is deferred to Phase 6 (Puffin's
 * Vibe panel). One-shot covers UC-01 vibe design, UC-04 reverse-engineer, and
 * UC-05 refine — all three produce a single response per turn.
 */

export class ClaudeCliNotFoundError extends CliError {
  public readonly claudeBin: string;
  constructor(claudeBin: string, cause?: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : '';
    super(
      `claude CLI not found at '${claudeBin}'${detail}. ` +
        `Install Claude Code from https://claude.ai/code, or override with GLM_CLAUDE_BIN.`,
      69,
    );
    this.name = 'ClaudeCliNotFoundError';
    this.claudeBin = claudeBin;
  }
}

export class ClaudeCliFailedError extends CliError {
  public readonly exitStatus: number | null;
  public readonly stderr: string;
  constructor(exitStatus: number | null, stderr: string, reason?: string) {
    const detail = reason ?? (stderr.trim().slice(0, 500) || '(no stderr)');
    super(`claude CLI exited with status ${exitStatus ?? '?'}: ${detail}`, 70);
    this.name = 'ClaudeCliFailedError';
    this.exitStatus = exitStatus;
    this.stderr = stderr;
  }
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface RunOneShotOptions {
  /** User-turn text written to claude's stdin and closed. */
  userText: string;
  /** Absolute path to a file containing the system prompt. Loaded via --system-prompt-file. */
  systemPromptFile?: string;
  /** Model identifier passed to `claude --model`. */
  model?: string;
  /**
   * The `claude` binary to invoke. String → spawn that command. Array →
   * `[command, ...prefixArgs]`, used by tests to delegate to `bun run mock.ts`.
   * Defaults to 'claude' on PATH.
   */
  claudeBin?: string | readonly string[];
  /** Hard timeout in milliseconds. 0 / omitted means no timeout. */
  timeoutMs?: number;
  /** Inject node:child_process spawn (tests). */
  spawnImpl?: SpawnFn;
}

export interface RunOneShotResult {
  /** Captured stdout (utf-8). */
  stdout: string;
  /** Captured stderr (utf-8). */
  stderr: string;
  /** Process exit code. Always 0 on success — non-zero throws. */
  exitCode: number;
  /** Wall-clock duration. */
  durationMs: number;
}

export async function runOneShot(opts: RunOneShotOptions): Promise<RunOneShotResult> {
  const spawnFn = opts.spawnImpl ?? (nodeSpawn as unknown as SpawnFn);
  const { command, prefixArgs } = resolveBinary(opts.claudeBin);

  const args: string[] = [...prefixArgs, '--print'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.systemPromptFile) args.push('--system-prompt-file', opts.systemPromptFile);

  const start = Date.now();

  let child: ChildProcess;
  try {
    child = spawnFn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    if (isMissingBinaryError(err)) throw new ClaudeCliNotFoundError(command, err);
    throw err;
  }

  // Write the user turn and close stdin. If the child died before reading,
  // the error surfaces via the 'error' / 'exit' events below.
  child.stdin?.on('error', () => {
    /* surfaced via the child's 'error' or 'exit' event */
  });
  child.stdin?.write(opts.userText, 'utf8');
  child.stdin?.end();

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
  child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

  return await new Promise<RunOneShotResult>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killChildTree(child);
      }, opts.timeoutMs);
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (isMissingBinaryError(err)) {
        reject(new ClaudeCliNotFoundError(command, err));
      } else {
        reject(err);
      }
    });

    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const durationMs = Date.now() - start;
      if (timedOut) {
        reject(
          new ClaudeCliFailedError(code, stderr, `claude CLI timed out after ${opts.timeoutMs}ms`),
        );
        return;
      }
      if (code !== 0) {
        reject(new ClaudeCliFailedError(code, stderr));
        return;
      }
      resolve({ stdout, stderr, exitCode: 0, durationMs });
    });
  });
}

// ---------------------------------------------------------------------- helpers

function resolveBinary(bin: string | readonly string[] | undefined): {
  command: string;
  prefixArgs: string[];
} {
  if (bin === undefined) return { command: 'claude', prefixArgs: [] };
  if (typeof bin === 'string') return { command: bin, prefixArgs: [] };
  if (bin.length === 0) return { command: 'claude', prefixArgs: [] };
  const [head, ...rest] = bin;
  return { command: head ?? 'claude', prefixArgs: rest as string[] };
}

function isMissingBinaryError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT';
}

/**
 * Terminate a child + its process group.
 *
 * Per docs/solo-mode-spec.md §5.1.3:
 *   - Windows: `taskkill /pid <PID> /T /F` to walk the tree.
 *   - POSIX: SIGTERM. The child cleanup is best-effort; we don't await it
 *     because the 'exit' event handler will eventually fire.
 */
function killChildTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // best-effort
    }
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      // best-effort
    }
  }
}
