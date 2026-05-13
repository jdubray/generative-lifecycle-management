import { Hono } from 'hono';
import { runAcceptanceVerifier } from '../../generation/acceptance-runner.ts';
import { ComponentSpecError, resolveComponentSpec } from '../../generation/component-spec.ts';
import { requirePrincipal, type AppEnv } from '../middleware/auth.ts';
import { httpError } from '../middleware/error.ts';

/**
 * Acceptance-verifier endpoint for the MCP-driven generation flow.
 *
 * Claude Code, after writing the files generated for a component, calls
 * `glm_run_acceptance_verifier` which hits this route. The server:
 *   1. Resolves the component's `spec.acceptance.verifier.command` from
 *      the workspace's sekkei (so the command is sekkei-authoritative,
 *      not caller-supplied — no arbitrary code execution).
 *   2. Runs it via the platform shell with cwd = workspace.source_dir.
 *   3. Returns `{ command, cwd, exitCode, stdout, stderr, durationMs }`.
 *
 * The verifier runs a shell (bash/sh/cmd), not `claude.exe`, so this path
 * has none of the Windows handle-inheritance hang issues that bit
 * server-side LLM generation.
 */
export function acceptanceVerifyRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/workspaces/:id/acceptance-verify', async (c) => {
    requirePrincipal(c);
    const workspaceId = c.req.param('id');

    const body = (await c.req.json().catch(() => ({}))) as { componentId?: unknown };
    const componentId = typeof body.componentId === 'string' ? body.componentId : '';
    if (!componentId) {
      throw httpError(400, 'componentId is required');
    }

    let spec;
    try {
      spec = resolveComponentSpec(
        { nodes: c.var.repos.nodes, workspaces: c.var.repos.workspaces },
        workspaceId,
        componentId,
      );
    } catch (err) {
      if (err instanceof ComponentSpecError) throw httpError(err.status, err.message);
      throw err;
    }

    if (!spec.sourceDir) {
      throw httpError(
        409,
        `workspace has no source_dir; set one via PATCH /workspaces/${workspaceId} or 'glm init --source-dir'`,
      );
    }

    const started = Date.now();
    const result = await runAcceptanceVerifier({ command: spec.verifierCommand, cwd: spec.sourceDir });
    const durationMs = Date.now() - started;

    return c.json({
      result: {
        command: spec.verifierCommand,
        cwd: spec.sourceDir,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs,
      },
    });
  });

  return app;
}
