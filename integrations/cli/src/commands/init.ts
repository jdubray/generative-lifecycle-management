import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { CliError, CliUsageError } from '../lib/errors.ts';
import type { ParsedArgs } from '../lib/argv.ts';

/**
 * `glm init` — bootstrap a solo-mode config at `~/.glm/config.json`.
 *
 * Writes:
 *   {
 *     "port":      <port>,           // 3000 by default
 *     "workspace": <name>,           // 'default' by default
 *     "token":     "<32-byte hex>"   // newly generated unless --token given
 *   }
 *
 * The token is the value the user must set as `GLM_SOLO_TOKEN` on the GLM
 * server process. The CLI sends it as `Authorization: Bearer <token>` and
 * the server's auth middleware short-circuits to the solo user.
 *
 * Idempotency:
 *   - If the file does not exist → create it.
 *   - If it exists and `--force` is set → overwrite.
 *   - Otherwise → exit 78 with a message pointing to the existing path.
 *
 * Phase 4.5 of integrations/cli/IMPLEMENTATION_PLAN.md.
 */

export interface RunInitOptions {
  io?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
  /** Override the config destination (tests). */
  configPath?: string;
  /** Random-token factory (tests). */
  generateToken?: () => string;
}

export async function runInit(args: ParsedArgs, opts: RunInitOptions = {}): Promise<number> {
  const io = opts.io ?? process;
  const stdout = io.stdout;
  const stderr = io.stderr;

  const port = parsePort(args.flags.port);
  const name = stringFlag(args, 'name') ?? 'default';
  const tokenFromFlag = stringFlag(args, 'token');
  const force = args.flags.force === true;

  const path = opts.configPath ?? join(homedir(), '.glm', 'config.json');
  const exists = existsSync(path);

  if (exists && !force) {
    // Print the token from the existing file (read-only) — useful for set-up.
    let existingToken: string | undefined;
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as { token?: string };
      if (typeof parsed.token === 'string') existingToken = parsed.token;
    } catch {
      // Malformed file: surface that as a config error.
      stderr.write(
        `glm: config exists at ${path} but is not valid JSON. Run 'glm init --force' to overwrite.\n`,
      );
      return 78;
    }
    stderr.write(
      `glm: config already exists at ${path}. ` +
        `Pass --force to overwrite, or set GLM_SOLO_TOKEN on the server to:\n  ${existingToken ?? '(no token in file)'}\n`,
    );
    return 78;
  }

  let token: string;
  try {
    token = tokenFromFlag ?? (opts.generateToken ?? defaultGenerateToken)();
    if (!/^[0-9a-f]{32,}$/i.test(token)) {
      throw new CliUsageError(`--token must be a hex string (≥32 chars); got '${token}'`);
    }
  } catch (err) {
    return reportError(err, stderr);
  }

  const config = { port, workspace: name, token };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  } catch (err) {
    stderr.write(`glm: failed to write ${path}: ${(err as Error).message}\n`);
    return 78;
  }

  stdout.write(
    `glm init: wrote ${path}\n\n` +
      `To enable solo-mode auth on the server, set:\n\n` +
      `  export GLM_SOLO_TOKEN=${token}\n\n` +
      `Then start the server in another terminal:\n\n` +
      `  bun run src/server/server.ts\n\n` +
      `The CLI picks up the token automatically from this config file.\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------- helpers

function defaultGenerateToken(): string {
  return randomBytes(32).toString('hex');
}

function parsePort(value: string | boolean | number | undefined): number {
  if (value === undefined || typeof value === 'boolean') return 3000;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65_535) {
    throw new CliUsageError(`invalid --port value: ${String(value)}`);
  }
  return n;
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
