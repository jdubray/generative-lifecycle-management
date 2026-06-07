import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { createRelease, RELEASE_TAG_RE } from '../../git/sekkei-git-service.ts';
import { requirePrincipal, type AppEnv } from '../middleware/auth.ts';
import { httpError } from '../middleware/error.ts';
import { requireWorkspace } from './_workspace.ts';

export function releaseRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * POST /workspaces/:id/releases
   *
   * Body: { name: string, message: string }
   *
   * Creates a signed annotated release tag on the current HEAD and seeds
   * rollout_records for every variant node that changed since the prior tag.
   * Returns the tag name, HEAD commit, and the created rollout records.
   */
  app.post('/workspaces/:id/releases', async (c) => {
    const principal = requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;

    const git = c.var.deps.getSekkeiGit(workspaceId);
    if (!git) throw httpError(409, 'workspace has no git remote attached');

    const body = (await c.req.json()) as { name?: string; message?: string };
    if (!body.name) throw httpError(400, 'name is required');
    if (!RELEASE_TAG_RE.test(body.name)) {
      throw httpError(400, `invalid release name '${body.name}': must match /^[A-Z]\\.\\d+$/`);
    }
    if (!body.message) throw httpError(400, 'message is required');

    let result;
    try {
      result = await createRelease(c.var.repos, {
        workspaceId,
        git,
        name: body.name,
        message: body.message,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes('already exists')) {
        throw httpError(409, `release tag '${body.name}' already exists`);
      }
      throw err;
    }

    c.var.repos.audit.append({
      id: randomUUID(),
      workspaceId,
      userId: principal.user.id,
      eventType: 'release.created',
      payload: { tag: result.tag, commit: result.commit, rolloutCount: result.rolloutRecords.length },
    });
    c.var.deps.events.publish(workspaceId, {
      type: 'release.created',
      payload: { tag: result.tag, commit: result.commit },
      ts: c.var.deps.clock().toISOString(),
    });

    return c.json(result, 201);
  });

  /**
   * POST /workspaces/:id/rollout-records/:record_id/advance
   *
   * Body: { status: "advanced" | "blocked" }
   *
   * Advance a rollout record's status. Once set to `advanced` or `blocked`,
   * the status is terminal and cannot be changed back to `pending`.
   */
  app.post('/workspaces/:id/rollout-records/:record_id/advance', async (c) => {
    const principal = requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;

    const recordId = c.req.param('record_id');
    const record = c.var.repos.rollout.findById(recordId);
    if (!record) throw httpError(404, `rollout record ${recordId} not found`);

    // Verify the record belongs to this workspace via its variant.
    const variant = c.var.repos.variants.findVariant(record.variantId);
    if (!variant || variant.workspaceId !== workspaceId) {
      throw httpError(404, `rollout record ${recordId} not found`);
    }

    if (record.status !== 'pending') {
      throw httpError(409, `rollout record is already '${record.status}'`);
    }

    const body = (await c.req.json()) as { status?: string };
    if (!body.status || (body.status !== 'advanced' && body.status !== 'blocked')) {
      throw httpError(400, "status must be 'advanced' or 'blocked'");
    }

    const updated = c.var.repos.rollout.advance(recordId, body.status);
    if (!updated) throw httpError(500, 'failed to advance rollout record');

    c.var.repos.audit.append({
      id: randomUUID(),
      workspaceId,
      userId: principal.user.id,
      eventType: 'rollout_record.advanced',
      payload: { recordId, from: record.status, to: body.status, releaseTag: record.releaseTag },
    });

    return c.json({ rolloutRecord: updated });
  });

  return app;
}
