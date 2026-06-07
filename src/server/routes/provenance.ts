import { Hono } from 'hono';
import {
  type DsseEnvelope,
  rekorUrl,
  verifyDsseEnvelope,
} from '../../generation/attestation.ts';
import { requirePrincipal, type AppEnv } from '../middleware/auth.ts';
import { httpError } from '../middleware/error.ts';
import { requireWorkspace } from './_workspace.ts';

export function provenanceRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // GET /workspaces/:id/provenance
  app.get('/workspaces/:id/provenance', (c) => {
    requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;
    const limit = clampLimit(c.req.query('limit'), 100);
    return c.json({ events: c.var.repos.provenance.listByWorkspace(workspaceId, limit) });
  });

  // GET /workspaces/:id/provenance/:event_id
  app.get('/workspaces/:id/provenance/:event_id', (c) => {
    requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;
    const id = c.req.param('event_id');
    const event = c.var.repos.provenance.findById(id);
    if (!event || event.workspaceId !== workspaceId) {
      throw httpError(404, `provenance ${id} not found`);
    }
    const attestation = c.var.repos.attestations.findByEvent(id);
    return c.json({
      event,
      attestation: attestation
        ? {
            id: attestation.id,
            keyId: attestation.keyId,
            statement: JSON.parse(attestation.statementJson),
            envelope: JSON.parse(attestation.dsseJson),
            rekorEntryId: attestation.rekorEntryId,
            rekorUrl: attestation.rekorEntryId ? rekorUrl(attestation.rekorEntryId) : null,
          }
        : null,
    });
  });

  // POST /workspaces/:id/provenance/export
  // AC-34: returns newline-delimited DSSE envelope JSON for the filtered set.
  app.post('/workspaces/:id/provenance/export', (c) => {
    requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;
    const rows = c.var.repos.attestations.listByWorkspace(workspaceId, 10_000);
    const ndjson = rows.map((r) => r.dsseJson).join('\n');
    return new Response(ndjson, {
      status: 200,
      headers: {
        'content-type': 'application/vnd.in-toto+json',
        'content-disposition': `attachment; filename="glm-${workspaceId}-dsse.ndjson"`,
      },
    });
  });

  // POST /workspaces/:id/provenance/verify
  // AC-35: re-verifies every signature server-side and returns a pass/fail report.
  app.post('/workspaces/:id/provenance/verify', (c) => {
    requirePrincipal(c);
    const workspaceId = requireWorkspace(c, c.req.param('id')).id;
    const rows = c.var.repos.attestations.listByWorkspace(workspaceId, 10_000);
    const report = rows.map((r) => {
      const envelope = JSON.parse(r.dsseJson) as DsseEnvelope;
      const result = verifyDsseEnvelope(envelope, c.var.deps.attestationSigner);
      return {
        attestationId: r.id,
        provenanceEventId: r.provenanceEventId,
        passed: result.passed,
        signatures: result.signatures,
      };
    });
    const passedCount = report.filter((r) => r.passed).length;
    return c.json({
      total: report.length,
      passed: passedCount,
      failed: report.length - passedCount,
      report,
    });
  });

  return app;
}

/** Bound a caller-supplied `limit` so a hostile client can't pull arbitrary memory. */
function clampLimit(raw: string | undefined, fallback: number, max = 1000): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}
