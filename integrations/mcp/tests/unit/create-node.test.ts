import { describe, expect, test } from 'bun:test';
import { runCreateNode } from '../../src/tools/create-node.ts';
import type { CreateNodeInput, GlmClient } from '../../src/lib/glm-client.ts';
import type { ResolvedConfig } from '../../src/lib/config.ts';

const CONFIG: ResolvedConfig = {
  port: 3300,
  workspace: 'demo',
  token: 'tok',
  baseUrl: 'http://localhost:3300',
};

function fakeClient(capture: (ws: string, node: CreateNodeInput) => void): GlmClient {
  return {
    createNode: async (ws: string, node: CreateNodeInput) => {
      capture(ws, node);
      return {
        id: 'n1',
        glmId: node.glmId,
        stratum: node.stratum,
        title: node.title,
        description: node.description ?? '',
        revisionStatus: node.revisionStatus ?? 'in_work',
        body: node.body,
        contentHash: 'sha256:abc',
        revisionMajor: node.revisionMajor ?? 'A',
        revisionIteration: 0,
      };
    },
  } as unknown as GlmClient;
}

describe('glm_create_node tool', () => {
  test('maps snake_case input + relationships to the client shape', async () => {
    let seen: { ws: string; node: CreateNodeInput } | undefined;
    const result = await runCreateNode(
      {
        workspace: 'myapp',
        glm_id: 'acme:app.shop',
        stratum: 'capability',
        title: 'Shop',
        description: 'browse + buy',
        body: { user_value: 'pay' },
        relationships: [{ kind: 'composes-of', target_glm_id: 'acme:app.shop.cart' }],
      },
      { client: fakeClient((ws, node) => { seen = { ws, node }; }), config: CONFIG },
    );

    expect(seen?.ws).toBe('myapp');
    expect(seen?.node.glmId).toBe('acme:app.shop');
    // snake target_glm_id -> camel targetGlmId, ord defaults to the array index.
    expect(seen?.node.relationships).toEqual([
      { kind: 'composes-of', targetGlmId: 'acme:app.shop.cart', ord: 0, attributes: null },
    ]);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain("capability 'acme:app.shop'");
    expect(text).toContain('1 edge');
  });

  test('falls back to config.workspace when omitted', async () => {
    let seenWs = '';
    await runCreateNode(
      { glm_id: 'acme:app', stratum: 'system', title: 'App', body: { system_role: 'root' }, system_role: 'root' },
      { client: fakeClient((ws) => { seenWs = ws; }), config: CONFIG },
    );
    expect(seenWs).toBe('demo');
  });
});
