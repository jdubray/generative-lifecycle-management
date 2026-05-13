import { describe, expect, test } from 'bun:test';
import { runListComponents } from '../../src/tools/list-components.ts';
import type { GlmClient, SekkeiNodeSummary } from '../../src/lib/glm-client.ts';
import type { ResolvedConfig } from '../../src/lib/config.ts';

const CONFIG: ResolvedConfig = {
  port: 3300,
  workspace: 'demo',
  token: 'tok',
  baseUrl: 'http://localhost:3300',
};

function fakeClient(
  nodes: SekkeiNodeSummary[],
  capture?: (workspaceId: string, opts: { stratum?: string }) => void,
): GlmClient {
  return {
    baseUrl: 'http://localhost:3300',
    listNodes: async (workspaceId: string, opts: { stratum?: string } = {}) => {
      capture?.(workspaceId, opts);
      return { nodes };
    },
  } as unknown as GlmClient;
}

const NODES: SekkeiNodeSummary[] = [
  {
    id: 'n1',
    glmId: 'acme:web.shop.cart.cart_manager',
    stratum: 'component',
    title: 'Cart manager',
    description: '',
    revisionStatus: 'in_work',
  },
  {
    id: 'n2',
    glmId: 'acme:web.shop.catalog.product_repository',
    stratum: 'component',
    title: 'Product repository',
    description: '',
    revisionStatus: 'frozen',
  },
];

describe('glm_list_components tool', () => {
  test('queries with stratum=component', async () => {
    let seenStratum: string | undefined;
    await runListComponents({}, { client: fakeClient(NODES, (_id, opts) => { seenStratum = opts.stratum; }), config: CONFIG });
    expect(seenStratum).toBe('component');
  });

  test('renders one line per component with glm_id, title, and status', async () => {
    const result = await runListComponents({}, { client: fakeClient(NODES), config: CONFIG });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('2 components in workspace demo');
    expect(text).toContain('acme:web.shop.cart.cart_manager — Cart manager (in_work)');
    expect(text).toContain('acme:web.shop.catalog.product_repository — Product repository (frozen)');
  });

  test('handles empty list', async () => {
    const result = await runListComponents({}, { client: fakeClient([]), config: CONFIG });
    expect(result.content[0]?.text).toContain('no components');
  });

  test('input workspace overrides config workspace', async () => {
    let seenId = '';
    await runListComponents(
      { workspace: 'other-ws' },
      { client: fakeClient(NODES, (id) => { seenId = id; }), config: CONFIG },
    );
    expect(seenId).toBe('other-ws');
  });
});
