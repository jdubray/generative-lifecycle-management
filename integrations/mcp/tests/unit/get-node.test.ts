import { describe, expect, test } from 'bun:test';
import { runGetNode } from '../../src/tools/get-node.ts';
import type { GlmClient, NodeWithChildren } from '../../src/lib/glm-client.ts';
import type { ResolvedConfig } from '../../src/lib/config.ts';

const CONFIG: ResolvedConfig = {
  port: 3300,
  workspace: 'demo',
  token: 'tok',
  baseUrl: 'http://localhost:3300',
};

const SAMPLE: NodeWithChildren = {
  node: {
    id: 'node-abc',
    glmId: 'acme:web.shop.cart.cart_manager',
    stratum: 'component',
    title: 'Cart manager',
    description: 'Owns the cart table.',
    revisionStatus: 'in_work',
    body: { boundary: 'in-memory cart state', runtime: 'in_process' },
    contentHash: 'sha256:deadbeef',
    revisionMajor: 'A',
    revisionIteration: 0,
    systemRole: null,
    specKind: null,
  },
  parameters: [],
  constraints: [],
  relationships: [{ kind: 'composes', targetGlmId: 'acme:web.shop.cart' }],
};

function fakeClient(
  node: NodeWithChildren,
  capture?: (wid: string, glmId: string) => void,
): GlmClient {
  return {
    baseUrl: 'http://localhost:3300',
    getNode: async (wid: string, glmId: string) => {
      capture?.(wid, glmId);
      return node;
    },
  } as unknown as GlmClient;
}

describe('glm_get_node tool', () => {
  test('requests the right workspace and glm_id', async () => {
    let seenWs = '';
    let seenGlm = '';
    await runGetNode(
      { glm_id: 'acme:web.shop.cart.cart_manager' },
      { client: fakeClient(SAMPLE, (w, g) => { seenWs = w; seenGlm = g; }), config: CONFIG },
    );
    expect(seenWs).toBe('demo');
    expect(seenGlm).toBe('acme:web.shop.cart.cart_manager');
  });

  test('renders the node as a JSON code block', async () => {
    const result = await runGetNode(
      { glm_id: 'acme:web.shop.cart.cart_manager' },
      { client: fakeClient(SAMPLE), config: CONFIG },
    );
    const text = result.content[0]?.text ?? '';
    expect(text.startsWith('```json\n')).toBe(true);
    expect(text.endsWith('\n```')).toBe(true);
    // The JSON body roundtrips.
    const innerJson = text.slice('```json\n'.length, -'\n```'.length);
    const parsed = JSON.parse(innerJson);
    expect(parsed.node.glmId).toBe('acme:web.shop.cart.cart_manager');
    expect(parsed.relationships[0].kind).toBe('composes');
  });

  test('input workspace overrides config workspace', async () => {
    let seenWs = '';
    await runGetNode(
      { glm_id: 'acme:web.shop', workspace: 'other-ws' },
      { client: fakeClient(SAMPLE, (w) => { seenWs = w; }), config: CONFIG },
    );
    expect(seenWs).toBe('other-ws');
  });
});
