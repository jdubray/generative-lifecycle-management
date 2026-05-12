import { Hono } from 'hono';
import { runWorkspaceVerifier } from '../../verifier/runner.ts';
import { type AppEnv, requirePrincipal } from '../middleware/auth.ts';
import { httpError } from '../middleware/error.ts';

export function verifierRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // POST /workspaces/:id/verify
  app.post('/workspaces/:id/verify', async (c) => {
    const principal = requirePrincipal(c);
    const workspaceId = c.req.param('id');
    requireWorkspace(c, workspaceId);
    const body = (await c.req.json().catch(() => ({}))) as {
      brief?: Array<{ glmId: string; stratum: 'system' | 'capability' | 'component' | 'interaction' | 'spec'; label?: string }>;
    };
    const run = await runWorkspaceVerifier(
      {
        repos: {
          nodes: c.var.repos.nodes,
          verificationRuns: c.var.repos.verificationRuns,
          audit: c.var.repos.audit,
        },
        events: c.var.deps.events,
        clock: c.var.deps.clock,
      },
      { workspaceId, userId: principal.user.id, brief: body.brief },
    );
    return c.json({ run });
  });

  // GET /workspaces/:id/verifier/runs
  app.get('/workspaces/:id/verifier/runs', (c) => {
    requirePrincipal(c);
    const workspaceId = c.req.param('id');
    requireWorkspace(c, workspaceId);
    const limit = clampLimit(c.req.query('limit'), 20);
    return c.json({ runs: c.var.repos.verificationRuns.listLatest(workspaceId, limit) });
  });

  // GET /workspaces/:id/verifier/runs/latest
  app.get('/workspaces/:id/verifier/runs/latest', (c) => {
    requirePrincipal(c);
    const workspaceId = c.req.param('id');
    requireWorkspace(c, workspaceId);
    const run = c.var.repos.verificationRuns.latest(workspaceId);
    return c.json({ run });
  });

  // GET /workspaces/:id/verifier/runs/:run_id
  app.get('/workspaces/:id/verifier/runs/:run_id', (c) => {
    requirePrincipal(c);
    const workspaceId = c.req.param('id');
    requireWorkspace(c, workspaceId);
    const run = c.var.repos.verificationRuns.findById(c.req.param('run_id'));
    if (!run || run.workspaceId !== workspaceId) throw httpError(404, 'run not found');
    return c.json({ run });
  });

  return app;
}

function requireWorkspace(c: { var: AppEnv['Variables'] }, workspaceId: string): void {
  const ws = c.var.repos.workspaces.findById(workspaceId);
  if (!ws) throw httpError(404, `workspace ${workspaceId} not found`);
}

/**
 * Parse + clamp a `limit` query param. NaN / negative / zero / huge values
 * collapse to the default. Cap at 1000 to bound memory usage.
 */
function clampLimit(raw: string | undefined, fallback: number, max = 1000): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}
