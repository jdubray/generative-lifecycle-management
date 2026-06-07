import type { Workspace } from '../../types.ts';
import type { AppEnv } from '../middleware/auth.ts';
import { httpError } from '../middleware/error.ts';

/**
 * Resolve a `:id` path param to the workspace it names, accepting **either**
 * a UUID or a slug, or throw 404. Returns the full workspace row so callers
 * read `.id` (the canonical UUID) and thread *that* — never the raw param —
 * into downstream workspace-id-keyed repo calls.
 *
 * This centralizes what used to be a per-module `requireWorkspace` helper that
 * called `workspaces.findById` only (UUID-only). That inconsistency meant a
 * slug worked on the `workspaces.ts` routes (which resolve slug-or-UUID) but
 * 404'd on every other route module — breaking the MCP tools and CLI whenever
 * a slug was passed. See the regression test in
 * tests/integration/server/workspace-slug.test.ts.
 */
export function requireWorkspace(
  c: { var: AppEnv['Variables'] },
  idOrSlug: string,
): Workspace {
  const ws =
    c.var.repos.workspaces.findById(idOrSlug) ?? c.var.repos.workspaces.findBySlug(idOrSlug);
  if (!ws) throw httpError(404, `workspace ${idOrSlug} not found`);
  return ws;
}
