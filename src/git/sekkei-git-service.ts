import { buildEcnMessage, type EcnRegen } from './ecn-commit.ts';
import { serializeSekkeiLock, lockHash, type SekkeiLockInput } from './sekkei-lock.ts';
import { GitClient, GitError, type GitCommitInfo } from './git-client.ts';
import { relative, join, dirname } from 'node:path';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { writeNodeFile, nodeFilePath, parseNode, yamlToNodeInput } from './yaml-store.ts';
import { parse as parseYaml } from 'yaml';
import type { NodeRepository } from '../repository/node-repository.ts';
import type { RolloutRepository } from '../repository/rollout-repository.ts';
import type { ScrRepository } from '../repository/scr-repository.ts';
import type { VariantRepository } from '../repository/variant-repository.ts';
import type { WorkspaceRepository, WorkspaceGitAttach } from '../repository/workspace-repository.ts';
import type { WorkspaceConflictsRepository } from '../repository/workspace-conflicts-repository.ts';
import type { ChangeLogRepository } from '../repository/change-log-repository.ts';
import type { DriftRepository } from '../repository/drift-repository.ts';
import type { EventBus } from '../ws/event-bus.ts';
import type { DriftGitClassification, DriftStatus, RolloutRecord, Scr, SekkeiNode, Sha256Hash, User, Variant } from '../types.ts';

/**
 * Orchestrator that turns an approved-and-implemented SCR into a single
 * ECN commit on the sekkei repo (spec §9.5, plan Phase 4 done-when).
 *
 * Flow:
 *   1. Resolve every node in `scr.target_nodes` from the workspace.
 *   2. Write each node's canonical YAML under `<repo>/nodes/<stratum>/...`.
 *   3. `git add` the new/modified files.
 *   4. `git commit` with an ECN message built from the SCR.
 *
 * The service is intentionally stateless: it does not hold the git client.
 * Callers pass one in per request so the route handler can scope it to the
 * workspace's repo.
 */

// ---------------------------------------------------------------------------
// Git Step 2 — Read-Only Sync
// ---------------------------------------------------------------------------

export interface SyncFromRemoteOptions {
  workspaceId: string;
  /** The workspace's recorded git_commit SHA before this sync. */
  knownCommit: string;
  /** Absolute path to the local clone. */
  gitCloneDir: string;
}

export interface SyncFromRemoteResult {
  /** New HEAD SHA after pull, or null if already up to date. */
  newCommit: string | null;
  /** Number of nodes upserted into the DB. */
  nodesUpdated: number;
  /** Whether the pull was blocked by a non-fast-forward divergence. */
  conflict: boolean;
}

/**
 * Pull new commits from the remote into the local clone, then reconcile the
 * DB against every node YAML file that changed between the old and new HEAD.
 *
 * Uses spawnSync throughout — this blocks the event loop for the duration of
 * the pull and YAML parsing. Acceptable for Step 2 (operator-triggered,
 * single-digit-second latency typical).
 */
export function syncFromRemote(
  repos: {
    workspaces: WorkspaceRepository;
    workspaceConflicts: WorkspaceConflictsRepository;
    nodes: NodeRepository;
    changeLog: ChangeLogRepository;
  },
  events: EventBus,
  opts: SyncFromRemoteOptions,
): SyncFromRemoteResult {
  const git = new GitClient({ repoPath: opts.gitCloneDir });

  let newHead: string;
  try {
    newHead = git.pull();
  } catch (err) {
    if (err instanceof GitError) {
      // Non-fast-forward: record the divergence and surface it via the event bus.
      const remoteHead = (() => {
        try { return git.revParse('FETCH_HEAD'); } catch { return 'unknown'; }
      })();
      repos.workspaceConflicts.insert({
        id: randomUUID(),
        workspaceId: opts.workspaceId,
        localCommit: opts.knownCommit,
        remoteCommit: remoteHead,
      });
      events.publish(opts.workspaceId, {
        type: 'git.conflict',
        payload: { localCommit: opts.knownCommit, remoteCommit: remoteHead },
        ts: new Date().toISOString(),
      });
      return { newCommit: null, nodesUpdated: 0, conflict: true };
    }
    throw err;
  }

  // Already up to date.
  if (newHead === opts.knownCommit) {
    return { newCommit: null, nodesUpdated: 0, conflict: false };
  }

  // Identify changed YAML files in the nodes/ tree.
  const changedFiles = git.logChangedFiles(opts.knownCommit, newHead);
  const nodeFiles = changedFiles.filter(
    (f) => f.startsWith('nodes/') && f.endsWith('.yaml'),
  );

  let nodesUpdated = 0;
  for (const filePath of nodeFiles) {
    let yamlText: string;
    try {
      yamlText = git.showFile(newHead, filePath);
    } catch {
      // File was deleted in this range; skip — deletion handling is Step 3+.
      continue;
    }

    let yaml;
    try {
      yaml = parseNode(yamlText);
    } catch (parseErr) {
      console.warn(`[git-sync] skipping malformed YAML at ${filePath}:`, parseErr);
      continue;
    }

    const existing = repos.nodes.findByGlmId(opts.workspaceId, yaml.id);
    const nodeInput = yamlToNodeInput(yaml, opts.workspaceId, existing?.node.id ?? randomUUID());

    if (existing) {
      repos.nodes.update(nodeInput);
    } else {
      repos.nodes.insert(nodeInput);
    }

    repos.changeLog.append({
      workspaceId: opts.workspaceId,
      nodeId: existing?.node.id ?? nodeInput.id,
      userId: null,
      op: 'git-sync',
      afterContentHash: yaml.content_hash,
    });

    nodesUpdated++;
  }

  // Advance the workspace's known HEAD.
  repos.workspaces.updateGitCommit(opts.workspaceId, newHead);

  events.publish(opts.workspaceId, {
    type: 'git.synced',
    payload: { from: opts.knownCommit, to: newHead, nodesUpdated },
    ts: new Date().toISOString(),
  });

  return { newCommit: newHead, nodesUpdated, conflict: false };
}

export interface AttachRemoteOptions {
  workspaceId: string;
  gitRemote: string;
  /** Branch / ref to track; defaults to `refs/heads/main`. */
  gitRef?: string;
  gitForge?: 'github' | 'gitlab' | null;
  gitAutoPush?: boolean;
  /** Base directory for clones; defaults to `<cwd>/data/repos`. */
  reposBaseDir?: string;
}

export interface AttachRemoteResult {
  gitCloneDir: string;
  gitCommit: string;
}

/**
 * Clone a remote into `data/repos/<workspaceId>/`, record the binding in the
 * workspace row, and return the clone directory + resolved HEAD SHA.
 *
 * This is the entry point for Git Step 1 (workspace attach). Uses spawnSync
 * internally, so it blocks the event loop for the duration of the clone —
 * acceptable for Step 1 (operator-triggered, infrequent). The caller is
 * responsible for wiring `getSekkeiGit` to return a GitClient pointed at
 * `gitCloneDir` afterward.
 */
export function attachRemote(
  repos: { workspaces: WorkspaceRepository },
  opts: AttachRemoteOptions,
): AttachRemoteResult {
  const rawRef = opts.gitRef ?? 'main';
  // Normalize refs/heads/foo → foo so `git checkout` tracks the branch correctly.
  const checkoutRef = rawRef.startsWith('refs/heads/') ? rawRef.slice('refs/heads/'.length) : rawRef;
  const gitRef = rawRef;
  const reposBase = opts.reposBaseDir ?? join(process.cwd(), 'data', 'repos');
  const gitCloneDir = join(reposBase, opts.workspaceId);

  // Guard against re-attach after detach — the clone dir is left on disk by design.
  if (existsSync(gitCloneDir)) {
    throw new Error(
      `clone directory already exists: ${gitCloneDir} — remove it manually before re-attaching`,
    );
  }

  // Ensure parent directory exists; git clone creates the leaf itself.
  mkdirSync(reposBase, { recursive: true });

  const git = GitClient.clone(opts.gitRemote, gitCloneDir, { noCheckout: true });
  git.checkout(checkoutRef);

  const gitCommit = git.revParse('HEAD');

  const binding: WorkspaceGitAttach = {
    gitRemote: opts.gitRemote,
    gitRef,
    gitCommit,
    gitCloneDir,
    gitForge: opts.gitForge ?? null,
    gitAutoPush: opts.gitAutoPush ?? false,
  };

  repos.workspaces.attachGit(opts.workspaceId, binding);

  return { gitCloneDir, gitCommit };
}

export interface ImplementOptions {
  git: GitClient;
  scr: Scr;
  signedOffBy: string;
  /** Path inside the repo (relative) for each regen-required file. */
  regenRequired?: EcnRegen[];
  /** Pretty one-line summary; defaults to the SCR title. */
  summary?: string;
}

export interface ImplementResult {
  commit: GitCommitInfo;
  writtenFiles: string[];
  /** The feature branch name (feature/<scrId>); already merged and deleted locally. */
  branchName: string;
}

/**
 * Per-workspace mutex chain. The git working tree has a single index, so
 * two concurrent `commitScrImplementation` calls in the same workspace can
 * interleave each other's `git add` with the other's `git commit`. Serialize
 * by chaining through a Promise per workspace id; entries are dropped once
 * the chain reaches the head so the Map stays bounded.
 */
const workspaceMutex = new Map<string, Promise<unknown>>();

function withWorkspaceLock<T>(workspaceId: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = workspaceMutex.get(workspaceId) ?? Promise.resolve();
  const next = previous.then(() => fn()).finally(() => {
    // Drop the entry only if we're still the tail of the chain.
    if (workspaceMutex.get(workspaceId) === next) workspaceMutex.delete(workspaceId);
  });
  workspaceMutex.set(workspaceId, next);
  return next as Promise<T>;
}

export async function commitScrImplementation(
  repos: { nodes: NodeRepository; scrs: ScrRepository },
  user: Pick<User, 'email' | 'displayName'>,
  opts: ImplementOptions,
): Promise<ImplementResult> {
  const { git, scr } = opts;

  return withWorkspaceLock(scr.workspaceId, () => {
    // Record the integration branch so we can merge back after the commit.
    const integrationBranch = git.currentBranch();
    const featureBranch = `feature/${scr.id.replace(/[^a-zA-Z0-9\-_]/g, '-')}`;

    // 1. Resolve the affected nodes
    const nodes: { node: SekkeiNode; children: NonNullable<ReturnType<NodeRepository['findById']>> }[] = [];
    for (const glmId of scr.targetNodes) {
      const found = repos.nodes.findByGlmId(scr.workspaceId, glmId);
      if (!found) throw new Error(`SCR ${scr.id} targets unknown node '${glmId}'`);
      nodes.push({ node: found.node, children: found });
    }

    // 2. Checkout the feature branch from the integration branch HEAD.
    git.branch(featureBranch, { checkout: true });

    let commit: GitCommitInfo;
    const writtenAbs: string[] = [];
    try {
      // 3. Write YAML files
      const writtenRel: string[] = [];
      for (const { node, children } of nodes) {
        const abs = writeNodeFile(git.repoPath, node, children);
        writtenAbs.push(abs);
        writtenRel.push(relative(git.repoPath, abs).replace(/\\/g, '/'));
      }

      // 4. Stage and commit
      git.add(writtenRel);

      const message = buildEcnMessage({
        summary: opts.summary ?? scr.title,
        affected: scr.targetNodes,
        why: scr.problem,
        regenRequired: opts.regenRequired,
        scrId: scr.id,
        signedOffBy: opts.signedOffBy,
      });

      commit = git.commit({
        message,
        authorName: user.displayName,
        authorEmail: user.email,
        signed: scr.scrClass === 'I' && process.env.GLM_SIGN_COMMITS === 'true',
      });
    } catch (err) {
      // Best-effort recovery: return HEAD to the integration branch so the
      // next call to commitScrImplementation reads the correct base branch.
      try { git.checkout(integrationBranch); } catch { /* ignored */ }
      throw err;
    }

    // 5. Fast-forward merge back to the integration branch, then delete the feature branch.
    git.checkout(integrationBranch);
    git.merge(featureBranch);
    git.deleteBranch(featureBranch);

    return { commit, writtenFiles: writtenAbs, branchName: featureBranch };
  });
}

/** Convenience: where would this node's YAML file land? */
export function nodeFile(repoPath: string, node: SekkeiNode): string {
  return nodeFilePath(repoPath, node.stratum, node.glmId);
}

// ---------------------------------------------------------------------------
// Git Step 4 — Variant Publish
// ---------------------------------------------------------------------------

export interface PublishVariantOptions {
  git: GitClient;
  variant: Variant;
  lock: SekkeiLockInput;
}

export interface PublishVariantResult {
  /** Long-form branch ref, e.g. `variants/acme-stable`. */
  gitRef: string;
  /** SHA of the lock commit. */
  gitCommit: string;
  /** sha256 of the serialized sekkei.lock bytes. */
  closureHash: string;
}

/**
 * Write `sekkei.lock` on a `variants/<label>` branch via a git worktree, then
 * record the commit SHA and closure hash on the variant row.
 *
 * Uses the same `withWorkspaceLock` mutex as `commitScrImplementation` so that
 * concurrent publishes in the same workspace don't race on the index.
 */
export async function publishVariant(
  repos: { variants: VariantRepository },
  opts: PublishVariantOptions,
): Promise<PublishVariantResult> {
  const { git, variant, lock } = opts;

  return withWorkspaceLock(variant.workspaceId, () => {
    const safeName = variant.label.replace(/[^a-zA-Z0-9\-_]/g, '-');
    const variantBranch = `variants/${safeName}`;
    const gitRef = `refs/heads/${variantBranch}`;

    // Worktrees live adjacent to the clone: <clone-parent>/worktrees/<variantId>/
    const worktreePath = join(dirname(git.repoPath), 'worktrees', variant.id);

    // Prune any stale worktree registrations so `worktreeAdd` doesn't collide
    // if a previous publish crashed before `worktreeRemove`.
    git.worktreePrune();

    const branchExists = git.branchExists(variantBranch);
    const wtGit = git.worktreeAdd(worktreePath, variantBranch, { newBranch: !branchExists });

    let lockCommit: GitCommitInfo;
    try {
      const lockText = serializeSekkeiLock(lock);
      const closureHash = lockHash(lockText);

      writeFileSync(join(worktreePath, 'sekkei.lock'), lockText, 'utf8');
      wtGit.add(['sekkei.lock']);
      const staged = wtGit.statusPorcelain();
      if (staged.length > 0) {
        lockCommit = wtGit.commit({
          message: `Resolve variant ${variant.label} @ ${closureHash.slice('sha256:'.length, 'sha256:'.length + 12)}`,
        });
      } else {
        // Identical lock — reuse the existing HEAD commit.
        const headHash = wtGit.revParse('HEAD');
        lockCommit = { hash: headHash, shortHash: headHash.slice(0, 12) };
      }

      repos.variants.setGitInfo(variant.id, {
        gitRef,
        gitCommit: lockCommit.hash,
        closureHash,
      });

      return { gitRef, gitCommit: lockCommit.hash, closureHash };
    } finally {
      // Always remove the worktree, even on failure, to avoid stale dirs.
      try { git.worktreeRemove(worktreePath); } catch { /* ignored */ }
    }
  });
}

// ---------------------------------------------------------------------------
// Git Step 6 — Drift Sweep
// ---------------------------------------------------------------------------

export interface DriftSweepOptions {
  workspaceId: string;
  /** Current HEAD SHA of the sekkei repo — stored as `spec_commit` on each record. */
  sekkeiCommit: string;
  /** GitClient pointed at the `glm-realization/` local clone. */
  realizationGit: GitClient;
}

export interface DriftSweepResult {
  /** Number of records newly drifted or with an updated observed hash. */
  detected: number;
  /** Number of records auto-resolved because the hash now matches. */
  autoResolved: number;
}

/**
 * Compare every drift record's `desiredHash` against the actual file content
 * in the realization clone (via `git show HEAD:<file>`).
 *
 * - On hash mismatch: upsert the record with the new observed hash, classify
 *   the diff, and write the commit SHAs via `setGitInfo`.
 * - On hash match where the record was drifted: auto-close back to Synced.
 *
 * Uses the per-workspace mutex so it cannot race with concurrent ECN commits.
 */
export async function runDriftSweep(
  repos: { drift: DriftRepository },
  opts: DriftSweepOptions,
): Promise<DriftSweepResult> {
  return withWorkspaceLock(opts.workspaceId, () => {
    const realizationHead = opts.realizationGit.revParse('HEAD');
    const records = repos.drift.listByWorkspace(opts.workspaceId);

    let detected = 0;
    let autoResolved = 0;

    for (const record of records) {
      if (!record.file) continue;

      const actualHash = realizationFileHash(opts.realizationGit, record.file);

      if (actualHash === null) {
        // File is absent from the realization repo.
        if (record.status !== 'Hash-Drifted' && record.status !== 'Live-Drifted') {
          repos.drift.upsert({ ...record, observedHash: null, status: 'Live-Drifted' });
          repos.drift.setGitInfo(record.id, {
            realizationCommit: realizationHead,
            specCommit: opts.sekkeiCommit,
            classification: 'human_improvement',
            autoResolvable: false,
          });
          detected++;
        }
        continue;
      }

      if (record.desiredHash !== null && record.desiredHash === actualHash) {
        // Hash matches: auto-close if currently drifted.
        if (record.status === 'Hash-Drifted' || record.status === 'Live-Drifted') {
          repos.drift.upsert({ ...record, observedHash: actualHash, status: 'Synced' });
          repos.drift.setGitInfo(record.id, {
            realizationCommit: realizationHead,
            specCommit: opts.sekkeiCommit,
            classification: record.classification ?? 'format',
            autoResolvable: false,
          });
          autoResolved++;
        }
        continue;
      }

      // Hash mismatch: classify the change and record the new observed hash.
      const diffText = realizationDiff(opts.realizationGit, record.file);
      // null = initial commit (no parent) → treat as human_improvement, not format.
      const { classification, autoResolvable } =
        diffText !== null
          ? classifyDiff(diffText)
          : { classification: 'human_improvement' as DriftGitClassification, autoResolvable: false };
      const newStatus: DriftStatus = record.kind === 'hash' ? 'Hash-Drifted' : 'Live-Drifted';

      repos.drift.upsert({ ...record, observedHash: actualHash, status: newStatus });
      repos.drift.setGitInfo(record.id, {
        realizationCommit: realizationHead,
        specCommit: opts.sekkeiCommit,
        classification,
        autoResolvable,
      });
      detected++;
    }

    return { detected, autoResolved };
  });
}

// ---------------------------------------------------------------------------
// Drift helpers (module-private)
// ---------------------------------------------------------------------------

/**
 * SHA-256 of the file content at HEAD in the realization clone, or null if absent.
 *
 * Note: `GitClient.run()` normalizes CRLF → LF in stdout before returning.
 * Callers that produce `desiredHash` values must apply the same normalization
 * (i.e., hash the LF-normalized content) for comparisons to be stable on
 * Windows repos where `core.autocrlf` may inject CRLFs into the working tree.
 */
function realizationFileHash(git: GitClient, filePath: string): Sha256Hash | null {
  try {
    const content = git.run(['show', `HEAD:${filePath}`]);
    return `sha256:${createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')}`;
  } catch {
    return null;
  }
}

/**
 * Unified diff of the last commit that touched `filePath` against its parent.
 *
 * Returns `null` when there is no parent commit (initial commit in the
 * realization repo). Callers must treat `null` as an unclassifiable change
 * rather than an empty diff, to avoid misclassifying a brand-new file as a
 * whitespace-only (`format`) change.
 */
function realizationDiff(git: GitClient, filePath: string): string | null {
  // Verify a parent commit exists before attempting the diff.
  try {
    git.run(['rev-parse', 'HEAD~1']);
  } catch {
    return null;
  }
  try {
    return git.diff('HEAD~1', 'HEAD', filePath);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Git Step 8 — Effectivity Tags / createRelease
// ---------------------------------------------------------------------------

/**
 * Release tag names must be a single uppercase letter followed by a dot and
 * one or more digits, e.g. `A.0`, `A.1`, `B.0`.
 */
export const RELEASE_TAG_RE = /^[A-Z]\.\d+$/;

export interface CreateReleaseOptions {
  workspaceId: string;
  git: GitClient;
  /** Release tag name, e.g. `"A.1"`. Must match `/^[A-Z]\.\d+$/`. */
  name: string;
  /** Human-readable release message attached to the annotated tag. */
  message: string;
  /** When true, creates a GPG-signed tag (`-s`). Requires a local signing key. */
  signed?: boolean;
}

export interface CreateReleaseResult {
  tag: string;
  /** SHA of the commit the tag points at. */
  commit: string;
  /** One rollout_records row per (variant, changed-node) pair. */
  rolloutRecords: RolloutRecord[];
}

/**
 * Create a signed-annotated release tag on HEAD and seed the rollout_records
 * table for every variant node that changed since the previous release tag.
 *
 * On the first release (no prior matching tag) all variant nodes are enrolled.
 * On subsequent releases only nodes whose YAML files changed between the prior
 * tag commit and the new HEAD are enrolled.
 */
export async function createRelease(
  repos: {
    variants: VariantRepository;
    rollout: RolloutRepository;
    nodes: NodeRepository;
  },
  opts: CreateReleaseOptions,
): Promise<CreateReleaseResult> {
  if (!RELEASE_TAG_RE.test(opts.name)) {
    throw new Error(
      `invalid release tag name '${opts.name}': must match /^[A-Z]\\.\\d+$/`,
    );
  }

  return withWorkspaceLock(opts.workspaceId, () => {
    const { git } = opts;

    // Tag the current HEAD.
    git.tag(opts.name, { message: opts.message, signed: opts.signed ?? false });
    const headCommit = git.revParse('HEAD');

    // Find the most-recent prior release tag (excluding the one just created).
    const allTags = git.listTags('[A-Z].*').filter((t) => t !== opts.name);
    // Numeric sort so A.10 comes after A.9 (lexicographic would place A.10 before A.2).
    allTags.sort((a, b) => {
      const [aL, aV] = a.split('.');
      const [bL, bV] = b.split('.');
      if (aL !== bL) return (aL ?? '') < (bL ?? '') ? -1 : 1;
      return parseInt(aV ?? '0', 10) - parseInt(bV ?? '0', 10);
    });
    const priorTag = allTags.length > 0 ? allTags[allTags.length - 1] : null;

    // Determine the set of changed node glm_ids.
    const changedGlmIds = new Set<string>();

    if (priorTag) {
      const priorCommit = git.revParse(priorTag);
      const changedFiles = git.logChangedFiles(priorCommit, headCommit).filter(
        (f) => f.startsWith('nodes/') && f.endsWith('.yaml'),
      );
      for (const f of changedFiles) {
        const glmId = glmIdFromNodeFilePath(f);
        if (glmId) changedGlmIds.add(glmId);
      }
    }
    // priorTag === null means first release: changedGlmIds stays empty → we
    // enroll ALL variant nodes (see the filter below).

    const variants = repos.variants.listVariants(opts.workspaceId);
    const records: RolloutRecord[] = [];

    for (const variant of variants) {
      const rolloutRows = repos.variants.listRollout(variant.id);
      for (const row of rolloutRows) {
        const nodeResult = repos.nodes.findById(row.nodeId);
        if (!nodeResult) continue;

        // Subsequent release: skip nodes that didn't change.
        if (priorTag && !changedGlmIds.has(nodeResult.node.glmId)) continue;

        // Attempt to read the prior content hash from the tag's YAML snapshot.
        let fromRev: string | null = null;
        if (priorTag) {
          const filePath = `nodes/${nodeResult.node.stratum}/${nodeResult.node.glmId.replace(/:/g, '__')}.yaml`;
          try {
            const priorYaml = git.showFile(priorTag, filePath);
            const parsed = parsePriorContentHash(priorYaml);
            fromRev = parsed ?? null;
          } catch {
            // File was added in this release; from_rev stays null.
          }
        }

        const record = repos.rollout.insert({
          id: randomUUID(),
          variantId: variant.id,
          nodeId: row.nodeId,
          fromRev,
          toRev: nodeResult.node.contentHash,
          releaseTag: opts.name,
        });
        records.push(record);
      }
    }

    return { tag: opts.name, commit: headCommit, rolloutRecords: records };
  });
}

/**
 * Parse a glm_id from a `nodes/<stratum>/<safe-glm-id>.yaml` path.
 * `safe-glm-id` has `:` encoded as `__` (reversible; see yaml-store.ts).
 */
function glmIdFromNodeFilePath(filePath: string): string | null {
  const match = filePath.match(/^nodes\/[^/]+\/(.+)\.yaml$/);
  if (!match) return null;
  return match[1].replace(/__/g, ':');
}

/**
 * Extract the `content_hash` field from a YAML snapshot of a node file.
 * Returns null when the field is absent or the YAML is unparseable.
 */
function parsePriorContentHash(yamlText: string): string | null {
  try {
    const doc = parseYaml(yamlText) as { content_hash?: unknown } | null;
    const hash = doc?.content_hash;
    return typeof hash === 'string' ? hash : null;
  } catch {
    return null;
  }
}

/**
 * Classify a unified diff string into a `DriftGitClassification`.
 *
 * Heuristics (in priority order):
 *   1. Empty diff or whitespace-only changes → `format` (auto-resolvable).
 *   2. Diff contains HOTFIX / hot-patch markers → `hot_patch`.
 *   3. Everything else → `human_improvement`.
 *
 * `spec_implied` requires LLM-level diff understanding and is reserved for
 * the diff-aware regeneration step (Git Step 7).
 */
function classifyDiff(diffText: string): { classification: DriftGitClassification; autoResolvable: boolean } {
  if (!diffText.trim()) {
    return { classification: 'format', autoResolvable: true };
  }

  const lines = diffText.split('\n');
  const changedLines = lines.filter(
    (l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'),
  );

  if (changedLines.every((l) => l.slice(1).trim() === '')) {
    return { classification: 'format', autoResolvable: true };
  }

  const lower = diffText.toLowerCase();
  if (lower.includes('hotfix') || lower.includes('hot-patch') || lower.includes('hot_patch')) {
    return { classification: 'hot_patch', autoResolvable: false };
  }

  return { classification: 'human_improvement', autoResolvable: false };
}
