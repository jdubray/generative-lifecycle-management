import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { whereUsed } from '../../domain/relationships.ts';
import { assertValidBody } from '../../domain/node.ts';
import type { NodeInput } from '../../repository/node-repository.ts';
import type { SekkeiNode, Stratum } from '../../types.ts';
import { requirePrincipal, type AppEnv } from '../middleware/auth.ts';
import { httpError } from '../middleware/error.ts';
import { requireWorkspace } from './_workspace.ts';

const STRATA: Stratum[] = ['system', 'capability', 'component', 'interaction', 'spec'];

export function nodeRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // GET /workspaces/:id/nodes
  app.get('/workspaces/:id/nodes', (c) => {
    requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;
    const stratum = c.req.query('stratum') as Stratum | undefined;
    const status = c.req.query('status');
    // `include=relationships` returns each node's outbound edges (kind + targetGlmId)
    // so the browser can build a composes-of hierarchy without N round-trips.
    const include = (c.req.query('include') ?? '').split(',').map((s) => s.trim());
    const wantRels = include.includes('relationships');
    const nodes = stratum
      ? c.var.repos.nodes.listByWorkspaceStratum(workspaceId, validateStratum(stratum))
      : c.var.repos.nodes.listByWorkspace(workspaceId);
    const filtered = status
      ? nodes.filter((n) => n.node.revisionStatus === status)
      : nodes;
    return c.json({
      nodes: filtered.map((n) =>
        wantRels
          ? {
              ...n.node,
              relationships: n.relationships.map((r) => ({ kind: r.kind, targetGlmId: r.targetGlmId })),
            }
          : n.node,
      ),
    });
  });

  // GET /workspaces/:id/nodes/:glm_id
  app.get('/workspaces/:id/nodes/:glm_id', (c) => {
    requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;
    const glmId = c.req.param('glm_id');    const found = c.var.repos.nodes.findByGlmId(workspaceId, glmId);
    if (!found) throw httpError(404, `node ${glmId} not found in workspace ${workspaceId}`);
    return c.json(found);
  });

  // POST /workspaces/:id/nodes
  app.post('/workspaces/:id/nodes', async (c) => {
    const principal = requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;
    const body = (await c.req.json()) as Partial<NodeInput>;
    const id = body.id ?? randomUUID();
    const input = await buildNodeInput(body, { workspaceId, principalEmail: principal.user.email, defaultId: id });
    assertValidBody(input.stratum, input.body);

    const node = c.var.repos.nodes.insert(input);
    c.var.repos.changeLog.append({
      workspaceId,
      nodeId: node.id,
      userId: principal.user.id,
      op: 'create',
      afterContentHash: node.contentHash,
    });
    c.var.repos.audit.append({
      id: randomUUID(),
      workspaceId,
      userId: principal.user.id,
      eventType: 'node.create',
      payload: { glmId: node.glmId, contentHash: node.contentHash },
    });
    c.var.deps.events.publish(workspaceId, {
      type: 'node.changed',
      payload: { op: 'create', node },
      ts: c.var.deps.clock().toISOString(),
    });
    return c.json({ node }, 201);
  });

  // PUT /workspaces/:id/nodes/:glm_id
  app.put('/workspaces/:id/nodes/:glm_id', async (c) => {
    const principal = requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;
    const glmId = c.req.param('glm_id');
    const existing = c.var.repos.nodes.findByGlmId(workspaceId, glmId);
    if (!existing) throw httpError(404, `node ${glmId} not found`);
    requireLockHolder(c, existing.node.id, principal.user.id);

    const body = (await c.req.json()) as Partial<NodeInput>;
    const input = await buildNodeInput(body, {
      workspaceId,
      principalEmail: principal.user.email,
      defaultId: existing.node.id,
      defaultGlmId: existing.node.glmId,
      defaultStratum: existing.node.stratum,
      defaults: existing.node,
    });
    assertValidBody(input.stratum, input.body);

    const updated = c.var.repos.nodes.update(input);
    c.var.repos.changeLog.append({
      workspaceId,
      nodeId: updated.id,
      userId: principal.user.id,
      op: 'update',
      beforeContentHash: existing.node.contentHash,
      afterContentHash: updated.contentHash,
    });
    c.var.repos.audit.append({
      id: randomUUID(),
      workspaceId,
      userId: principal.user.id,
      eventType: 'node.update',
      payload: { glmId: updated.glmId, contentHash: updated.contentHash },
    });
    c.var.deps.events.publish(workspaceId, {
      type: 'node.changed',
      payload: { op: 'update', node: updated },
      ts: c.var.deps.clock().toISOString(),
    });
    return c.json({ node: updated });
  });

  // DELETE /workspaces/:id/nodes/:glm_id  → soft-delete (status = obsolete)
  app.delete('/workspaces/:id/nodes/:glm_id', (c) => {
    const principal = requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;
    const glmId = c.req.param('glm_id');
    const existing = c.var.repos.nodes.findByGlmId(workspaceId, glmId);
    if (!existing) throw httpError(404, `node ${glmId} not found`);

    const updated = c.var.repos.nodes.update({
      ...nodeToInput(existing.node),
      revisionStatus: 'obsolete',
      authoredBy: principal.user.email,
    });
    c.var.repos.changeLog.append({
      workspaceId,
      nodeId: updated.id,
      userId: principal.user.id,
      op: 'delete',
      beforeContentHash: existing.node.contentHash,
      afterContentHash: updated.contentHash,
    });
    c.var.repos.audit.append({
      id: randomUUID(),
      workspaceId,
      userId: principal.user.id,
      eventType: 'node.delete',
      payload: { glmId: updated.glmId },
    });
    return c.json({ node: updated });
  });

  // GET /workspaces/:id/nodes/:glm_id/where-used
  app.get('/workspaces/:id/nodes/:glm_id/where-used', (c) => {
    requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;
    const glmId = c.req.param('glm_id');    const all = c.var.repos.nodes.listByWorkspace(workspaceId);
    const result = whereUsed(
      glmId,
      all.map((n) => ({ node: n.node, relationships: n.relationships })),
    );
    return c.json(result);
  });

  // POST /workspaces/:id/nodes/:glm_id/lock
  app.post('/workspaces/:id/nodes/:glm_id/lock', (c) => {
    const principal = requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;
    const glmId = c.req.param('glm_id');    const node = c.var.repos.nodes.findByGlmId(workspaceId, glmId);
    if (!node) throw httpError(404, `node ${glmId} not found`);

    const { granted, lock } = c.var.repos.locks.acquire(
      node.node.id,
      principal.user.id,
      c.var.deps.lockTtlMs,
      c.var.deps.clock(),
    );
    if (!granted) {
      return c.json(
        { error: { code: 'locked', heldBy: lock.userId, heartbeatAt: lock.heartbeatAt } },
        423,
      );
    }
    c.var.deps.events.publish(workspaceId, {
      type: 'node.locked',
      payload: lock,
      ts: c.var.deps.clock().toISOString(),
    });
    return c.json({ lock }, 200);
  });

  // PUT /workspaces/:id/nodes/:glm_id/lock/heartbeat
  app.put('/workspaces/:id/nodes/:glm_id/lock/heartbeat', (c) => {
    const principal = requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;
    const glmId = c.req.param('glm_id');    const node = c.var.repos.nodes.findByGlmId(workspaceId, glmId);
    if (!node) throw httpError(404, `node ${glmId} not found`);

    const ok = c.var.repos.locks.heartbeat(node.node.id, principal.user.id, c.var.deps.clock());
    if (!ok) throw httpError(409, 'caller does not hold the lock');
    const lock = c.var.repos.locks.find(node.node.id);
    return c.json({ lock });
  });

  // DELETE /workspaces/:id/nodes/:glm_id/lock
  app.delete('/workspaces/:id/nodes/:glm_id/lock', (c) => {
    const principal = requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;
    const glmId = c.req.param('glm_id');    const node = c.var.repos.nodes.findByGlmId(workspaceId, glmId);
    if (!node) throw httpError(404, `node ${glmId} not found`);

    const released = c.var.repos.locks.release(node.node.id, principal.user.id);
    if (released) {
      c.var.deps.events.publish(workspaceId, {
        type: 'node.unlocked',
        payload: { nodeId: node.node.id, userId: principal.user.id },
        ts: c.var.deps.clock().toISOString(),
      });
    }
    return c.json({ released });
  });

  return app;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function validateStratum(s: string): Stratum {
  if (!STRATA.includes(s as Stratum)) throw httpError(400, `unknown stratum '${s}'`);
  return s as Stratum;
}

function requireLockHolder(c: { var: AppEnv['Variables'] }, nodeId: string, userId: string): void {
  const lock = c.var.repos.locks.find(nodeId);
  if (!lock) return; // no lock = anyone may write (Phase 7 may tighten this)
  if (lock.userId !== userId) {
    throw httpError(423, `node is locked by ${lock.userId}`, { heldBy: lock.userId });
  }
}

function nodeToInput(node: SekkeiNode): NodeInput {
  return {
    id: node.id,
    workspaceId: node.workspaceId,
    glmId: node.glmId,
    stratum: node.stratum,
    title: node.title,
    description: node.description,
    body: node.body,
    revisionMajor: node.revisionMajor,
    revisionIteration: node.revisionIteration,
    revisionStatus: node.revisionStatus,
    overrideKind: node.overrideKind,
    derivesFromNodeId: node.derivesFromNodeId,
    systemRole: node.systemRole,
    specKind: node.specKind,
    authoredBy: node.authoredBy,
    authoredAt: node.authoredAt,
    generatorIdentity: node.generatorIdentity,
  };
}

interface BuildOpts {
  workspaceId: string;
  principalEmail: string;
  defaultId: string;
  defaultGlmId?: string;
  defaultStratum?: Stratum;
  defaults?: SekkeiNode;
}

async function buildNodeInput(body: Partial<NodeInput>, opts: BuildOpts): Promise<NodeInput> {
  const stratum = body.stratum ?? opts.defaultStratum;
  if (!stratum) throw httpError(400, 'stratum is required');
  validateStratum(stratum);
  const glmId = body.glmId ?? opts.defaultGlmId;
  if (!glmId) throw httpError(400, 'glmId is required');

  return {
    id: body.id ?? opts.defaultId,
    workspaceId: opts.workspaceId,
    glmId,
    stratum,
    title: body.title ?? opts.defaults?.title ?? '',
    description: body.description ?? opts.defaults?.description ?? '',
    body: body.body ?? opts.defaults?.body,
    revisionMajor: body.revisionMajor ?? opts.defaults?.revisionMajor ?? 'A',
    revisionIteration: body.revisionIteration ?? opts.defaults?.revisionIteration ?? 0,
    revisionStatus: body.revisionStatus ?? opts.defaults?.revisionStatus ?? 'in_work',
    overrideKind: body.overrideKind ?? opts.defaults?.overrideKind ?? 'net_new',
    derivesFromNodeId: body.derivesFromNodeId ?? opts.defaults?.derivesFromNodeId ?? null,
    systemRole: body.systemRole ?? opts.defaults?.systemRole ?? null,
    specKind: body.specKind ?? opts.defaults?.specKind ?? null,
    authoredBy: body.authoredBy ?? opts.principalEmail,
    generatorIdentity: body.generatorIdentity ?? opts.defaults?.generatorIdentity ?? null,
  };
}
