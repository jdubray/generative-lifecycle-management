import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { whereUsed } from '../../domain/relationships.ts';
import type { ReuseStage } from '../../types.ts';
import { requirePrincipal, type AppEnv } from '../middleware/auth.ts';
import { httpError } from '../middleware/error.ts';

const STAGE_ORDER: ReuseStage[] = [
  'Variant-Local',
  'Candidate-for-Promotion',
  'Promoted-to-Library',
  'Stewarded-by-Owner',
];

export function reuseRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // GET /workspaces/:id/reuse
  app.get('/workspaces/:id/reuse', (c) => {
    requirePrincipal(c);
    const workspaceId = c.req.param('id');
    requireWorkspace(c, workspaceId);
    const stage = c.req.query('stage') as ReuseStage | undefined;
    return c.json({ candidates: c.var.repos.reuse.list(workspaceId, stage) });
  });

  // POST /workspaces/:id/reuse/find-candidates
  // AC-28: scan every node's where-used signal; nodes with ≥ 2 dependents
  // become Variant-Local candidates if not already tracked.
  app.post('/workspaces/:id/reuse/find-candidates', (c) => {
    const principal = requirePrincipal(c);
    const workspaceId = c.req.param('id');
    requireWorkspace(c, workspaceId);

    const allNodes = c.var.repos.nodes
      .listByWorkspace(workspaceId)
      .map((n) => ({ node: n.node, relationships: n.relationships }));
    const existing = c.var.repos.reuse.list(workspaceId);
    const existingSubtrees = new Set(existing.map((r) => r.subtree));

    const created = [];
    for (const { node } of allNodes) {
      const where = whereUsed(node.glmId, allNodes);
      if (where.direct.length >= 2 && !existingSubtrees.has(node.glmId)) {
        const candidate = c.var.repos.reuse.insert({
          id: randomUUID(),
          workspaceId,
          subtree: node.glmId,
          title: node.title || node.glmId,
          stage: 'Variant-Local',
          rationale: `Used by ${where.direct.length} adopters at the time of scan`,
          usages: where.direct.length,
          invariantsHeldIn: where.direct.length,
        });
        created.push(candidate);
      }
    }

    c.var.repos.audit.append({
      id: randomUUID(),
      workspaceId,
      userId: principal.user.id,
      eventType: 'reuse.scan',
      payload: { scanned: allNodes.length, created: created.length },
    });
    return c.json({ created, considered: allNodes.length });
  });

  // POST /workspaces/:id/reuse
  app.post('/workspaces/:id/reuse', async (c) => {
    requirePrincipal(c);
    const workspaceId = c.req.param('id');
    requireWorkspace(c, workspaceId);
    const body = (await c.req.json()) as {
      id?: string;
      subtree?: string;
      title?: string;
      stage?: ReuseStage;
      rationale?: string;
      steward?: string;
    };
    if (!body.subtree) throw httpError(400, 'subtree is required');
    if (!body.title) throw httpError(400, 'title is required');
    if (!body.stage) throw httpError(400, 'stage is required');
    const created = c.var.repos.reuse.insert({
      id: body.id ?? randomUUID(),
      workspaceId,
      subtree: body.subtree,
      title: body.title,
      stage: body.stage,
      rationale: body.rationale,
      steward: body.steward ?? null,
    });
    return c.json({ candidate: created }, 201);
  });

  // PUT /workspaces/:id/reuse/:id/stage
  // AC-30: refuse to advance past Candidate-for-Promotion without a steward.
  app.put('/workspaces/:id/reuse/:rid/stage', async (c) => {
    const principal = requirePrincipal(c);
    const workspaceId = c.req.param('id');
    requireWorkspace(c, workspaceId);
    const rid = c.req.param('rid');
    const candidate = c.var.repos.reuse.findById(rid);
    if (!candidate || candidate.workspaceId !== workspaceId) {
      throw httpError(404, `candidate ${rid} not found`);
    }
    const body = (await c.req.json()) as { stage?: ReuseStage; steward?: string };
    if (!body.stage) throw httpError(400, 'stage is required');

    const currentIndex = STAGE_ORDER.indexOf(candidate.stage);
    const nextIndex = STAGE_ORDER.indexOf(body.stage);
    if (nextIndex < 0) throw httpError(400, `unknown stage '${body.stage}'`);
    if (nextIndex !== currentIndex + 1 && nextIndex !== currentIndex) {
      throw httpError(409, `cannot jump from ${candidate.stage} to ${body.stage}`);
    }
    if (
      body.stage === 'Promoted-to-Library' &&
      !(body.steward ?? candidate.steward)
    ) {
      throw httpError(422, 'a steward is required to promote past Candidate-for-Promotion', {
        ac: 'AC-30',
      });
    }
    const updated = c.var.repos.reuse.update(rid, {
      stage: body.stage,
      steward: body.steward ?? candidate.steward,
    });
    c.var.repos.audit.append({
      id: randomUUID(),
      workspaceId,
      userId: principal.user.id,
      eventType: 'reuse.stage',
      payload: { id: rid, from: candidate.stage, to: body.stage },
    });
    return c.json({ candidate: updated });
  });

  // PUT /workspaces/:id/reuse/:id/steward
  app.put('/workspaces/:id/reuse/:rid/steward', async (c) => {
    requirePrincipal(c);
    const workspaceId = c.req.param('id');
    requireWorkspace(c, workspaceId);
    const rid = c.req.param('rid');
    const candidate = c.var.repos.reuse.findById(rid);
    if (!candidate || candidate.workspaceId !== workspaceId) {
      throw httpError(404, `candidate ${rid} not found`);
    }
    const body = (await c.req.json()) as { steward?: string | null };
    const updated = c.var.repos.reuse.update(rid, { steward: body.steward ?? null });
    return c.json({ candidate: updated });
  });

  return app;
}

function requireWorkspace(c: { var: AppEnv['Variables'] }, workspaceId: string): void {
  const ws = c.var.repos.workspaces.findById(workspaceId);
  if (!ws) throw httpError(404, `workspace ${workspaceId} not found`);
}
