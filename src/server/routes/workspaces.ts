import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { type AppEnv, requirePrincipal } from '../middleware/auth.ts';
import { httpError } from '../middleware/error.ts';
import { attachRemote, syncFromRemote } from '../../git/sekkei-git-service.ts';
import type {
  DriftStatus,
  ScrStatus,
  Stratum,
} from '../../types.ts';

const SCR_STATUSES: ScrStatus[] = [
  'Draft',
  'Submitted',
  'Under Review',
  'Approved',
  'Returned',
  'Rejected',
  'Implemented',
  'Released',
];

const DRIFT_STATUSES: DriftStatus[] = ['Synced', 'Hash-Drifted', 'Live-Drifted', 'Suspended'];

const STRATA: Stratum[] = ['system', 'capability', 'component', 'interaction', 'spec'];

/**
 * Workspace metadata endpoints used by the PWA shell. Kept separate from the
 * domain-specific routes (nodes / scrs / etc.) so the frontend has a single
 * place to fetch "everything the topbar + dashboard need" on boot.
 */
export function workspaceRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // GET /workspaces — list every workspace the caller belongs to (v1: all).
  app.get('/workspaces', (c) => {
    requirePrincipal(c);
    const all = c.var.deps.db
      .prepare('SELECT id, slug, name, created_at FROM workspaces ORDER BY name ASC')
      .all() as Array<{ id: string; slug: string; name: string; created_at: string }>;
    return c.json({
      workspaces: all.map((w) => ({ id: w.id, slug: w.slug, name: w.name, createdAt: w.created_at })),
    });
  });

  // POST /workspaces — create an empty workspace; caller becomes its owner.
  app.post('/workspaces', async (c) => {
    const principal = requirePrincipal(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      slug?: string;
      name?: string;
    };
    const slug = (body.slug ?? '').trim();
    const name = (body.name ?? slug).trim();
    if (!slug) throw httpError(400, 'slug is required');
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(slug)) {
      throw httpError(400, 'slug must match ^[a-z][a-z0-9-]{0,63}$');
    }
    if (c.var.repos.workspaces.findBySlug(slug)) {
      throw httpError(409, `workspace '${slug}' already exists`);
    }
    const workspace = c.var.repos.workspaces.insert({
      id: randomUUID(),
      slug,
      name: name || slug,
    });
    c.var.repos.workspaces.addMember({
      workspaceId: workspace.id,
      userId: principal.user.id,
      role: 'owner',
    });
    c.var.repos.audit.append({
      id: randomUUID(),
      workspaceId: workspace.id,
      userId: principal.user.id,
      eventType: 'workspace.create',
      payload: { slug: workspace.slug, name: workspace.name },
    });
    return c.json({ workspace }, 201);
  });

  // GET /workspaces/:id — single workspace record.
  app.get('/workspaces/:id', (c) => {
    requirePrincipal(c);
    const ws = c.var.repos.workspaces.findById(c.req.param('id'));
    if (!ws) throw httpError(404, `workspace ${c.req.param('id')} not found`);
    return c.json({ workspace: ws });
  });

  // POST /workspaces/:id/git-remote — attach a git remote (Git Step 1).
  app.post('/workspaces/:id/git-remote', async (c) => {
    requirePrincipal(c);
    const id = c.req.param('id');
    const ws = c.var.repos.workspaces.findById(id);
    if (!ws) throw httpError(404, `workspace ${id} not found`);
    if (ws.gitRemote) throw httpError(409, 'workspace already has a git remote; detach it first');

    const body = (await c.req.json().catch(() => ({}))) as {
      gitRemote?: string;
      gitRef?: string;
      gitForge?: string;
      gitAutoPush?: boolean;
    };
    const gitRemote = (body.gitRemote ?? '').trim();
    if (!gitRemote) throw httpError(400, 'gitRemote is required');

    const gitForge = body.gitForge === 'github' || body.gitForge === 'gitlab'
      ? body.gitForge
      : null;

    const result = attachRemote(
      { workspaces: c.var.repos.workspaces },
      {
        workspaceId: id,
        gitRemote,
        gitRef: body.gitRef?.trim() || undefined,
        gitForge,
        gitAutoPush: body.gitAutoPush ?? false,
      },
    );

    const updated = c.var.repos.workspaces.findById(id)!;
    return c.json({
      workspace: updated,
      gitCommit: result.gitCommit,
      gitCloneDir: result.gitCloneDir,
    }, 201);
  });

  // POST /workspaces/:id/git-sync — pull + reconcile (Git Step 2).
  app.post('/workspaces/:id/git-sync', (c) => {
    requirePrincipal(c);
    const id = c.req.param('id');
    const ws = c.var.repos.workspaces.findById(id);
    if (!ws) throw httpError(404, `workspace ${id} not found`);
    if (!ws.gitRemote || !ws.gitCloneDir || !ws.gitCommit) {
      throw httpError(409, 'workspace has no git remote attached');
    }

    const result = syncFromRemote(
      {
        workspaces: c.var.repos.workspaces,
        workspaceConflicts: c.var.repos.workspaceConflicts,
        nodes: c.var.repos.nodes,
        changeLog: c.var.repos.changeLog,
      },
      c.var.deps.events,
      {
        workspaceId: id,
        knownCommit: ws.gitCommit,
        gitCloneDir: ws.gitCloneDir,
      },
    );

    return c.json(result);
  });

  // GET /workspaces/:id/git-conflicts — list open divergence records.
  app.get('/workspaces/:id/git-conflicts', (c) => {
    requirePrincipal(c);
    const id = c.req.param('id');
    const ws = c.var.repos.workspaces.findById(id);
    if (!ws) throw httpError(404, `workspace ${id} not found`);
    return c.json({ conflicts: c.var.repos.workspaceConflicts.listOpen(id) });
  });

  // DELETE /workspaces/:id/git-remote — detach remote (workspace reverts to DB-only).
  app.delete('/workspaces/:id/git-remote', (c) => {
    requirePrincipal(c);
    const id = c.req.param('id');
    const ws = c.var.repos.workspaces.findById(id);
    if (!ws) throw httpError(404, `workspace ${id} not found`);
    if (!ws.gitRemote) throw httpError(409, 'workspace has no git remote attached');

    c.var.repos.workspaces.detachGit(id);
    return c.json({ ok: true });
  });

  // GET /workspaces/:id/summary — aggregated counts for the Dashboard view.
  app.get('/workspaces/:id/summary', (c) => {
    requirePrincipal(c);
    const id = c.req.param('id');
    const ws = c.var.repos.workspaces.findById(id);
    if (!ws) throw httpError(404, `workspace ${id} not found`);

    const nodesByStratum = Object.fromEntries(
      STRATA.map((s) => [s, c.var.repos.nodes.listByWorkspaceStratum(id, s).length]),
    ) as Record<Stratum, number>;
    const nodeTotal = Object.values(nodesByStratum).reduce((a, b) => a + b, 0);

    const scrsByStatus = Object.fromEntries(
      SCR_STATUSES.map((s) => [s, c.var.repos.scrs.listByStatus(id, s).length]),
    ) as Record<ScrStatus, number>;
    const scrActive =
      scrsByStatus.Submitted + scrsByStatus['Under Review'] + scrsByStatus.Approved;

    const driftByStatus = Object.fromEntries(
      DRIFT_STATUSES.map((s) => [s, c.var.repos.drift.listByStatus(id, s).length]),
    ) as Record<DriftStatus, number>;
    const driftTotal = driftByStatus['Hash-Drifted'] + driftByStatus['Live-Drifted'];

    const provs = c.var.repos.provenance.listByWorkspace(id, 200);
    const tokens = provs.reduce(
      (acc, p) => {
        acc.in += p.tokensIn;
        acc.out += p.tokensOut;
        if (p.cache === 'hit') acc.hits++;
        else acc.misses++;
        return acc;
      },
      { in: 0, out: 0, hits: 0, misses: 0 },
    );

    const activity = c.var.repos.changeLog.listLatest(id, 20);
    const lastVerifier = c.var.repos.verificationRuns.latest(id);

    return c.json({
      workspace: ws,
      nodes: { total: nodeTotal, byStratum: nodesByStratum },
      scrs: { active: scrActive, byStatus: scrsByStatus },
      drift: { drifted: driftTotal, byStatus: driftByStatus },
      generation: {
        eventsConsidered: provs.length,
        tokensIn: tokens.in,
        tokensOut: tokens.out,
        cacheHits: tokens.hits,
        cacheMisses: tokens.misses,
      },
      verifier: lastVerifier
        ? {
            id: lastVerifier.id,
            ts: lastVerifier.ts,
            overallPass: lastVerifier.overallPass,
          }
        : null,
      activity,
    });
  });

  return app;
}
