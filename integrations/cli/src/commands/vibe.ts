import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveConfig,
  type ResolvedConfig,
  type ResolveConfigInput,
} from '../lib/config.ts';
import {
  GlmClient,
  type ImportSekkeiResult,
} from '../lib/glm-client.ts';
import {
  runOneShot,
  type RunOneShotOptions,
  type RunOneShotResult,
} from '../lib/claude-cli.ts';
import {
  buildVibeSystemPrompt,
  buildVibeUserPrompt,
  stripCodeFences,
} from '../lib/prompts.ts';
import { findRepoRoot, loadSkillFiles, type SkillFiles } from '../lib/repo-root.ts';
import { CliError, CliUsageError } from '../lib/errors.ts';
import type { ParsedArgs } from '../lib/argv.ts';

/**
 * `glm vibe` — UC-01 (author a new sekkei) and UC-04 (reverse-engineer).
 *
 * Phase 4 implements the UC-01 path: prompt for description + namespace, spawn
 * Claude CLI with the sekkei-authoring skill as system prompt, capture the
 * multi-document YAML response, and post it to /api/v1/workspaces/import.
 *
 * UC-04 (`--from-dir`) is wired into the dispatcher as not-yet-implemented
 * until Phase 7 lands the codebase scanner.
 */

export interface RunVibeOptions {
  io?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
  clientFactory?: (cfg: ResolvedConfig) => GlmClient;
  /** Inject a Claude CLI runner (tests). Defaults to runOneShot. */
  claudeRunner?: (opts: RunOneShotOptions) => Promise<RunOneShotResult>;
  /** Inject skill/schema content (tests). Skips repo-root + file lookup. */
  skillFiles?: SkillFiles;
  resolveOverrides?: Omit<ResolveConfigInput, 'args'>;
}

export async function runVibe(args: ParsedArgs, opts: RunVibeOptions = {}): Promise<number> {
  const io = opts.io ?? process;
  const stderr = io.stderr;
  const stdout = io.stdout;

  // Reverse-engineer mode is Phase 7 work.
  if (typeof args.flags['from-dir'] === 'string') {
    stderr.write(
      `'glm vibe --from-dir' is not yet implemented (planned for Phase 7). ` +
        `See integrations/cli/IMPLEMENTATION_PLAN.md.\n`,
    );
    return 2;
  }

  let config: ResolvedConfig;
  try {
    config = resolveConfig({ args, ...opts.resolveOverrides });
  } catch (err) {
    return reportError(err, stderr);
  }

  const slug = stringFlag(args, 'slug');
  const namespace = stringFlag(args, 'namespace');
  const stack = stringFlag(args, 'stack') ?? 'Bun + Hono + bun:sqlite';
  const name = stringFlag(args, 'name') ?? slug;
  const description = readDescription(args);
  const dryRun = args.flags['dry-run'] === true;

  try {
    requireFlag('slug', slug);
    requireFlag('namespace', namespace);
    requireFlag('description / --description-file', description);
  } catch (err) {
    return reportError(err, stderr);
  }

  // 1. Load the authoring skill + (optional) schema from the GLM repo.
  let skill: SkillFiles;
  try {
    skill = opts.skillFiles ?? loadSkillFiles(findRepoRoot());
  } catch (err) {
    stderr.write(`glm: ${err instanceof Error ? err.message : String(err)}\n`);
    return 78;
  }

  // 2. Compose the prompts.
  const systemPrompt = buildVibeSystemPrompt({
    authoringSkill: skill.authoringSkill,
    schemaJson: skill.schemaJson,
  });
  const userPrompt = buildVibeUserPrompt({
    namespace: namespace as string,
    stack,
    description: description as string,
  });

  // 3. Spawn Claude with the system prompt on disk.
  const claudeRunner = opts.claudeRunner ?? runOneShot;
  let yaml: string;
  const tmpDir = mkdtempSync(join(tmpdir(), 'glm-vibe-'));
  const systemPromptFile = join(tmpDir, 'system-prompt.txt');
  try {
    writeFileSync(systemPromptFile, systemPrompt, 'utf8');
    stdout.write(`vibe: invoking ${config.model} via claude CLI…\n`);
    const result = await claudeRunner({
      userText: userPrompt,
      systemPromptFile,
      model: config.model,
    });
    yaml = stripCodeFences(result.stdout).trim();
    if (yaml.length === 0) {
      stderr.write('glm: claude CLI returned an empty response\n');
      return 70;
    }
  } catch (err) {
    return reportError(err, stderr);
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  // 4. Optional: dump the YAML for inspection before sending it to the server.
  const outFile = stringFlag(args, 'out');
  if (outFile) {
    try {
      writeFileSync(outFile, yaml, 'utf8');
      stdout.write(`vibe: wrote generated sekkei to ${outFile}\n`);
    } catch (err) {
      stderr.write(`glm: failed to write --out ${outFile}: ${(err as Error).message}\n`);
      // fall through and still attempt the import
    }
  }

  // 5. Import.
  const client = (opts.clientFactory ?? defaultClientFactory)(config);
  let result: ImportSekkeiResult;
  try {
    result = await client.importSekkei({
      slug: slug as string,
      name,
      yaml,
      dryRun,
    });
  } catch (err) {
    return reportError(err, stderr);
  }

  // 6. Report.
  if (config.json) {
    stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const s = result.summary;
    stdout.write(
      `vibe: imported into workspace '${result.workspace.slug}' (id ${result.workspaceId}):\n` +
        `  inserted   ${s.nodesInserted}\n` +
        `  updated    ${s.nodesUpdated}\n` +
        `  unchanged  ${s.nodesUnchanged}\n` +
        (s.nodesRejected !== undefined ? `  rejected   ${s.nodesRejected}\n` : '') +
        (s.dryRun ? '  (dry-run — nothing committed)\n' : ''),
    );
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

function readDescription(args: ParsedArgs): string | undefined {
  const inline = stringFlag(args, 'description');
  if (inline) return inline;
  const file = stringFlag(args, 'description-file');
  if (file) {
    try {
      return readFileSync(file, 'utf8');
    } catch (err) {
      throw new CliUsageError(`failed to read --description-file ${file}: ${(err as Error).message}`);
    }
  }
  return undefined;
}

function requireFlag(name: string, value: string | undefined): void {
  if (value === undefined || value.trim().length === 0) {
    throw new CliUsageError(`--${name} is required`);
  }
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
