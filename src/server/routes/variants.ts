import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { resolve, type ResolverNode } from '../../domain/variant.ts';
import { publishVariant } from '../../git/sekkei-git-service.ts';
import type { GeneratorIdentity, VariantRolloutState } from '../../types.ts';
import type { LockNode } from '../../git/sekkei-lock.ts';
import { requirePrincipal, type AppEnv } from '../middleware/auth.ts';
import { httpError } from '../middleware/error.ts';

const ROLLOUT_ORDER: VariantRolloutState[] = [
  'Released',
  'Available-on-Channel',
  'Pinned-by-Variant',
  'Generated-for-Instance',
  'Deployed-to-dBOM',
];

export function variantRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // GET /workspaces/:id/variants
  app.get('/workspaces/:id/variants', (c) => {
    requirePrincipal(c);
    const workspaceId = c.req.param('id');
    requireWorkspace(c, workspaceId);
    return c.json({ variants: c.var.repos.variants.listVariants(workspaceId) });
  });

  // POST /workspaces/:id/variants/:variant_id/resolve
  app.post('/workspaces/:id/variants/:variant_id/resolve', async (c) => {
    requirePrincipal(c);
    const workspaceId = c.req.param('id');
    requireWorkspace(c, workspaceId);
    const variantId = c.req.param('variant_id');
    const variant = c.var.repos.variants.findVariant(variantId);
    if (!variant || variant.workspaceId !== workspaceId) {
      throw httpError(404, `variant ${variantId} not found`);
    }

    const body = (await c.req.json()) as {
      rootGlmId?: string;
      binding?: Record<string, unknown>;
      generatorIdentity?: GeneratorIdentity;
    };
    if (!body.rootGlmId) throw httpError(400, 'rootGlmId is required');
    if (!body.generatorIdentity) throw httpError(400, 'generatorIdentity is required');

    const nodes: ResolverNode[] = c.var.repos.nodes.listByWorkspace(workspaceId);
    const result = resolve({
      rootGlmId: body.rootGlmId,
      nodes,
      externalDeps: [], // Phase 5 will load from external_deps
      binding: body.binding ?? {},
      generatorIdentity: body.generatorIdentity,
    });
    return c.json({ result });
  });

  // POST /workspaces/:id/variants/:variant_id/publish
  // Git Step 4: resolve the variant from the current DB state and write
  // sekkei.lock on a `variants/<label>` branch via a git worktree.
  app.post('/workspaces/:id/variants/:variant_id/publish', async (c) => {
    const principal = requirePrincipal(c);
    const workspaceId = c.req.param('id');
    requireWorkspace(c, workspaceId);
    const variantId = c.req.param('variant_id');
    const variant = c.var.repos.variants.findVariant(variantId);
    if (!variant || variant.workspaceId !== workspaceId) {
      throw httpError(404, `variant ${variantId} not found`);
    }

    const git = c.var.deps.getSekkeiGit(workspaceId);
    if (!git) throw httpError(409, 'workspace has no git remote attached');

    const body = (await c.req.json()) as {
      rootGlmId?: string;
      binding?: Record<string, unknown>;
      generatorIdentity?: GeneratorIdentity;
    };
    if (!body.rootGlmId) throw httpError(400, 'rootGlmId is required');
    if (!body.generatorIdentity) throw httpError(400, 'generatorIdentity is required');

    // Re-resolve from current DB state to ensure the lock reflects live node data.
    const nodes: ResolverNode[] = c.var.repos.nodes.listByWorkspace(workspaceId);
    const resolution = resolve({
      rootGlmId: body.rootGlmId,
      nodes,
      externalDeps: [],
      binding: body.binding ?? {},
      generatorIdentity: body.generatorIdentity,
    });
    if (!resolution.overall.passed) {
      throw httpError(409, `variant resolution failed at step ${resolution.overall.failedAtStep}`);
    }

    const lockNodes: LockNode[] = resolution.closure.map((rn) => ({
      id: rn.node.glmId,
      major: rn.node.revisionMajor,
      content_hash: rn.node.contentHash,
    }));

    const result = await publishVariant(c.var.repos, {
      git,
      variant,
      lock: {
        rootGlmId: body.rootGlmId,
        binding: resolution.resolvedBinding,
        nodes: lockNodes,
        generatorIdentity: body.generatorIdentity,
      },
    });

    c.var.repos.audit.append({
      id: randomUUID(),
      workspaceId,
      userId: principal.user.id,
      eventType: 'variant.published',
      payload: { variantId, commit: result.gitCommit, closureHash: result.closureHash },
    });
    c.var.deps.events.publish(workspaceId, {
      type: 'variant.published',
      payload: { variantId, ...result },
      ts: c.var.deps.clock().toISOString(),
    });
    return c.json({ variant: c.var.repos.variants.findVariant(variantId), publish: result }, 201);
  });

  // GET /workspaces/:id/variants/:variant_id/rollout
  app.get('/workspaces/:id/variants/:variant_id/rollout', (c) => {
    requirePrincipal(c);
    const workspaceId = c.req.param('id');
    requireWorkspace(c, workspaceId);
    const variantId = c.req.param('variant_id');
    const variant = c.var.repos.variants.findVariant(variantId);
    if (!variant || variant.workspaceId !== workspaceId) {
      throw httpError(404, `variant ${variantId} not found`);
    }
    return c.json({ rollout: c.var.repos.variants.listRollout(variantId) });
  });

  // POST /workspaces/:id/variants
  app.post('/workspaces/:id/variants', async (c) => {
    requirePrincipal(c);
    const workspaceId = c.req.param('id');
    requireWorkspace(c, workspaceId);
    const body = (await c.req.json()) as {
      id?: string;
      label?: string;
      instance?: string;
      channel?: 'canary' | 'stable' | 'experimental';
      pinPolicyDefault?: 'pin-on-release' | 'track-latest' | 'frozen';
    };
    if (!body.label) throw httpError(400, 'label is required');
    if (!body.channel) throw httpError(400, 'channel is required');
    if (!body.pinPolicyDefault) throw httpError(400, 'pinPolicyDefault is required');
    const variant = c.var.repos.variants.insertVariant({
      id: body.id ?? randomUUID(),
      workspaceId,
      label: body.label,
      instance: body.instance,
      channel: body.channel,
      pinPolicyDefault: body.pinPolicyDefault,
    });
    return c.json({ variant }, 201);
  });

  // PUT /workspaces/:id/variants/:variant_id/rollout/:node_id/advance
  // AC-20 / AC-21: advance the node's rollout state and emit a rollout.advance audit event.
  app.put(
    '/workspaces/:id/variants/:variant_id/rollout/:node_id/advance',
    async (c) => {
      const principal = requirePrincipal(c);
      const workspaceId = c.req.param('id');
      requireWorkspace(c, workspaceId);
      const variantId = c.req.param('variant_id');
      const variant = c.var.repos.variants.findVariant(variantId);
      if (!variant || variant.workspaceId !== workspaceId) {
        throw httpError(404, `variant ${variantId} not found`);
      }
      const nodeId = c.req.param('node_id');
      const rollouts = c.var.repos.variants.listRollout(variantId);
      const existing = rollouts.find((r) => r.nodeId === nodeId);
      if (!existing) throw httpError(404, `rollout for node ${nodeId} not in variant ${variantId}`);

      // AC-20: refuse to advance when the pin already matches available.
      if (existing.pinRev && existing.pinRev === existing.availableRev) {
        throw httpError(409, 'pinned_rev already equals available_rev', {
          pinRev: existing.pinRev,
          availableRev: existing.availableRev,
        });
      }

      const currentIndex = ROLLOUT_ORDER.indexOf(existing.state);
      if (currentIndex < 0 || currentIndex >= ROLLOUT_ORDER.length - 1) {
        throw httpError(409, `rollout state '${existing.state}' has no successor`);
      }
      const next = ROLLOUT_ORDER[currentIndex + 1] as VariantRolloutState;
      const updated = c.var.repos.variants.upsertRollout({
        variantId,
        nodeId,
        availableRev: existing.availableRev,
        pinRev: existing.pinRev,
        state: next,
      });

      c.var.repos.audit.append({
        id: randomUUID(),
        workspaceId,
        userId: principal.user.id,
        eventType: 'rollout.advance',
        payload: { variantId, nodeId, from: existing.state, to: next },
      });
      return c.json({ rollout: updated });
    },
  );

  // PUT /workspaces/:id/variants/:variant_id/rollout/:node_id/pin-policy
  // AC-19: persist per-node pin policy overrides (writes a marker entry into
  // the rollout row's pin_rev field — pin_rev=null means "no override").
  app.put(
    '/workspaces/:id/variants/:variant_id/rollout/:node_id/pin-policy',
    async (c) => {
      const principal = requirePrincipal(c);
      const workspaceId = c.req.param('id');
      requireWorkspace(c, workspaceId);
      const variantId = c.req.param('variant_id');
      const variant = c.var.repos.variants.findVariant(variantId);
      if (!variant || variant.workspaceId !== workspaceId) {
        throw httpError(404, `variant ${variantId} not found`);
      }
      const nodeId = c.req.param('node_id');
      const rollouts = c.var.repos.variants.listRollout(variantId);
      const existing = rollouts.find((r) => r.nodeId === nodeId);
      if (!existing) throw httpError(404, 'rollout entry not found');
      const body = (await c.req.json()) as { pinRev?: string | null };
      const updated = c.var.repos.variants.upsertRollout({
        variantId,
        nodeId,
        availableRev: existing.availableRev,
        pinRev: body.pinRev ?? null,
        state: existing.state,
      });
      c.var.repos.audit.append({
        id: randomUUID(),
        workspaceId,
        userId: principal.user.id,
        eventType: 'rollout.pin_policy',
        payload: { variantId, nodeId, pinRev: body.pinRev ?? null },
      });
      return c.json({ rollout: updated });
    },
  );

  return app;
}

function requireWorkspace(c: { var: AppEnv['Variables'] }, workspaceId: string): void {
  const ws = c.var.repos.workspaces.findById(workspaceId);
  if (!ws) throw httpError(404, `workspace ${workspaceId} not found`);
}
