import { describe, expect, test } from 'bun:test';
import { runGetComponentSpec } from '../../src/tools/get-component-spec.ts';
import type { GlmClient, ComponentSpecPayload } from '../../src/lib/glm-client.ts';
import type { ResolvedConfig } from '../../src/lib/config.ts';

const CONFIG: ResolvedConfig = {
  port: 3300,
  workspace: 'demo',
  token: 'tok',
  baseUrl: 'http://localhost:3300',
};

function nodeSummary(glmId: string, title: string, body: unknown, hash: string) {
  return {
    id: `id-${glmId}`,
    glmId,
    stratum: 'component',
    title,
    description: '',
    revisionStatus: 'in_work',
    body,
    contentHash: hash,
  };
}

const SAMPLE: ComponentSpecPayload = {
  component: nodeSummary('acme:web.shop.cart.cart_manager', 'Cart manager', { boundary: 'cart' }, 'sha256:aaa'),
  specPrompt: nodeSummary(
    'acme:web.shop.cart.cart_manager.spec.prompt',
    'Cart manager prompt',
    { outputs: [{ path: 'src/cart.ts' }] },
    'sha256:bbb',
  ),
  specAcceptance: nodeSummary(
    'acme:web.shop.cart.cart_manager.spec.acceptance',
    'Cart acceptance',
    { verifier: { command: 'bun test test/cart.test.ts' } },
    'sha256:ccc',
  ),
  outputs: [
    { path: 'src/cart.ts', description: 'cart module' },
    { path: 'test/cart.test.ts', description: 'cart tests' },
  ],
  contextBundle: { text: '# acme:web.shop\n{...}', bindingHash: 'sha256:bbbbbb' },
  hardConstraints: 'HARD CONSTRAINTS:\n- Output ONLY file content.\n=== FILE: marker',
  sourceDir: '/work/petshop',
  promptTemplate: 'You are generating the cart manager.',
  verifierCommand: 'bun test test/cart.test.ts',
};

function fakeClient(
  payload: ComponentSpecPayload,
  capture?: (workspaceId: string, componentId: string) => void,
): GlmClient {
  return {
    baseUrl: 'http://localhost:3300',
    getComponentSpec: async (wid: string, cid: string) => {
      capture?.(wid, cid);
      return payload;
    },
  } as unknown as GlmClient;
}

describe('glm_get_component_spec tool', () => {
  test('requests the right workspace + component id', async () => {
    let seenWs = '';
    let seenComp = '';
    await runGetComponentSpec(
      { component_id: 'acme:web.shop.cart.cart_manager' },
      { client: fakeClient(SAMPLE, (w, c) => { seenWs = w; seenComp = c; }), config: CONFIG },
    );
    expect(seenWs).toBe('demo');
    expect(seenComp).toBe('acme:web.shop.cart.cart_manager');
  });

  test('renders a labeled-section text block with all the spec parts', async () => {
    const result = await runGetComponentSpec(
      { component_id: 'acme:web.shop.cart.cart_manager' },
      { client: fakeClient(SAMPLE), config: CONFIG },
    );
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('# Component: acme:web.shop.cart.cart_manager');
    expect(text).toContain('Source dir: /work/petshop');
    expect(text).toContain('## Outputs (2 files)');
    expect(text).toContain('src/cart.ts — cart module');
    expect(text).toContain('## Verifier');
    expect(text).toContain('bun test test/cart.test.ts');
    expect(text).toContain('## Prompt template');
    expect(text).toContain('You are generating the cart manager.');
    expect(text).toContain('## Context bundle');
    expect(text).toContain('# acme:web.shop');
    expect(text).toContain('## Hard constraints');
    expect(text).toContain('HARD CONSTRAINTS');
    expect(text).toContain('binding_hash:');
    expect(text).toContain('sha256:bbbbbb');
  });

  test('warns when source_dir is null', async () => {
    const sample: ComponentSpecPayload = { ...SAMPLE, sourceDir: null };
    const result = await runGetComponentSpec(
      { component_id: 'acme:web.shop.cart.cart_manager' },
      { client: fakeClient(sample), config: CONFIG },
    );
    expect(result.content[0]?.text).toContain('not set');
  });

  test('input workspace overrides config workspace', async () => {
    let seenWs = '';
    await runGetComponentSpec(
      { component_id: 'acme:web.shop.cart.cart_manager', workspace: 'other-ws' },
      { client: fakeClient(SAMPLE, (w) => { seenWs = w; }), config: CONFIG },
    );
    expect(seenWs).toBe('other-ws');
  });
});
