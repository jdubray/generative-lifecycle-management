import type { Database, Statement } from 'bun:sqlite';
import { contentHash, ContentHashMismatchError, verifyContentHash } from '../domain/content-hash.ts';
import type {
  NodeConstraint,
  NodeParameter,
  NodeRelationship,
  SekkeiNode,
  Stratum,
} from '../types.ts';

/**
 * Aggregate input for creating / replacing a node along with its body and
 * supporting rows (parameters / constraints / relationships). The caller
 * does not supply `contentHash` — the repository computes it from the
 * canonical body.
 */
export interface NodeInput {
  id: string;
  workspaceId: string;
  glmId: string;
  stratum: Stratum;
  title: string;
  description?: string;
  body: unknown;
  revisionMajor: string;
  revisionIteration: number;
  revisionStatus: SekkeiNode['revisionStatus'];
  overrideKind: SekkeiNode['overrideKind'];
  derivesFromNodeId?: string | null;
  systemRole?: string | null;
  specKind?: string | null;
  authoredBy: string;
  authoredAt?: string;
  updatedAt?: string;
  generatorIdentity?: SekkeiNode['generatorIdentity'];
  parameters?: Array<Omit<NodeParameter, 'nodeId'>>;
  constraints?: Array<Omit<NodeConstraint, 'nodeId'>>;
  relationships?: Array<Omit<NodeRelationship, 'sourceNodeId'>>;
}

export interface NodeWithChildren {
  node: SekkeiNode;
  parameters: NodeParameter[];
  constraints: NodeConstraint[];
  relationships: NodeRelationship[];
}

/**
 * Repository over the `nodes` table and its three child tables. Computes and
 * verifies `content_hash` on every write and every read; a stored body that
 * does not match its hash raises `ContentHashMismatchError`.
 */
export class NodeRepository {
  private readonly db: Database;
  private readonly stInsertNode: Statement;
  private readonly stReplaceNode: Statement;
  private readonly stSelectById: Statement;
  private readonly stSelectByGlm: Statement;
  private readonly stListByWorkspace: Statement;
  private readonly stListByWorkspaceStratum: Statement;
  private readonly stDeleteNode: Statement;

  private readonly stInsertParam: Statement;
  private readonly stDeleteParams: Statement;
  private readonly stSelectParams: Statement;

  private readonly stInsertConstraint: Statement;
  private readonly stDeleteConstraints: Statement;
  private readonly stSelectConstraints: Statement;

  private readonly stInsertRel: Statement;
  private readonly stDeleteRels: Statement;
  private readonly stSelectRels: Statement;

  constructor(db: Database) {
    this.db = db;
    this.stInsertNode = db.prepare(NODE_INSERT_SQL);
    this.stReplaceNode = db.prepare(NODE_REPLACE_SQL);
    this.stSelectById = db.prepare(NODE_SELECT_BY_ID_SQL);
    this.stSelectByGlm = db.prepare(NODE_SELECT_BY_GLM_SQL);
    this.stListByWorkspace = db.prepare(NODE_LIST_BY_WS_SQL);
    this.stListByWorkspaceStratum = db.prepare(NODE_LIST_BY_WS_STRATUM_SQL);
    this.stDeleteNode = db.prepare('DELETE FROM nodes WHERE id = ?');

    this.stInsertParam = db.prepare(PARAM_INSERT_SQL);
    this.stDeleteParams = db.prepare('DELETE FROM node_parameters WHERE node_id = ?');
    this.stSelectParams = db.prepare(
      'SELECT node_id, name, type, options_json, min_value, max_value, default_json, binding_scope, ord FROM node_parameters WHERE node_id = ? ORDER BY ord ASC',
    );

    this.stInsertConstraint = db.prepare(CONSTRAINT_INSERT_SQL);
    this.stDeleteConstraints = db.prepare('DELETE FROM node_constraints WHERE node_id = ?');
    this.stSelectConstraints = db.prepare(
      'SELECT node_id, ord, kind, expression, severity FROM node_constraints WHERE node_id = ? ORDER BY ord ASC',
    );

    this.stInsertRel = db.prepare(REL_INSERT_SQL);
    this.stDeleteRels = db.prepare('DELETE FROM node_relationships WHERE source_node_id = ?');
    this.stSelectRels = db.prepare(
      'SELECT source_node_id, ord, kind, target_glm_id, attributes_json FROM node_relationships WHERE source_node_id = ? ORDER BY ord ASC',
    );
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  /** Insert a brand-new node + children. Throws if (workspace_id, glm_id) collides. */
  insert(input: NodeInput): SekkeiNode {
    const now = new Date().toISOString();
    const hash = contentHash(input.body);
    const node: SekkeiNode = {
      id: input.id,
      workspaceId: input.workspaceId,
      glmId: input.glmId,
      stratum: input.stratum,
      title: input.title,
      description: input.description ?? '',
      body: input.body as SekkeiNode['body'],
      contentHash: hash,
      revisionMajor: input.revisionMajor,
      revisionIteration: input.revisionIteration,
      revisionStatus: input.revisionStatus,
      overrideKind: input.overrideKind,
      derivesFromNodeId: input.derivesFromNodeId ?? null,
      systemRole: input.systemRole ?? null,
      specKind: input.specKind ?? null,
      authoredBy: input.authoredBy,
      authoredAt: input.authoredAt ?? now,
      updatedAt: input.updatedAt ?? now,
      generatorIdentity: input.generatorIdentity ?? null,
    };

    const tx = this.db.transaction(() => {
      this.stInsertNode.run(...nodeBindings(node));
      this.writeChildren(node.id, input);
    });
    tx();
    return node;
  }

  /**
   * Replace an existing node (body + children) in a single transaction. The
   * `content_hash` is recomputed; `updated_at` is bumped unless the caller
   * supplied an explicit value.
   */
  update(input: NodeInput): SekkeiNode {
    const existing = this.findById(input.id);
    if (!existing) {
      throw new Error(`node ${input.id} does not exist`);
    }
    const hash = contentHash(input.body);
    const node: SekkeiNode = {
      ...existing.node,
      glmId: input.glmId,
      stratum: input.stratum,
      title: input.title,
      description: input.description ?? '',
      body: input.body as SekkeiNode['body'],
      contentHash: hash,
      revisionMajor: input.revisionMajor,
      revisionIteration: input.revisionIteration,
      revisionStatus: input.revisionStatus,
      overrideKind: input.overrideKind,
      derivesFromNodeId: input.derivesFromNodeId ?? null,
      systemRole: input.systemRole ?? null,
      specKind: input.specKind ?? null,
      authoredBy: input.authoredBy,
      authoredAt: input.authoredAt ?? existing.node.authoredAt,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
      generatorIdentity: input.generatorIdentity ?? null,
    };

    const tx = this.db.transaction(() => {
      this.stReplaceNode.run(...nodeBindings(node));
      this.stDeleteParams.run(node.id);
      this.stDeleteConstraints.run(node.id);
      this.stDeleteRels.run(node.id);
      this.writeChildren(node.id, input);
    });
    tx();
    return node;
  }

  /** Delete a node and all its child rows (FKs cascade). */
  delete(id: string): boolean {
    const r = this.stDeleteNode.run(id);
    return r.changes > 0;
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /** Find a node + children by surrogate id. Verifies `content_hash`. */
  findById(id: string): NodeWithChildren | null {
    const row = this.stSelectById.get(id) as NodeRow | undefined;
    if (!row) return null;
    return this.hydrate(row);
  }

  /** Find by (workspace, glm_id). Verifies `content_hash`. */
  findByGlmId(workspaceId: string, glmId: string): NodeWithChildren | null {
    const row = this.stSelectByGlm.get(workspaceId, glmId) as NodeRow | undefined;
    if (!row) return null;
    return this.hydrate(row);
  }

  /** All nodes in a workspace, ordered by stratum then glm_id. Verifies hashes. */
  listByWorkspace(workspaceId: string): NodeWithChildren[] {
    const rows = this.stListByWorkspace.all(workspaceId) as NodeRow[];
    return rows.map((r) => this.hydrate(r));
  }

  /** All nodes in a workspace at a single stratum. Verifies hashes. */
  listByWorkspaceStratum(workspaceId: string, stratum: Stratum): NodeWithChildren[] {
    const rows = this.stListByWorkspaceStratum.all(workspaceId, stratum) as NodeRow[];
    return rows.map((r) => this.hydrate(r));
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private writeChildren(nodeId: string, input: NodeInput): void {
    for (const p of input.parameters ?? []) {
      this.stInsertParam.run(
        nodeId,
        p.name,
        p.type,
        p.options === null ? null : JSON.stringify(p.options),
        p.minValue,
        p.maxValue,
        JSON.stringify(p.defaultValue),
        p.bindingScope,
        p.ord,
      );
    }
    for (const c of input.constraints ?? []) {
      this.stInsertConstraint.run(nodeId, c.ord, c.kind, c.expression, c.severity);
    }
    for (const r of input.relationships ?? []) {
      this.stInsertRel.run(
        nodeId,
        r.ord,
        r.kind,
        r.targetGlmId,
        r.attributes === null ? null : JSON.stringify(r.attributes),
      );
    }
  }

  private hydrate(row: NodeRow): NodeWithChildren {
    const body = JSON.parse(row.body_json) as unknown;
    if (!verifyContentHash(body, row.content_hash)) {
      const recomputed = contentHash(body);
      throw new ContentHashMismatchError(row.content_hash, recomputed);
    }
    const node: SekkeiNode = {
      id: row.id,
      workspaceId: row.workspace_id,
      glmId: row.glm_id,
      stratum: row.stratum as Stratum,
      title: row.title,
      description: row.description,
      body: body as SekkeiNode['body'],
      contentHash: row.content_hash,
      revisionMajor: row.revision_major,
      revisionIteration: row.revision_iteration,
      revisionStatus: row.revision_status as SekkeiNode['revisionStatus'],
      overrideKind: row.override_kind as SekkeiNode['overrideKind'],
      derivesFromNodeId: row.derives_from_node_id,
      systemRole: row.system_role,
      specKind: row.spec_kind,
      authoredBy: row.authored_by,
      authoredAt: row.authored_at,
      updatedAt: row.updated_at,
      generatorIdentity: row.generator_identity_json
        ? (JSON.parse(row.generator_identity_json) as SekkeiNode['generatorIdentity'])
        : null,
    };

    const parameters = (this.stSelectParams.all(row.id) as ParamRow[]).map(paramFromRow);
    const constraints = (this.stSelectConstraints.all(row.id) as ConstraintRow[]).map(constraintFromRow);
    const relationships = (this.stSelectRels.all(row.id) as RelRow[]).map(relFromRow);

    return { node, parameters, constraints, relationships };
  }
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const NODE_INSERT_SQL = `
  INSERT INTO nodes (
    id, workspace_id, glm_id, stratum, title, description, body_json, content_hash,
    revision_major, revision_iteration, revision_status, override_kind,
    derives_from_node_id, system_role, spec_kind,
    authored_by, authored_at, updated_at, generator_identity_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const NODE_REPLACE_SQL = `
  UPDATE nodes SET
    glm_id = ?3, stratum = ?4, title = ?5, description = ?6, body_json = ?7,
    content_hash = ?8, revision_major = ?9, revision_iteration = ?10,
    revision_status = ?11, override_kind = ?12, derives_from_node_id = ?13,
    system_role = ?14, spec_kind = ?15, authored_by = ?16,
    authored_at = ?17, updated_at = ?18, generator_identity_json = ?19
  WHERE id = ?1
`;

const NODE_SELECT_COLUMNS = `
  id, workspace_id, glm_id, stratum, title, description, body_json, content_hash,
  revision_major, revision_iteration, revision_status, override_kind,
  derives_from_node_id, system_role, spec_kind,
  authored_by, authored_at, updated_at, generator_identity_json
`;

const NODE_SELECT_BY_ID_SQL = `SELECT ${NODE_SELECT_COLUMNS} FROM nodes WHERE id = ?`;
const NODE_SELECT_BY_GLM_SQL = `SELECT ${NODE_SELECT_COLUMNS} FROM nodes WHERE workspace_id = ? AND glm_id = ?`;
const NODE_LIST_BY_WS_SQL = `SELECT ${NODE_SELECT_COLUMNS} FROM nodes WHERE workspace_id = ? ORDER BY stratum, glm_id`;
const NODE_LIST_BY_WS_STRATUM_SQL = `SELECT ${NODE_SELECT_COLUMNS} FROM nodes WHERE workspace_id = ? AND stratum = ? ORDER BY glm_id`;

const PARAM_INSERT_SQL = `
  INSERT INTO node_parameters (node_id, name, type, options_json, min_value, max_value, default_json, binding_scope, ord)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const CONSTRAINT_INSERT_SQL = `
  INSERT INTO node_constraints (node_id, ord, kind, expression, severity)
  VALUES (?, ?, ?, ?, ?)
`;

const REL_INSERT_SQL = `
  INSERT INTO node_relationships (source_node_id, ord, kind, target_glm_id, attributes_json)
  VALUES (?, ?, ?, ?, ?)
`;

// ---------------------------------------------------------------------------
// Row shapes (SQLite returns snake_case)
// ---------------------------------------------------------------------------

interface NodeRow {
  id: string;
  workspace_id: string;
  glm_id: string;
  stratum: string;
  title: string;
  description: string;
  body_json: string;
  content_hash: string;
  revision_major: string;
  revision_iteration: number;
  revision_status: string;
  override_kind: string;
  derives_from_node_id: string | null;
  system_role: string | null;
  spec_kind: string | null;
  authored_by: string;
  authored_at: string;
  updated_at: string;
  generator_identity_json: string | null;
}

interface ParamRow {
  node_id: string;
  name: string;
  type: string;
  options_json: string | null;
  min_value: number | null;
  max_value: number | null;
  default_json: string;
  binding_scope: string;
  ord: number;
}

interface ConstraintRow {
  node_id: string;
  ord: number;
  kind: string;
  expression: string;
  severity: string;
}

interface RelRow {
  source_node_id: string;
  ord: number;
  kind: string;
  target_glm_id: string;
  attributes_json: string | null;
}

function nodeBindings(n: SekkeiNode): readonly (string | number | null)[] {
  return [
    n.id,
    n.workspaceId,
    n.glmId,
    n.stratum,
    n.title,
    n.description,
    JSON.stringify(n.body),
    n.contentHash,
    n.revisionMajor,
    n.revisionIteration,
    n.revisionStatus,
    n.overrideKind,
    n.derivesFromNodeId,
    n.systemRole,
    n.specKind,
    n.authoredBy,
    n.authoredAt,
    n.updatedAt,
    n.generatorIdentity ? JSON.stringify(n.generatorIdentity) : null,
  ];
}

function paramFromRow(r: ParamRow): NodeParameter {
  return {
    nodeId: r.node_id,
    name: r.name,
    type: r.type as NodeParameter['type'],
    options: r.options_json ? (JSON.parse(r.options_json) as unknown[]) : null,
    minValue: r.min_value,
    maxValue: r.max_value,
    defaultValue: JSON.parse(r.default_json) as unknown,
    bindingScope: r.binding_scope as NodeParameter['bindingScope'],
    ord: r.ord,
  };
}

function constraintFromRow(r: ConstraintRow): NodeConstraint {
  return {
    nodeId: r.node_id,
    ord: r.ord,
    kind: r.kind as NodeConstraint['kind'],
    expression: r.expression,
    severity: r.severity as NodeConstraint['severity'],
  };
}

function relFromRow(r: RelRow): NodeRelationship {
  return {
    sourceNodeId: r.source_node_id,
    ord: r.ord,
    kind: r.kind as NodeRelationship['kind'],
    targetGlmId: r.target_glm_id,
    attributes: r.attributes_json ? (JSON.parse(r.attributes_json) as Record<string, unknown>) : null,
  };
}
