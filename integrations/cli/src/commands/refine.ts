import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveConfig,
  type ResolvedConfig,
  type ResolveConfigInput,
} from '../lib/config.ts';
import { GlmClient, type NodeWithChildren } from '../lib/glm-client.ts';
import {
  runOneShot,
  type RunOneShotOptions,
  type RunOneShotResult,
} from '../lib/claude-cli.ts';
import {
  buildRefineSystemPrompt,
  buildRefineUserPrompt,
  parseJsonPatchResponse,
} from '../lib/prompts.ts';
import { applyJsonPatch, type JsonPatchOp } from '../lib/json-patch.ts';
import { findRepoRoot, loadSkillFiles, type SkillFiles } from '../lib/repo-root.ts';
import { CliError, CliUsageError } from '../lib/errors.ts';
import type { ParsedArgs } from '../lib/argv.ts';

/**
 * `glm refine --node <glm-id> (--instruction <text> | --instruction-file <path>)`
 *
 * UC-05 from docs/solo-mode-spec.md.
 *
 * Flow (all client-side; the server has no refinement-specific endpoint):
 *   1. GET the node.
 *   2. Compose system + user prompt for a one-shot Claude call.
 *   3. Parse the JSON-Patch response.
 *   4. Apply the patch to a deep clone of node.body.
 *   5. POST /nodes/:id/lock → PUT /nodes/:id with the new body → DELETE /lock.
 *   6. Print the diff summary (op count by kind) + new content_hash.
 *
 * Why client-side patch application: the existing PUT endpoint takes the full
 * NodeInput shape and recomputes content_hash. Adding a server-side JSON-Patch
 * endpoint would duplicate that logic; doing the patch here keeps the server
 * simple. Behaviourally equivalent for solo mode (no concurrent editors).
 */

export interface RunRefineOptions {
  io?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
  clientFactory?: (cfg: ResolvedConfig) => GlmClient;
  claudeRunner?: (opts: RunOneShotOptions) => Promise<RunOneShotResult>;
  skillFiles?: SkillFiles;
  resolveOverrides?: Omit<ResolveConfigInput, 'args'>;
}

export async function runRefine(args: ParsedArgs, opts: RunRefineOptions = {}): Promise<number> {
  const io = opts.io ?? process;
  const stdout = io.stdout;
  const stderr = io.stderr;

  let config: ResolvedConfig;
  try {
    config = resolveConfig({ args, ...opts.resolveOverrides });
  } catch (err) {
    return reportError(err, stderr);
  }

  const glmId = stringFlag(args, 'node');
  if (!glmId) return reportError(new CliUsageError('--node is required'), stderr);
  const instruction = readInstruction(args);
  if (!instruction) {
    return reportError(
      new CliUsageError('--instruction or --instruction-file is required'),
      stderr,
    );
  }

  // 1. Load the authoring skill.
  let skill: SkillFiles;
  try {
    skill = opts.skillFiles ?? loadSkillFiles(findRepoRoot());
  } catch (err) {
    stderr.write(`glm: ${err instanceof Error ? err.message : String(err)}\n`);
    return 78;
  }

  const client = (opts.clientFactory ?? defaultClientFactory)(config);

  // 2. Fetch the node.
  let nodeRecord: NodeWithChildren;
  try {
    nodeRecord = await client.getNode(config.workspace, glmId);
  } catch (err) {
    return reportError(err, stderr);
  }

  // 3. Compose prompts.
  const systemPrompt = buildRefineSystemPrompt({ authoringSkill: skill.authoringSkill });
  const userPrompt = buildRefineUserPrompt({
    glmId,
    stratum: nodeRecord.node.stratum,
    nodeYaml: serializeNodeForPrompt(nodeRecord),
    instruction,
  });

  // 4. Spawn Claude.
  stderr.write(`refine: invoking ${config.model} on node '${glmId}'…\n`);
  const claudeRunner = opts.claudeRunner ?? runOneShot;
  const tmp = mkdtempSync(join(tmpdir(), 'glm-refine-'));
  const systemPromptFile = join(tmp, 'system-prompt.txt');
  let claudeStdout = '';
  try {
    writeFileSync(systemPromptFile, systemPrompt, 'utf8');
    const result = await claudeRunner({
      userText: userPrompt,
      systemPromptFile,
      model: config.model,
    });
    claudeStdout = result.stdout;
  } catch (err) {
    return reportError(err, stderr);
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  // 5. Parse and apply the JSON-Patch.
  let patch: JsonPatchOp[];
  try {
    patch = parseJsonPatchResponse(claudeStdout) as JsonPatchOp[];
  } catch (err) {
    stderr.write(`glm: ${(err as Error).message}\n`);
    return 70;
  }
  if (!Array.isArray(patch) || patch.length === 0) {
    stderr.write('glm: claude returned an empty JSON-Patch array — nothing to apply\n');
    return 70;
  }

  let newBody: unknown;
  try {
    newBody = applyJsonPatch(nodeRecord.node.body, patch);
  } catch (err) {
    stderr.write(`glm: failed to apply JSON-Patch: ${(err as Error).message}\n`);
    return 70;
  }

  if (args.flags['dry-run'] === true) {
    if (config.json) {
      stdout.write(`${JSON.stringify({ glmId, patch, newBody, applied: false })}\n`);
    } else {
      stdout.write(`refine: dry-run — would apply ${patch.length} op(s):\n`);
      for (const op of patch) {
        stdout.write(`  ${op.op} ${op.path}\n`);
      }
    }
    return 0;
  }

  // 6. Lock → PUT → unlock.
  try {
    await client.acquireLock(config.workspace, glmId);
  } catch (err) {
    return reportError(err, stderr);
  }

  let updated: NodeWithChildren['node'];
  try {
    updated = await client.updateNode(config.workspace, glmId, {
      body: newBody,
      // Increment the in-work iteration; revision_major + status are preserved
      // server-side from the existing record.
      revisionIteration: nodeRecord.node.revisionIteration + 1,
    });
  } catch (err) {
    // Best-effort lock release on failure.
    try { await client.releaseLock(config.workspace, glmId); } catch { /* ignore */ }
    return reportError(err, stderr);
  }

  try {
    await client.releaseLock(config.workspace, glmId);
  } catch {
    // Lock auto-expires; not a hard failure.
    stderr.write(`glm: warning — lock release failed but PUT succeeded\n`);
  }

  // 7. Report.
  if (config.json) {
    stdout.write(`${JSON.stringify({ glmId, patch, node: updated, applied: true })}\n`);
    return 0;
  }
  const byOp: Record<string, number> = {};
  for (const op of patch) byOp[op.op] = (byOp[op.op] ?? 0) + 1;
  const opSummary = Object.entries(byOp).map(([k, v]) => `${v} ${k}`).join(', ');
  stdout.write(
    `refine: applied ${patch.length} op(s) (${opSummary}) to ${glmId}\n` +
      `  revision:     ${updated.revisionMajor}.${updated.revisionIteration} (${updated.revisionStatus})\n` +
      `  content_hash: ${updated.contentHash}\n`,
  );
  return 0;
}

// --------------------------------------------------------------------- helpers

function defaultClientFactory(cfg: ResolvedConfig): GlmClient {
  return new GlmClient({ baseUrl: cfg.baseUrl, token: cfg.token });
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function readInstruction(args: ParsedArgs): string | undefined {
  const inline = stringFlag(args, 'instruction');
  if (inline) return inline;
  const file = stringFlag(args, 'instruction-file');
  if (file) {
    try {
      return readFileSync(file, 'utf8');
    } catch (err) {
      throw new CliUsageError(`failed to read --instruction-file ${file}: ${(err as Error).message}`);
    }
  }
  return undefined;
}

function serializeNodeForPrompt(record: NodeWithChildren): string {
  // Minimal YAML-ish text. The model only needs to see the body; the envelope
  // is here for context. We use JSON for the body since it's already a plain
  // object and the model handles either.
  const n = record.node;
  return [
    `id: ${n.glmId}`,
    `stratum: ${n.stratum}`,
    `title: ${n.title}`,
    `revision: { major: ${n.revisionMajor}, iteration: ${n.revisionIteration}, status: ${n.revisionStatus} }`,
    `content_hash: ${n.contentHash}`,
    'body:',
    JSON.stringify(n.body, null, 2),
  ].join('\n');
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
