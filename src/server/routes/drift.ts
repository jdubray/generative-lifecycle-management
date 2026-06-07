import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { classify } from '../../domain/drift.ts';
import { runDriftSweep } from '../../git/sekkei-git-service.ts';
import type { DriftStatus } from '../../types.ts';
import { requirePrincipal, type AppEnv } from '../middleware/auth.ts';
import { httpError } from '../middleware/error.ts';
import { requireWorkspace } from './_workspace.ts';

export function driftRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // GET /workspaces/:id/drift
  app.get('/workspaces/:id/drift', (c) => {
    requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;
    const status = c.req.query('status') as DriftStatus | undefined;
    if (status) {
      return c.json({ drift: c.var.repos.drift.listByStatus(workspaceId, status) });
    }
    const all: DriftStatus[] = ['Synced', 'Hash-Drifted', 'Live-Drifted', 'Suspended'];
    return c.json({
      drift: all.flatMap((s) => c.var.repos.drift.listByStatus(workspaceId, s)),
    });
  });

  // POST /workspaces/:id/drift/sweep
  app.post('/workspaces/:id/drift/sweep', async (c) => {
    const principal = requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;

    const realizationGit = c.var.deps.getRealizationGit(workspaceId);
    if (realizationGit) {
      // Git Step 6: compare actual file hashes from the realization clone.
      const ws = c.var.repos.workspaces.findById(workspaceId)!;
      const result = await runDriftSweep(
        { drift: c.var.repos.drift },
        {
          workspaceId,
          sekkeiCommit: ws.gitCommit ?? '',
          realizationGit,
        },
      );
      c.var.repos.audit.append({
        id: randomUUID(),
        workspaceId,
        userId: principal.user.id,
        eventType: 'drift.sweep',
        payload: { detected: result.detected, autoResolved: result.autoResolved, gitBased: true },
      });
      return c.json(result);
    }

    // Fallback: re-classify existing records against stored hashes only.
    const all: DriftStatus[] = ['Synced', 'Hash-Drifted', 'Live-Drifted', 'Suspended'];
    const existing = all.flatMap((s) => c.var.repos.drift.listByStatus(workspaceId, s));
    let updated = 0;
    for (const r of existing) {
      const cls = classify({
        desiredHash: r.desiredHash ?? 'sha256:',
        observedHash: r.observedHash,
        kind: r.kind,
        policy: r.policy,
        suspended: r.status === 'Suspended',
      });
      if (cls.status !== r.status) {
        c.var.repos.drift.upsert({ ...r, status: cls.status });
        updated++;
      }
    }
    c.var.repos.audit.append({
      id: randomUUID(),
      workspaceId,
      userId: principal.user.id,
      eventType: 'drift.sweep',
      payload: { recordsConsidered: existing.length, recordsUpdated: updated },
    });
    return c.json({ recordsConsidered: existing.length, recordsUpdated: updated });
  });

  // PUT /workspaces/:id/drift/:record_id/resolve
  app.put('/workspaces/:id/drift/:record_id/resolve', async (c) => {
    const principal = requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;
    const id = c.req.param('record_id');
    const existing = c.var.repos.drift.findById(id);
    if (!existing || existing.workspaceId !== workspaceId) {
      throw httpError(404, `drift record ${id} not found`);
    }
    const body = (await c.req.json()) as {
      action?: 'heal' | 'suspend' | 'waiver' | 'scr';
      /** AC-26: waiver requires a duration in days. */
      durationDays?: number;
    };
    if (!body.action) throw httpError(400, 'action is required');

    // AC-26: waiver MUST carry a positive integer duration in days.
    if (body.action === 'waiver') {
      if (typeof body.durationDays !== 'number' || !Number.isFinite(body.durationDays) || body.durationDays <= 0) {
        throw httpError(400, 'waiver requires a positive durationDays', { ac: 'AC-26' });
      }
    }

    let newStatus: DriftStatus = existing.status;
    switch (body.action) {
      case 'heal':
        newStatus = 'Synced';
        break;
      case 'suspend':
      case 'waiver':
        newStatus = 'Suspended';
        break;
      case 'scr':
        // record stays as-is until the SCR is approved
        break;
    }
    const updated = c.var.repos.drift.upsert({ ...existing, status: newStatus });

    const auditPayload: Record<string, unknown> = {
      driftId: id,
      action: body.action,
      status: newStatus,
    };
    if (body.action === 'waiver') auditPayload.durationDays = body.durationDays;

    c.var.repos.audit.append({
      id: randomUUID(),
      workspaceId,
      userId: principal.user.id,
      eventType: body.action === 'waiver' ? 'drift.waiver' : 'drift.resolve',
      payload: auditPayload,
    });
    c.var.deps.events.publish(workspaceId, {
      type: 'drift.resolved',
      payload: { driftId: id, action: body.action },
      ts: c.var.deps.clock().toISOString(),
    });
    return c.json({ drift: updated });
  });

  // POST /workspaces/:id/drift/auto-heal — AC-24
  // Reconciles every Live-Drifted record whose policy is `auto-heal`.
  app.post('/workspaces/:id/drift/auto-heal', (c) => {
    const principal = requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;
    const all: DriftStatus[] = ['Hash-Drifted', 'Live-Drifted'];
    const candidates = all
      .flatMap((s) => c.var.repos.drift.listByStatus(workspaceId, s))
      .filter((r) => r.policy === 'auto-heal');
    const healed = candidates.map((r) =>
      c.var.repos.drift.upsert({ ...r, status: 'Synced' }),
    );
    c.var.repos.audit.append({
      id: randomUUID(),
      workspaceId,
      userId: principal.user.id,
      eventType: 'drift.bulk_heal',
      payload: { candidates: candidates.length, healed: healed.length },
    });
    return c.json({ healed: healed.length, candidates: candidates.length });
  });

  return app;
}
