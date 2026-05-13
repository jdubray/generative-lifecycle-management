import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { aggregateDigest, ComponentSpecError, resolveComponentSpec } from '../../generation/component-spec.ts';
import { requirePrincipal, type AppEnv } from '../middleware/auth.ts';
import { httpError } from '../middleware/error.ts';

/**
 * Provenance + audit recording endpoint for the MCP-driven generation flow.
 *
 * Claude Code drives generation locally (writes files via its built-in Write
 * tool, then runs the acceptance verifier via glm_run_acceptance_verifier).
 * Once that's green it calls `glm_record_generation`, which POSTs here so
 * the server can attest the outcome the same way the legacy server-driven
 * `solo-generate` flow did — inserts one provenance_events row + one
 * audit_events row.
 *
 * The sekkei content hashes (sekkeiRev, generatorPromptVersion) are resolved
 * server-side at recording time. The bindingHash is supplied by the client
 * because it represents the snapshot of context-bundle inputs that were
 * actually fed to the LLM (which may pre-date this call). The per-file
 * sha256s are also client-supplied — the server doesn't see the generated
 * files, only their hashes.
 */
export function recordGenerationRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/workspaces/:id/record-generation', async (c) => {
    const principal = requirePrincipal(c);
    const workspaceId = c.req.param('id');

    const body = (await c.req.json().catch(() => ({}))) as {
      componentId?: unknown;
      files?: unknown;
      verifierExitCode?: unknown;
      bindingHash?: unknown;
      generatorIdentity?: unknown;
      durationMs?: unknown;
      note?: unknown;
    };
    const componentId = typeof body.componentId === 'string' ? body.componentId : '';
    if (!componentId) throw httpError(400, 'componentId is required');
    const files = parseFiles(body.files);
    if (files.length === 0) throw httpError(400, 'files must be a non-empty array of {path, sha256, bytes}');
    const verifierExitCode =
      typeof body.verifierExitCode === 'number' && Number.isInteger(body.verifierExitCode)
        ? body.verifierExitCode
        : null;
    if (verifierExitCode === null) throw httpError(400, 'verifierExitCode must be an integer');

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

    const bindingHash = typeof body.bindingHash === 'string' && body.bindingHash.length > 0
      ? body.bindingHash
      : spec.contextBundle.bindingHash;
    const generatorIdentity =
      typeof body.generatorIdentity === 'string' && body.generatorIdentity.length > 0
        ? body.generatorIdentity
        : 'claude-code/mcp';
    const durationMs =
      typeof body.durationMs === 'number' && Number.isFinite(body.durationMs) && body.durationMs >= 0
        ? Math.round(body.durationMs)
        : 0;
    const note = typeof body.note === 'string' ? body.note : null;

    const provenance = c.var.repos.provenance.insert({
      id: randomUUID(),
      workspaceId,
      occurredAt: c.var.deps.clock().toISOString(),
      subjectFile: files.map((f) => f.path).join(','),
      subjectDigest: aggregateDigest(files),
      sekkeiRoot: componentId,
      sekkeiRev: spec.component.contentHash,
      sekkeiLock: '',
      bindingHash,
      generatorLlm: generatorIdentity,
      generatorPromptVersion: spec.specPrompt.contentHash,
      durationMs,
      cache: 'miss',
      signed: false,
      note,
    });

    c.var.repos.audit.append({
      id: randomUUID(),
      workspaceId,
      userId: principal.user.id,
      eventType: 'mcp.generate',
      payload: {
        componentId,
        filesWritten: files.length,
        verifierExitCode,
        provenanceId: provenance.id,
      },
    });

    return c.json({ provenance });
  });

  return app;
}

function parseFiles(raw: unknown): Array<{ path: string; sha256: string; bytes: number }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return [];
    const o = item as Record<string, unknown>;
    if (typeof o.path !== 'string' || o.path.length === 0) return [];
    if (typeof o.sha256 !== 'string' || !o.sha256.startsWith('sha256:')) return [];
    if (typeof o.bytes !== 'number' || !Number.isFinite(o.bytes) || o.bytes < 0) return [];
    out.push({ path: o.path, sha256: o.sha256, bytes: Math.round(o.bytes) });
  }
  return out;
}
