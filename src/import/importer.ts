import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { adaptYamlNode, YamlAdapterError } from './adapter.ts';
import { loadDocs, type ImportSource } from './yaml-source.ts';
import { contentHash } from '../domain/content-hash.ts';
import type { AuditRepository } from '../repository/audit-repository.ts';
import { NodeRepository, type NodeInput } from '../repository/node-repository.ts';
import type { UserRepository } from '../repository/user-repository.ts';
import { WorkspaceRepository } from '../repository/workspace-repository.ts';
import type { UserRole, Workspace, WorkspaceMemberRole } from '../types.ts';

export type { ImportSource } from './yaml-source.ts';

/**
 * Imports a sekkei tree on disk into a workspace.
 *
 * Two-pass strategy:
 *   1. Walk every `*.yaml` under `path`, parse multi-document streams,
 *      adapt each doc, and upsert into `nodes` (matching by glm_id so
 *      re-imports refresh in place).
 *   2. Resolve `provenance.derives_from.id` references to db row ids,
 *      writing the FK with one UPDATE per touched node.
 *
 * Idempotent: re-running against an unchanged tree leaves the DB
 * unchanged. Re-running after a YAML edit updates only the nodes whose
 * canonical body hash changed.
 *
 * Bypasses route-level `assertValidBody` because the reverse-engineered
 * YAML carries richer body shapes (e.g. `contract_kind` with a structured
 * `contract_definition` block) than the v1 `validateBody` accepts. The
 * 6-gate verifier surfaces those as warnings; the user fixes them by
 * editing nodes via the regular CRUD route after import.
 */

export interface ImportInput {
  /**
   * Where the YAML comes from. `kind: 'directory'` walks a filesystem path;
   * `kind: 'inline'` accepts pre-loaded `{ filename, content }` blobs (used
   * by the REST endpoint so a browser can upload files directly).
   */
  source: ImportSource;
  workspace: {
    slug: string;
    name: string;
    /** Reuses the matching `workspaces.id` when present; creates one otherwise. */
    id?: string;
  };
  /** When set, the user is created if missing and added as `owner`. */
  owner?: {
    email: string;
    displayName?: string;
    role?: UserRole;
    memberRole?: WorkspaceMemberRole;
  };
  /** When true, all writes happen inside a transaction that's rolled back at the end. */
  dryRun?: boolean;
  /** Override the timestamp on audit_events row (tests). */
  clock?: () => Date;
}

export interface ImportSummary {
  workspace: Workspace;
  filesScanned: number;
  nodesInserted: number;
  nodesUpdated: number;
  nodesUnchanged: number;
  derivesFromResolved: number;
  derivesFromMissing: Array<{ glmId: string; missingTarget: string }>;
  warnings: string[];
  dryRun: boolean;
}

export interface ImporterRepos {
  workspaces: WorkspaceRepository;
  users: UserRepository;
  nodes: NodeRepository;
  audit: AuditRepository;
}

export interface ImporterDeps {
  db: Database;
  repos: ImporterRepos;
}

/**
 * Top-level driver. Wrap in `db.transaction` when `dryRun` so failures
 * (including the synthetic throw used to roll back at the end) don't leave
 * partial state.
 */
export function runImport(deps: ImporterDeps, input: ImportInput): ImportSummary {
  const clock = input.clock ?? (() => new Date());

  const summary: ImportSummary = {
    workspace: { id: '', slug: '', name: '', createdAt: clock().toISOString() },
    filesScanned: 0,
    nodesInserted: 0,
    nodesUpdated: 0,
    nodesUnchanged: 0,
    derivesFromResolved: 0,
    derivesFromMissing: [],
    warnings: [],
    dryRun: input.dryRun ?? false,
  };

  const docs = loadDocs(input.source);
  summary.filesScanned = docs.length;

  const tx = deps.db.transaction(() => {
    // 1. Workspace + owner
    const workspace = ensureWorkspace(deps.repos.workspaces, input.workspace, clock);
    summary.workspace = workspace;

    if (input.owner) {
      attachOwner(deps.repos.users, deps.repos.workspaces, workspace.id, input.owner, clock);
    }

    // 2. First pass — adapt + upsert nodes (derives_from FK left null)
    const glmIdToDbId = new Map<string, string>();
    const adaptedByGlmId = new Map<string, NodeInput>();
    for (const { doc, file } of docs) {
      let adapted;
      try {
        const existing = deps.repos.nodes.findByGlmId(workspace.id, doc.id);
        const dbId = existing?.node.id ?? randomUUID();
        adapted = adaptYamlNode(doc, workspace.id, dbId);
      } catch (err) {
        if (err instanceof YamlAdapterError) {
          summary.warnings.push(`${file}: ${err.message}`);
          continue;
        }
        throw err;
      }
      for (const w of adapted.warnings) summary.warnings.push(`${file}: ${w}`);

      const existing = deps.repos.nodes.findByGlmId(workspace.id, doc.id);
      if (existing) {
        if (existing.node.contentHash === computeIncomingHash(adapted.input)) {
          summary.nodesUnchanged++;
        } else {
          deps.repos.nodes.update(adapted.input);
          summary.nodesUpdated++;
        }
      } else {
        deps.repos.nodes.insert(adapted.input);
        summary.nodesInserted++;
      }
      glmIdToDbId.set(doc.id, adapted.input.id);
      adaptedByGlmId.set(doc.id, adapted.input);

      // Remember the un-resolved derives_from glm_id for pass 2.
      if (adapted.derivesFromGlmId) {
        adaptedByGlmId.set(doc.id, {
          ...adapted.input,
          derivesFromNodeId: adapted.derivesFromGlmId, // marker; replaced in pass 2
        });
      }
    }

    // 3. Second pass — resolve derives_from glm_id → db row id
    for (const [glmId, input2] of adaptedByGlmId) {
      const marker = input2.derivesFromNodeId;
      if (!marker || marker === null) continue;
      const resolved = glmIdToDbId.get(marker);
      if (!resolved) {
        summary.derivesFromMissing.push({ glmId, missingTarget: marker });
        continue;
      }
      // Run a targeted UPDATE — cheaper than re-issuing a full repository update.
      deps.db
        .prepare('UPDATE nodes SET derives_from_node_id = ? WHERE id = ?')
        .run(resolved, input2.id);
      summary.derivesFromResolved++;
    }

    // Only write the audit row when we can attribute the import to a real
    // user — `audit_events.user_id` is NOT NULL REFERENCES users(id), and
    // there's no synthetic system row to fall back to. CLI invocations
    // without --owner consequently leave no audit trail (a known v1 gap).
    const auditUserId = input.owner
      ? findUserIdByEmail(deps.repos.users, input.owner.email)
      : null;
    if (auditUserId) {
      deps.repos.audit.append({
        id: randomUUID(),
        workspaceId: workspace.id,
        userId: auditUserId,
        eventType: 'workspace.import',
        payload: {
          source: summarizeSource(input.source),
          filesScanned: summary.filesScanned,
          inserted: summary.nodesInserted,
          updated: summary.nodesUpdated,
          unchanged: summary.nodesUnchanged,
          warnings: summary.warnings.length,
          dryRun: summary.dryRun,
        },
        ts: clock().toISOString(),
      });
    }

    if (summary.dryRun) {
      // Force the transaction to roll back so nothing persists.
      throw new DryRunRollback();
    }
  });

  try {
    tx();
  } catch (err) {
    if (err instanceof DryRunRollback) return summary;
    throw err;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

class DryRunRollback extends Error {
  constructor() {
    super('dry-run');
    this.name = 'DryRunRollback';
  }
}

function summarizeSource(source: ImportSource): string {
  return source.kind === 'directory'
    ? source.path
    : `inline:${source.documents.length} document(s)`;
}

function ensureWorkspace(
  repo: WorkspaceRepository,
  input: ImportInput['workspace'],
  clock: () => Date,
): Workspace {
  const existing = repo.findBySlug(input.slug);
  if (existing) return existing;
  return repo.insert({
    id: input.id ?? randomUUID(),
    slug: input.slug,
    name: input.name,
    createdAt: clock().toISOString(),
  });
}

function attachOwner(
  users: UserRepository,
  workspaces: WorkspaceRepository,
  workspaceId: string,
  owner: NonNullable<ImportInput['owner']>,
  clock: () => Date,
): void {
  let user = users.findByEmail(owner.email);
  if (!user) {
    user = users.insert({
      id: randomUUID(),
      email: owner.email,
      displayName: owner.displayName ?? owner.email.split('@')[0] ?? owner.email,
      role: owner.role ?? 'editor',
      createdAt: clock().toISOString(),
    });
  }
  const existingMembership = workspaces.findMember(workspaceId, user.id);
  if (!existingMembership) {
    workspaces.addMember({
      workspaceId,
      userId: user.id,
      role: owner.memberRole ?? 'owner',
      joinedAt: clock().toISOString(),
    });
  }
}

function findUserIdByEmail(users: UserRepository, email: string): string | null {
  const user = users.findByEmail(email);
  return user?.id ?? null;
}

/**
 * Compute the content_hash the `NodeRepository.insert` path would assign
 * to the supplied input. Lets us decide UPDATE vs UNCHANGED without
 * issuing a write first.
 */
function computeIncomingHash(input: NodeInput): string {
  return contentHash(input.body);
}
