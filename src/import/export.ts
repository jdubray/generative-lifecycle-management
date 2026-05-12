import { stringify as stringifyYaml } from 'yaml';
import type { NodeRepository, NodeWithChildren } from '../repository/node-repository.ts';
import type { SekkeiNode } from '../types.ts';

/**
 * Workspace → YAML export. Mirrors the on-disk layout the importer's
 * directory mode expects so a workspace can round-trip:
 *
 *   nodes/<stratum>/<glmIdSafe>.yaml
 *
 * `<glmIdSafe>` replaces `:` with `__` for Windows compatibility (the same
 * convention `src/git/yaml-store.ts` already uses).
 *
 * Pure: takes a list of `NodeWithChildren` rows and returns a list of
 * documents the caller can write to disk or pipe over the wire. No I/O.
 */

export interface ExportDoc {
  /** Path relative to the export root (forward-slash on every OS). */
  filename: string;
  content: string;
}

export function exportNodes(rows: NodeWithChildren[]): ExportDoc[] {
  return rows.map((row) => ({
    filename: `nodes/${row.node.stratum}/${safeGlmId(row.node.glmId)}.yaml`,
    content: serializeNode(row),
  }));
}

/** Helper that pulls a workspace's nodes via the repository and exports them. */
export function exportWorkspace(repo: NodeRepository, workspaceId: string): ExportDoc[] {
  return exportNodes(repo.listByWorkspace(workspaceId));
}

export function safeGlmId(glmId: string): string {
  return glmId.replace(/:/g, '__');
}

function serializeNode(row: NodeWithChildren): string {
  const node = row.node;
  const yaml = {
    id: node.glmId,
    stratum: node.stratum,
    title: node.title,
    description: node.description,
    revision: {
      major: node.revisionMajor,
      iteration: node.revisionIteration,
      status: node.revisionStatus,
    },
    provenance: {
      derives_from: node.derivesFromNodeId
        ? { id: derivesFromGlmId(row, node.derivesFromNodeId), content_hash: 'sha256:unresolved' }
        : null,
      override_kind: node.overrideKind,
      authored_by: node.authoredBy,
      authored_at: node.authoredAt,
    },
    parameters: row.parameters.map((p) => ({
      name: p.name,
      schema: {
        type: p.type,
        ...(p.options ? { enum: p.options } : {}),
        ...(p.minValue !== null && p.minValue !== undefined ? { minimum: p.minValue } : {}),
        ...(p.maxValue !== null && p.maxValue !== undefined ? { maximum: p.maxValue } : {}),
      },
      default: p.defaultValue,
      binding_scope: p.bindingScope,
    })),
    constraints: row.constraints.map((c) => ({
      kind: c.kind,
      expression: c.expression,
      severity: c.severity,
    })),
    relationships: row.relationships.map((r) => ({
      kind: r.kind,
      target: r.targetGlmId,
      ...(r.attributes ? { attributes: r.attributes } : {}),
    })),
    body: node.body,
    content_hash: node.contentHash,
  };
  // Drop empty arrays so a Component without parameters doesn't ship an empty key.
  if (yaml.parameters.length === 0) delete (yaml as { parameters?: unknown }).parameters;
  if (yaml.constraints.length === 0) delete (yaml as { constraints?: unknown }).constraints;
  if (yaml.relationships.length === 0) delete (yaml as { relationships?: unknown }).relationships;
  return stringifyYaml(yaml, { lineWidth: 0, indent: 2 });
}

/**
 * Walk the row's derives_from db_id back to a glm_id. The repository only
 * gives us the db id; we don't keep a back-pointer cache here so callers
 * pass the resolved glm_id directly when known. For workspace-scoped
 * exports we can fall back to a placeholder when we can't resolve.
 */
function derivesFromGlmId(_row: NodeWithChildren, dbId: string): string {
  // Best-effort placeholder — the directory exporter overrides this via the
  // workspace-level resolver below.
  return `db:${dbId}`;
}

/**
 * Same as `exportNodes`, but resolves `derives_from` db_id back to the
 * source glm_id when both sides live in the workspace. Use this from the
 * CLI/server callers that already have the full row list.
 */
export function exportWorkspaceResolved(repo: NodeRepository, workspaceId: string): ExportDoc[] {
  const rows = repo.listByWorkspace(workspaceId);
  const byDbId = new Map<string, SekkeiNode>(rows.map((r) => [r.node.id, r.node]));
  return rows.map((row) => ({
    filename: `nodes/${row.node.stratum}/${safeGlmId(row.node.glmId)}.yaml`,
    content: serializeNodeResolved(row, byDbId),
  }));
}

function serializeNodeResolved(
  row: NodeWithChildren,
  byDbId: Map<string, SekkeiNode>,
): string {
  const node = row.node;
  const lineageDbId = node.derivesFromNodeId;
  const lineageGlmId = lineageDbId ? byDbId.get(lineageDbId)?.glmId ?? null : null;
  const yaml = {
    id: node.glmId,
    stratum: node.stratum,
    title: node.title,
    description: node.description,
    revision: {
      major: node.revisionMajor,
      iteration: node.revisionIteration,
      status: node.revisionStatus,
    },
    provenance: {
      derives_from: lineageGlmId
        ? { id: lineageGlmId, content_hash: 'sha256:unresolved' }
        : null,
      override_kind: node.overrideKind,
      authored_by: node.authoredBy,
      authored_at: node.authoredAt,
    },
    parameters: row.parameters.map((p) => ({
      name: p.name,
      schema: {
        type: p.type,
        ...(p.options ? { enum: p.options } : {}),
        ...(p.minValue !== null && p.minValue !== undefined ? { minimum: p.minValue } : {}),
        ...(p.maxValue !== null && p.maxValue !== undefined ? { maximum: p.maxValue } : {}),
      },
      default: p.defaultValue,
      binding_scope: p.bindingScope,
    })),
    constraints: row.constraints.map((c) => ({
      kind: c.kind,
      expression: c.expression,
      severity: c.severity,
    })),
    relationships: row.relationships.map((r) => ({
      kind: r.kind,
      target: r.targetGlmId,
      ...(r.attributes ? { attributes: r.attributes } : {}),
    })),
    body: node.body,
    content_hash: node.contentHash,
  };
  if (yaml.parameters.length === 0) delete (yaml as { parameters?: unknown }).parameters;
  if (yaml.constraints.length === 0) delete (yaml as { constraints?: unknown }).constraints;
  if (yaml.relationships.length === 0) delete (yaml as { relationships?: unknown }).relationships;
  return stringifyYaml(yaml, { lineWidth: 0, indent: 2 });
}
