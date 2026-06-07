import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { resolveConfig, type ResolvedConfig } from '../lib/config.ts';
import { GlmClient } from '../lib/glm-client.ts';
import { CliError, CliUsageError } from '../lib/errors.ts';
import type { ParsedArgs } from '../lib/argv.ts';

/** Minimal client surface `glm init --source-dir` needs (injectable for tests). */
interface SourceDirClient {
  setSourceDir(workspaceId: string, sourceDir: string): Promise<void>;
}

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
  /** Override the default `.env` path for `--write-env` (tests). */
  defaultEnvPath?: string;
  /** Inject the GLM client (tests) for the `--source-dir` PATCH. */
  clientFactory?: (cfg: { baseUrl: string; token: string | undefined }) => SourceDirClient;
}

export async function runInit(args: ParsedArgs, opts: RunInitOptions = {}): Promise<number> {
  const io = opts.io ?? process;
  const stdout = io.stdout;
  const stderr = io.stderr;

  const port = parsePort(args.flags.port);
  const name = stringFlag(args, 'name') ?? 'default';
  const tokenFromFlag = stringFlag(args, 'token');
  const force = args.flags.force === true;

  // Optional: --source-dir sets the addressed workspace's source_dir on the
  // server (the path the generate / verify / build flow reads). Resolved to
  // absolute because the server's PATCH route rejects relative paths.
  const sourceDirRaw = stringFlag(args, 'source-dir');
  const sourceDir =
    sourceDirRaw === undefined
      ? undefined
      : isAbsolute(sourceDirRaw)
        ? sourceDirRaw
        : resolve(process.cwd(), sourceDirRaw);

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
    // Plain `glm init` on an existing config is a no-op guard. But `glm init
    // --source-dir` is not re-initializing — it just sets the workspace
    // source_dir against the existing config, so fall through to that phase.
    if (sourceDir === undefined) {
      stderr.write(
        `glm: config already exists at ${path}. ` +
          `Pass --force to overwrite, or set GLM_SOLO_TOKEN on the server to:\n  ${existingToken ?? '(no token in file)'}\n`,
      );
      return 78;
    }
    stdout.write(`glm init: using existing config at ${path}\n`);
  } else {
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

    // Optionally prime the server's `.env` with GLM_SOLO_TOKEN so a fresh
    // bootstrap is end-to-end working — no manual env-var step needed.
    const writeEnvFlag = args.flags['write-env'];
    if (writeEnvFlag) {
      const envTarget =
        typeof writeEnvFlag === 'string' && writeEnvFlag.length > 0
          ? resolve(writeEnvFlag)
          : opts.defaultEnvPath ?? resolve(process.cwd(), '.env');
      try {
        const action = writeSoloTokenToEnv(envTarget, token);
        stdout.write(`glm init: ${action} GLM_SOLO_TOKEN in ${envTarget}\n`);
      } catch (err) {
        stderr.write(
          `glm: wrote ${path} but failed to update ${envTarget}: ${(err as Error).message}\n`,
        );
        return 78;
      }
    }

    stdout.write(
      `\nglm init: wrote ${path}\n\n` +
        (writeEnvFlag
          ? `Server-side GLM_SOLO_TOKEN is already set. Start the server:\n\n` +
            `  bun run src/server/server.ts\n\n`
          : `To enable solo-mode auth on the server, set:\n\n` +
            `  export GLM_SOLO_TOKEN=${token}\n\n` +
            `Then start the server in another terminal:\n\n` +
            `  bun run src/server/server.ts\n\n` +
            `(Tip: pass --write-env on a future 'glm init' to do this automatically.)\n\n`) +
        `The CLI picks up the token automatically from this config file.\n`,
    );
  }

  // --- Source-dir phase: PATCH the addressed workspace's source_dir. ---------
  if (sourceDir !== undefined) {
    let cfg: ResolvedConfig;
    try {
      cfg = resolveConfig({ args, configPath: path });
    } catch (err) {
      return reportError(err, stderr);
    }
    if (!cfg.token) {
      stderr.write(
        `glm: cannot set source_dir — no token resolved. Run 'glm init' first or pass --token.\n`,
      );
      return 78;
    }
    const client = (opts.clientFactory ?? defaultInitClientFactory)({
      baseUrl: cfg.baseUrl,
      token: cfg.token,
    });
    try {
      await client.setSourceDir(cfg.workspace, sourceDir);
    } catch (err) {
      stderr.write(
        `glm: failed to set source_dir on workspace '${cfg.workspace}': ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
    stdout.write(`glm init: set source_dir for workspace '${cfg.workspace}' = ${sourceDir}\n`);
  }

  return 0;
}

function defaultInitClientFactory(cfg: { baseUrl: string; token: string | undefined }): SourceDirClient {
  return new GlmClient({ baseUrl: cfg.baseUrl, token: cfg.token });
}

/**
 * Append or replace the `GLM_SOLO_TOKEN=<token>` line in a `.env` file.
 * Returns 'wrote', 'appended', or 'replaced' describing what happened, so
 * the caller can render a precise message.
 *
 * Idempotent: re-running with the same token produces the same file.
 */
function writeSoloTokenToEnv(envPath: string, token: string): 'wrote' | 'appended' | 'replaced' {
  const line = `GLM_SOLO_TOKEN=${token}`;
  if (!existsSync(envPath)) {
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, `${line}\n`, 'utf8');
    return 'wrote';
  }
  const existing = readFileSync(envPath, 'utf8');
  const lines = existing.split(/\r?\n/);
  let replaced = false;
  const next = lines.map((l) => {
    if (l.startsWith('GLM_SOLO_TOKEN=')) {
      replaced = true;
      return line;
    }
    return l;
  });
  if (replaced) {
    writeFileSync(envPath, next.join('\n'), 'utf8');
    return 'replaced';
  }
  const needsNewline = existing.length > 0 && !existing.endsWith('\n');
  writeFileSync(envPath, `${existing}${needsNewline ? '\n' : ''}${line}\n`, 'utf8');
  return 'appended';
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
