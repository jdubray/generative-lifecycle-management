import { Hono } from 'hono';
import { isAbsolute } from 'node:path';
import { runSoloGenerate, SoloGenerateError } from '../../generation/solo-generate.ts';
import { type AppEnv, requirePrincipal } from '../middleware/auth.ts';
import { httpError } from '../middleware/error.ts';
import { requireWorkspace } from './_workspace.ts';

/**
 * Solo-mode generation endpoint (docs/solo-mode-spec.md UC-02).
 *
 * POST /api/v1/workspaces/:id/solo-generate
 *
 * Body:
 *   {
 *     "component_id": "acme:web.shop.catalog.product_repository",
 *     "source_dir":   "/abs/path/to/code",   // optional; persisted on workspace
 *     "dry_run":      false                  // optional
 *   }
 *
 * Response 200:
 *   { result: SoloGenerateResult }
 *
 * Errors:
 *   404  workspace or component not found
 *   409  no source_dir configured (and none provided in request)
 *   422  verifier failed, invalid spec, or Claude returned malformed output
 *   502  Claude CLI exited non-zero
 *   503  Claude CLI not on PATH
 *
 * Distinct path from the queue-based `/generate` route in
 * src/server/routes/generation.ts — solo mode is synchronous and never
 * goes through the queue.
 */
export function soloGenerateRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/workspaces/:id/solo-generate', async (c) => {
    const principal = requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;

    const body = (await c.req.json().catch(() => ({}))) as {
      component_id?: string;
      source_dir?: string;
      dry_run?: boolean;
    };
    const componentGlmId = (body.component_id ?? '').trim();
    if (!componentGlmId) throw httpError(400, 'component_id is required');

    if (body.source_dir !== undefined) {
      const sd = body.source_dir.trim();
      if (sd.length === 0) throw httpError(400, 'source_dir must be a non-empty string');
      if (!isAbsolute(sd)) throw httpError(400, `source_dir must be absolute (got '${sd}')`);
      c.var.repos.workspaces.setSourceDir(workspaceId, sd);
    }

    let result;
    try {
      result = await runSoloGenerate(
        {
          repos: {
            nodes: c.var.repos.nodes,
            workspaces: c.var.repos.workspaces,
            provenance: c.var.repos.provenance,
            audit: c.var.repos.audit,
          },
          clock: c.var.deps.clock,
          userId: principal.user.id,
        },
        {
          workspaceId,
          componentGlmId,
          dryRun: body.dry_run ?? false,
        },
      );
    } catch (err) {
      if (err instanceof SoloGenerateError) {
        throw httpError(err.status, err.message);
      }
      throw err;
    }

    c.var.deps.events.publish(workspaceId, {
      type: 'generation.complete',
      payload: {
        kind: 'solo-generate',
        componentGlmId,
        filesWritten: result.filesWritten.length,
        provenanceId: result.provenance?.id ?? null,
      },
      ts: c.var.deps.clock().toISOString(),
    });

    return c.json({ result });
  });

  return app;
}
