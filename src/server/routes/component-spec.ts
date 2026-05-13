import { Hono } from 'hono';
import { ComponentSpecError, resolveComponentSpec } from '../../generation/component-spec.ts';
import { requirePrincipal, type AppEnv } from '../middleware/auth.ts';
import { httpError } from '../middleware/error.ts';

/**
 * Composite endpoint that returns everything an MCP-driven Claude Code
 * session needs to regenerate a component: the component node, its
 * `spec.prompt` and `spec.acceptance` children, the resolved context bundle,
 * the outputs list, the hard-constraints suffix, and the workspace's
 * source_dir.
 *
 * In the legacy `solo-generate` flow this work happened server-side just
 * before spawning Claude. With MCP the LLM runs in the user's Claude Code
 * session, so the server's job is to package up the resolved spec and let
 * the client orchestrate generation.
 */
export function componentSpecRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // GET /workspaces/:id/components/:glm_id/spec
  app.get('/workspaces/:id/components/:glm_id/spec', (c) => {
    requirePrincipal(c);
    const workspaceId = c.req.param('id');
    const componentGlmId = c.req.param('glm_id');
    try {
      const spec = resolveComponentSpec(
        { nodes: c.var.repos.nodes, workspaces: c.var.repos.workspaces },
        workspaceId,
        componentGlmId,
      );
      return c.json({ spec });
    } catch (err) {
      if (err instanceof ComponentSpecError) {
        throw httpError(err.status, err.message);
      }
      throw err;
    }
  });

  return app;
}
