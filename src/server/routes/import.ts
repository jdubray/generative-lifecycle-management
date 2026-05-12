import { Hono } from 'hono';
import { runImport } from '../../import/importer.ts';
import { type AppEnv, requirePrincipal } from '../middleware/auth.ts';
import { httpError } from '../middleware/error.ts';

/**
 * POST /workspaces/import
 *
 *   body:
 *     {
 *       "name":      "GLM (self)",
 *       "slug":      "glm-self",
 *       "documents": [ { "filename": "sekkei.yaml", "content": "..." }, ... ],
 *       "dryRun":    false
 *     }
 *
 *   → 200 / 201 { "workspaceId", "summary": { inserted, updated, ... } }
 *
 * Authenticated; the caller becomes `owner` of the new (or existing)
 * workspace. Inline `documents` mode is the browser path — the PWA reads
 * each picked file with FileReader and sends it as `{ filename, content }`.
 * The CLI (`scripts/import-sekkei.ts`) uses the directory-mode source
 * directly via `runImport(...)` and never goes through this endpoint.
 */
export function importRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/workspaces/import', async (c) => {
    const principal = requirePrincipal(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      slug?: string;
      name?: string;
      documents?: Array<{ filename?: string; content?: string }>;
      dryRun?: boolean;
    };

    const slug = (body.slug ?? '').trim();
    const name = (body.name ?? '').trim();
    if (!slug) throw httpError(400, 'slug is required');
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(slug)) {
      throw httpError(400, 'slug must match ^[a-z][a-z0-9-]{0,63}$');
    }
    if (!body.documents || !Array.isArray(body.documents) || body.documents.length === 0) {
      throw httpError(400, 'documents[] is required (browse inline mode)');
    }
    const documents = body.documents
      .filter((d): d is { filename: string; content: string } => {
        return typeof d?.filename === 'string' && typeof d?.content === 'string';
      })
      .filter((d) => d.filename.endsWith('.yaml') || d.filename.endsWith('.yml'));
    if (documents.length === 0) {
      throw httpError(400, 'no .yaml / .yml documents in the request body');
    }

    let summary;
    try {
      summary = runImport(
        {
          db: c.var.deps.db,
          repos: {
            workspaces: c.var.repos.workspaces,
            users: c.var.repos.users,
            nodes: c.var.repos.nodes,
            audit: c.var.repos.audit,
          },
        },
        {
          source: { kind: 'inline', documents },
          workspace: { slug, name: name || slug },
          owner: { email: principal.user.email, displayName: principal.user.displayName },
          dryRun: body.dryRun ?? false,
        },
      );
    } catch (err) {
      throw httpError(422, (err as Error).message);
    }

    c.var.deps.events.publish(summary.workspace.id, {
      type: 'generation.complete', // reusing the existing event vocabulary for "workspace state changed"
      payload: {
        kind: 'workspace.imported',
        workspaceId: summary.workspace.id,
        inserted: summary.nodesInserted,
        updated: summary.nodesUpdated,
        unchanged: summary.nodesUnchanged,
      },
      ts: c.var.deps.clock().toISOString(),
    });

    return c.json(
      { workspaceId: summary.workspace.id, workspace: summary.workspace, summary },
      summary.dryRun || summary.nodesInserted === 0 ? 200 : 201,
    );
  });

  return app;
}
