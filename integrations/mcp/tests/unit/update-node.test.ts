import { describe, expect, test } from 'bun:test';
import type { ResolvedConfig } from '../../src/lib/config.ts';
import type { GlmClient } from '../../src/lib/glm-client.ts';
import { runUpdateNode } from '../../src/tools/update-node.ts';

const CONFIG: ResolvedConfig = {
  port: 3300,
  workspace: 'demo',
  token: 'tok',
  baseUrl: 'http://localhost:3300',
};

interface Seen {
  ws: string;
  glmId: string;
  patch: Record<string, unknown>;
}

function fakeClient(
  capture: (seen: Seen) => void,
  opts: { locks?: string[]; releases?: string[]; failUpdate?: boolean } = {},
): GlmClient {
  return {
    acquireLock: async (_ws: string, glmId: string) => {
      opts.locks?.push(glmId);
      return { nodeId: 'n1', heldBy: 'alice', heartbeatAt: '', expiresAt: '' };
    },
    releaseLock: async (_ws: string, glmId: string) => {
      opts.releases?.push(glmId);
    },
    updateNode: async (ws: string, glmId: string, patch: Record<string, unknown>) => {
      capture({ ws, glmId, patch });
      if (opts.failUpdate) throw new Error('boom');
      return {
        id: 'n1',
        glmId: (patch.glmId as string) ?? glmId,
        stratum: (patch.stratum as string) ?? 'component',
        title: (patch.title as string) ?? 'T',
        description: '',
        revisionStatus: 'in_work',
        body: patch.body ?? {},
        contentHash: 'sha256:abc',
        revisionMajor: 'A',
        revisionIteration: 1,
      };
    },
  } as unknown as GlmClient;
}

describe('glm_update_node tool', () => {
  test('sends only the fields that were supplied', async () => {
    let seen: Seen | undefined;
    await runUpdateNode(
      { workspace: 'myapp', glm_id: 'acme:app.shop', title: 'Shopping' },
      {
        client: fakeClient((s) => {
          seen = s;
        }),
        config: CONFIG,
      },
    );

    expect(seen?.ws).toBe('myapp');
    expect(seen?.glmId).toBe('acme:app.shop');
    // Nothing else may ride along: an unsent `relationships` key is what tells
    // the server to keep the stored edges.
    expect(seen?.patch).toEqual({ title: 'Shopping' });
  });

  test('maps snake_case relationships and defaults ord to the array index', async () => {
    let seen: Seen | undefined;
    await runUpdateNode(
      {
        glm_id: 'acme:app.shop',
        relationships: [
          { kind: 'composes-of', target_glm_id: 'acme:app.shop.cart' },
          { kind: 'depends-on', target_glm_id: 'pkg:npm/zod@3', attributes: { why: 'validation' } },
        ],
      },
      {
        client: fakeClient((s) => {
          seen = s;
        }),
        config: CONFIG,
      },
    );

    expect(seen?.patch.relationships).toEqual([
      { kind: 'composes-of', targetGlmId: 'acme:app.shop.cart', ord: 0, attributes: null },
      {
        kind: 'depends-on',
        targetGlmId: 'pkg:npm/zod@3',
        ord: 1,
        attributes: { why: 'validation' },
      },
    ]);
  });

  test('an explicit empty relationships array is forwarded, not dropped', async () => {
    let seen: Seen | undefined;
    await runUpdateNode(
      { glm_id: 'acme:app.shop', relationships: [] },
      {
        client: fakeClient((s) => {
          seen = s;
        }),
        config: CONFIG,
      },
    );
    expect(seen?.patch.relationships).toEqual([]);
  });

  test('new_glm_id becomes glmId, and the lock is released under the new id', async () => {
    const locks: string[] = [];
    const releases: string[] = [];
    let seen: Seen | undefined;
    const result = await runUpdateNode(
      {
        glm_id: 'acme:app.cart.checkout.spec.functional',
        new_glm_id: 'acme:app.cart.spec.functional',
      },
      {
        client: fakeClient(
          (s) => {
            seen = s;
          },
          { locks, releases },
        ),
        config: CONFIG,
      },
    );

    expect(seen?.patch.glmId).toBe('acme:app.cart.spec.functional');
    expect(locks).toEqual(['acme:app.cart.checkout.spec.functional']);
    // Releasing under the old id would 404 and strand the lock until expiry.
    expect(releases).toEqual(['acme:app.cart.spec.functional']);
    expect(result.content[0]?.text).toContain('renamed from');
  });

  test('the lock is released even when the update fails', async () => {
    const releases: string[] = [];
    await expect(
      runUpdateNode(
        { glm_id: 'acme:app.shop', title: 'x' },
        { client: fakeClient(() => {}, { releases, failUpdate: true }), config: CONFIG },
      ),
    ).rejects.toThrow('boom');
    expect(releases).toEqual(['acme:app.shop']);
  });

  test('falls back to config.workspace when omitted', async () => {
    let seen: Seen | undefined;
    await runUpdateNode(
      { glm_id: 'acme:app', title: 'App' },
      {
        client: fakeClient((s) => {
          seen = s;
        }),
        config: CONFIG,
      },
    );
    expect(seen?.ws).toBe('demo');
  });
});
