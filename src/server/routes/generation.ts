import { Hono } from 'hono';
import { runPipeline } from '../../generation/pipeline.ts';
import type { GeneratorIdentity, Sha256Hash } from '../../types.ts';
import { requirePrincipal, type AppEnv } from '../middleware/auth.ts';
import { httpError } from '../middleware/error.ts';
import { requireWorkspace } from './_workspace.ts';

/**
 * Generation pipeline endpoint (spec §7.1). Runs synchronously inside the
 * request for now — the in-process queue is available in deps but the
 * route awaits the pipeline result so the response can include the
 * provenance event id (AC-32).
 */
export function generationRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // POST /workspaces/:id/generate
  app.post('/workspaces/:id/generate', async (c) => {
    requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;

    if (!c.var.deps.llm) throw httpError(400, 'no LLM client configured on this server');
    if (!c.var.deps.generationCache) throw httpError(400, 'no generation cache configured');

    const body = (await c.req.json()) as {
      subjectFile?: string;
      prompt?: string;
      system?: string;
      contextBundle?: Array<{ name: string; content: string }>;
      sekkei?: { rootId: string; revision: string; lockDigest: Sha256Hash };
      binding?: Record<string, unknown>;
      closureHash?: Sha256Hash;
      generatorIdentity?: GeneratorIdentity;
    };
    if (!body.subjectFile) throw httpError(400, 'subjectFile is required');
    if (!body.prompt) throw httpError(400, 'prompt is required');
    if (!body.sekkei) throw httpError(400, 'sekkei context is required');
    if (!body.closureHash) throw httpError(400, 'closureHash is required');
    if (!body.generatorIdentity) throw httpError(400, 'generatorIdentity is required');

    const result = await runPipeline(
      {
        llm: c.var.deps.llm,
        cache: c.var.deps.generationCache,
        signer: c.var.deps.attestationSigner,
        repos: { provenance: c.var.repos.provenance, attestations: c.var.repos.attestations },
        clock: c.var.deps.clock,
      },
      {
        workspaceId,
        subjectFile: body.subjectFile,
        llmInput: { prompt: body.prompt, system: body.system, contextBundle: body.contextBundle },
        sekkei: body.sekkei,
        binding: body.binding ?? {},
        closureHash: body.closureHash,
        generatorIdentity: body.generatorIdentity,
      },
    );

    c.var.deps.events.publish(workspaceId, {
      type: 'generation.complete',
      payload: { provenanceId: result.provenance.id, cache: result.cache },
      ts: c.var.deps.clock().toISOString(),
    });

    return c.json(
      {
        provenance: result.provenance,
        attestationId: result.attestationId,
        cache: result.cache,
        artifactDigest: result.artifactDigest,
        rekorEntryId: result.rekorEntryId,
      },
      201,
    );
  });

  return app;
}
