import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
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
  buildReverseEngineerSystemPrompt,
  buildReverseEngineerUserPrompt,
  stripCodeFences,
} from '../lib/prompts.ts';
import { findRepoRoot, loadSkillFiles, type SkillFiles } from '../lib/repo-root.ts';
import { scanCodebase, renderScanForPrompt, type CodebaseScan } from '../lib/codebase-scan.ts';
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
  /** Inject a codebase scanner (tests). Defaults to the real scanCodebase. */
  codebaseScanner?: (rootDir: string) => CodebaseScan;
  resolveOverrides?: Omit<ResolveConfigInput, 'args'>;
}

export async function runVibe(args: ParsedArgs, opts: RunVibeOptions = {}): Promise<number> {
  const io = opts.io ?? process;
  const stderr = io.stderr;
  const stdout = io.stdout;

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
  const fromDir = stringFlag(args, 'from-dir');
  const description = fromDir === undefined ? readDescription(args) : readDescription(args);
  const dryRun = args.flags['dry-run'] === true;
  const isReverse = fromDir !== undefined;

  try {
    requireFlag('slug', slug);
    requireFlag('namespace', namespace);
    if (!isReverse) {
      requireFlag('description / --description-file', description);
    }
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

  // 2. Compose the prompts (branch on UC-01 vs UC-04).
  let systemPrompt: string;
  let userPrompt: string;
  if (isReverse) {
    const absFromDir = isAbsolute(fromDir as string)
      ? (fromDir as string)
      : resolve(process.cwd(), fromDir as string);
    try {
      validateScanDir(absFromDir);
    } catch (err) {
      return reportError(err, stderr);
    }
    stderr.write(`vibe: scanning codebase at ${absFromDir}…\n`);
    const scanner = opts.codebaseScanner ?? ((root) => scanCodebase({ rootDir: root }));
    const scan = scanner(absFromDir);
    const rendered = renderScanForPrompt(scan);
    stderr.write(
      `vibe: found ${scan.tree.length}${scan.treeTruncated ? '+' : ''} paths, ` +
        `including ${rendered.excerpts.length} key files in the excerpt set\n`,
    );
    systemPrompt = buildReverseEngineerSystemPrompt({
      authoringSkill: skill.authoringSkill,
      schemaJson: skill.schemaJson,
    });
    userPrompt = buildReverseEngineerUserPrompt({
      namespace: namespace as string,
      rootDir: absFromDir,
      fileTree: rendered.fileTree,
      excerpts: rendered.excerpts,
      hint: description, // optional; user can pass --description as a steering hint
    });
  } else {
    systemPrompt = buildVibeSystemPrompt({
      authoringSkill: skill.authoringSkill,
      schemaJson: skill.schemaJson,
    });
    userPrompt = buildVibeUserPrompt({
      namespace: namespace as string,
      stack,
      description: description as string,
    });
  }

  // 3. Spawn Claude with the system prompt on disk.
  const claudeRunner = opts.claudeRunner ?? runOneShot;
  let yaml: string;
  const tmpDir = mkdtempSync(join(tmpdir(), 'glm-vibe-'));
  const systemPromptFile = join(tmpDir, 'system-prompt.txt');
  try {
    writeFileSync(systemPromptFile, systemPrompt, 'utf8');
    // Progress goes to stderr so `glm vibe --json | jq` stays parseable.
    stderr.write(`vibe: invoking ${config.model} via claude CLI…\n`);
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
      stderr.write(`vibe: wrote generated sekkei to ${outFile}\n`);
    } catch (err) {
      stderr.write(`glm: failed to write --out ${outFile}: ${(err as Error).message}\n`);
      // fall through and still attempt the import
    }
  }

  // 5. Guard: refuse to merge into a non-empty workspace without --force.
  const force = args.flags['force'] === true;
  const client = (opts.clientFactory ?? defaultClientFactory)(config);
  if (!dryRun) {
    try {
      const workspaces = await client.listWorkspaces();
      const existing = workspaces.find((w) => w.slug === (slug as string));
      if (existing) {
        const summary = await client.getWorkspaceSummary(existing.id);
        if (summary.nodes.total > 0 && !force) {
          stderr.write(
            `glm: workspace '${slug as string}' already has ${summary.nodes.total} nodes.\n` +
              `  Use --force to merge, or choose a different --slug.\n`,
          );
          return 1;
        }
        if (summary.nodes.total > 0) {
          stderr.write(
            `vibe: workspace '${slug as string}' already has ${summary.nodes.total} nodes — merging (--force).\n`,
          );
        }
      }
    } catch {
      // Guard is best-effort: if listing fails (e.g. server unreachable), let
      // importSekkei surface the real error with full context.
    }
  }

  // 6. Import.
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

  // 7. Report.
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
    // Surface prompt-lint warnings. These indicate spec.prompt nodes that
    // contain harness-incompatible instructions (e.g. "run the tests").
    const promptLintWarnings = (s.warnings as string[] | undefined ?? []).filter(
      (w) => w.includes('prompt-lint:'),
    );
    if (promptLintWarnings.length > 0) {
      stderr.write(`vibe: ${promptLintWarnings.length} prompt-lint warning(s) — use 'glm refine <node>' to fix:\n`);
      for (const w of promptLintWarnings) {
        stderr.write(`  ⚠ ${w}\n`);
      }
    }
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

function validateScanDir(absPath: string): void {
  if (!existsSync(absPath)) {
    throw new CliUsageError(`--from-dir path does not exist: ${absPath}`);
  }
  let st;
  try {
    st = statSync(absPath);
  } catch (err) {
    throw new CliUsageError(`--from-dir path cannot be stat'd: ${(err as Error).message}`);
  }
  if (!st.isDirectory()) {
    throw new CliUsageError(`--from-dir path is not a directory: ${absPath}`);
  }
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
