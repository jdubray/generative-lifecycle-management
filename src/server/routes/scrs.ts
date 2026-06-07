import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { apply, nextStatus, type ScrEvent } from '../../domain/scr.ts';
import { commitScrImplementation } from '../../git/sekkei-git-service.ts';
import type { ScrInsert } from '../../repository/scr-repository.ts';
import type { ScrApprovalDecision } from '../../types.ts';
import { requirePrincipal, type AppEnv } from '../middleware/auth.ts';
import { httpError } from '../middleware/error.ts';
import { requireWorkspace } from './_workspace.ts';

export function scrRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // GET /workspaces/:id/scrs
  app.get('/workspaces/:id/scrs', (c) => {
    requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;
    const status = c.req.query('status');
    if (status) {
      return c.json({
        scrs: c.var.repos.scrs.listByStatus(workspaceId, status as Parameters<typeof c.var.repos.scrs.listByStatus>[1]),
      });
    }
    // Fall back to listing all statuses for the demo.
    const allStatuses = ['Draft', 'Submitted', 'Under Review', 'Approved', 'Returned', 'Rejected', 'Implemented', 'Released'] as const;
    const scrs = allStatuses.flatMap((s) => c.var.repos.scrs.listByStatus(workspaceId, s));
    return c.json({ scrs });
  });

  // POST /workspaces/:id/scrs
  app.post('/workspaces/:id/scrs', async (c) => {
    const principal = requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;

    const body = (await c.req.json()) as Partial<ScrInsert>;
    if (!body.title) throw httpError(400, 'title is required');
    if (!body.problem) throw httpError(400, 'problem is required');
    if (!body.scrClass || (body.scrClass !== 'I' && body.scrClass !== 'II')) {
      throw httpError(400, 'scrClass must be "I" or "II"');
    }

    const scr = c.var.repos.scrs.insert({
      id: body.id ?? `SCR-${shortId()}`,
      workspaceId,
      title: body.title,
      scrClass: body.scrClass,
      status: 'Draft',
      proposer: body.proposer ?? principal.user.email,
      problem: body.problem,
      diffYaml: body.diffYaml ?? [],
      targetNodes: body.targetNodes ?? [],
      effectivity: body.effectivity ?? null,
      impact: body.impact ?? null,
    });

    c.var.repos.audit.append({
      id: randomUUID(),
      workspaceId,
      userId: principal.user.id,
      eventType: 'scr.create',
      payload: { scrId: scr.id, scrClass: scr.scrClass },
    });
    c.var.deps.events.publish(workspaceId, {
      type: 'scr.created',
      payload: scr,
      ts: c.var.deps.clock().toISOString(),
    });
    return c.json({ scr }, 201);
  });

  // GET /workspaces/:id/scrs/:scr_id
  app.get('/workspaces/:id/scrs/:scr_id', (c) => {
    requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;
    const scrId = c.req.param('scr_id');
    const scr = c.var.repos.scrs.findById(scrId);
    if (!scr || scr.workspaceId !== workspaceId) throw httpError(404, `scr ${scrId} not found`);
    return c.json({ scr, approvals: c.var.repos.scrs.listApprovals(scrId) });
  });

  // PUT /workspaces/:id/scrs/:scr_id/status
  app.put('/workspaces/:id/scrs/:scr_id/status', async (c) => {
    const principal = requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;
    const scrId = c.req.param('scr_id');
    const scr = c.var.repos.scrs.findById(scrId);
    if (!scr || scr.workspaceId !== workspaceId) throw httpError(404, `scr ${scrId} not found`);

    const body = (await c.req.json()) as { event?: ScrEvent['type']; reason?: string };
    if (!body.event) throw httpError(400, 'event is required');
    const event = mkEvent(body.event, body.reason);

    const newStatus = nextStatus(scr.status, event); // throws InvalidScrTransitionError → 409
    const reason = event.type === 'return' ? event.reason : null;
    c.var.repos.scrs.setStatus(scrId, newStatus, reason);

    const updated = apply(scr, event);

    // On `implement`, write the YAML files + create an ECN commit if a
    // git client is configured for this workspace (spec §9.5).
    let commitInfo: { hash: string; shortHash: string } | undefined;
    if (event.type === 'implement') {
      const git = c.var.deps.getSekkeiGit(workspaceId);
      if (git) {
        const result = await commitScrImplementation(c.var.repos, principal.user, {
          git,
          scr: updated,
          signedOffBy: principal.user.email,
        });
        commitInfo = result.commit;
        c.var.repos.scrs.setGitInfo(scrId, {
          gitCommit: result.commit.hash,
          gitBranch: result.branchName,
        });
        c.var.repos.audit.append({
          id: randomUUID(),
          workspaceId,
          userId: principal.user.id,
          eventType: 'scr.committed',
          payload: { scrId, commit: result.commit.hash, branch: result.branchName, files: result.writtenFiles.length },
        });
      }
    }

    c.var.repos.audit.append({
      id: randomUUID(),
      workspaceId,
      userId: principal.user.id,
      eventType: auditEventForScrEvent(event.type),
      payload: { scrId, from: scr.status, to: newStatus, reason: reason ?? undefined },
    });
    c.var.deps.events.publish(workspaceId, {
      type: 'scr.status_changed',
      payload: { scrId, from: scr.status, to: newStatus, by: principal.user.id, commit: commitInfo?.hash },
      ts: c.var.deps.clock().toISOString(),
    });
    return c.json({ scr: updated, commit: commitInfo });
  });

  // POST /workspaces/:id/scrs/:scr_id/approvals
  app.post('/workspaces/:id/scrs/:scr_id/approvals', async (c) => {
    const principal = requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;
    const scrId = c.req.param('scr_id');
    const scr = c.var.repos.scrs.findById(scrId);
    if (!scr || scr.workspaceId !== workspaceId) throw httpError(404, `scr ${scrId} not found`);

    const body = (await c.req.json()) as { decision?: ScrApprovalDecision; who?: string };
    if (!body.decision) throw httpError(400, 'decision is required');

    const decidedAt = c.var.deps.clock().toISOString();
    const approval = c.var.repos.scrs.upsertApproval({
      scrId,
      who: body.who ?? principal.user.email,
      decision: body.decision,
      decidedAt,
    });

    // Per AC-08: an `approve` decision drives the SCR status to Approved
    // (the SCR must currently be Under Review). The repository keeps the
    // approval record; the FSM enforces the legal transition.
    let updatedScr = scr;
    if (body.decision === 'approve' && scr.status === 'Under Review') {
      const event: ScrEvent = { type: 'approve' };
      const newStatus = nextStatus(scr.status, event);
      c.var.repos.scrs.setStatus(scrId, newStatus, null);
      updatedScr = apply(scr, event);
      c.var.deps.events.publish(workspaceId, {
        type: 'scr.status_changed',
        payload: { scrId, from: scr.status, to: newStatus, by: principal.user.id },
        ts: decidedAt,
      });
    }

    c.var.repos.audit.append({
      id: randomUUID(),
      workspaceId,
      userId: principal.user.id,
      eventType: 'scr.approval',
      payload: { scrId, decision: body.decision, who: approval.who },
    });
    c.var.deps.events.publish(workspaceId, {
      type: 'scr.approval_added',
      payload: approval,
      ts: decidedAt,
    });
    return c.json({ scr: updatedScr, approval }, 201);
  });

  return app;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function shortId(): string {
  return Math.floor(Math.random() * 10000).toString().padStart(4, '0');
}


function mkEvent(type: ScrEvent['type'], reason?: string): ScrEvent {
  switch (type) {
    case 'return':
      if (!reason) throw httpError(400, 'reason is required for return');
      return { type: 'return', reason };
    case 'submit':
    case 'startReview':
    case 'approve':
    case 'reject':
    case 'reopen':
    case 'implement':
    case 'release':
      return { type };
    default:
      throw httpError(400, `unknown event '${type}'`);
  }
}

function auditEventForScrEvent(type: ScrEvent['type']): string {
  // AC-07: `submit` produces `scr.submit`.
  return `scr.${type === 'startReview' ? 'start_review' : type}`;
}
