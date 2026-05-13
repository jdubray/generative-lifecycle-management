import { spawn } from 'node:child_process';

/**
 * Run a shell command and capture its stdout + stderr + exit code. Used
 * by both the legacy `solo-generate.ts` flow and the new MCP-driven
 * acceptance-verify HTTP route — they share the same need: execute a
 * sekkei-authored verifier command in the workspace's source_dir and
 * report the outcome.
 *
 * Spawning a shell here (not `claude`) is safe in long-running server
 * contexts on Windows. The Bun.spawn → claude.exe hang we hit in solo-
 * generate is specific to claude's startup; running bash/sh/cmd works
 * fine in any process context.
 */

export interface VerifierRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface VerifierRunner {
  (opts: { command: string; cwd: string }): VerifierRunResult | Promise<VerifierRunResult>;
}

export function runAcceptanceVerifier(opts: {
  command: string;
  cwd: string;
}): Promise<VerifierRunResult> {
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
