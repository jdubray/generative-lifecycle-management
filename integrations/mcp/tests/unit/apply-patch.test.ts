import { describe, expect, test } from 'bun:test';
import { runApplyPatch } from '../../src/tools/apply-patch.ts';
import type {
  EditLock,
  GlmClient,
  NodeWithChildren,
} from '../../src/lib/glm-client.ts';
import type { ResolvedConfig } from '../../src/lib/config.ts';

const CONFIG: ResolvedConfig = {
  port: 3300,
  workspace: 'demo',
  token: 'tok',
  baseUrl: 'http://localhost:3300',
};

interface Calls {
  getNode: number;
  acquireLock: number;
  updateNodeBody: number;
  releaseLock: number;
  /** ordering record: 'get', 'lock', 'put', 'release' in order seen. */
  order: string[];
  /** payload sent to updateNodeBody, captured. */
  putBody?: Record<string, unknown>;
}

function fakeClient(
  initial: NodeWithChildren,
  updated: NodeWithChildren['node'],
  opts: { failOnPut?: boolean; lockHeldBy?: string } = {},
): { client: GlmClient; calls: Calls } {
  const calls: Calls = { getNode: 0, acquireLock: 0, updateNodeBody: 0, releaseLock: 0, order: [] };
  const lock: EditLock = {
    nodeId: initial.node.id,
    heldBy: 'solo',
    heartbeatAt: '2026-05-13T16:00:00Z',
    expiresAt: '2026-05-13T16:00:30Z',
  };
  const client = {
    baseUrl: 'http://localhost:3300',
    getNode: async () => {
      calls.getNode++;
      calls.order.push('get');
      return initial;
    },
    acquireLock: async () => {
      calls.acquireLock++;
      calls.order.push('lock');
      if (opts.lockHeldBy && opts.lockHeldBy !== 'solo') {
        throw new Error(`HTTP 423 from .../lock: held by ${opts.lockHeldBy}`);
      }
      return lock;
    },
    updateNodeBody: async (_w: string, _g: string, body: Record<string, unknown>) => {
      calls.updateNodeBody++;
      calls.order.push('put');
      calls.putBody = body;
      if (opts.failOnPut) throw new Error('HTTP 500 from PUT');
      return updated;
    },
    releaseLock: async () => {
      calls.releaseLock++;
      calls.order.push('release');
    },
  } as unknown as GlmClient;
  return { client, calls };
}

const NODE: NodeWithChildren = {
  node: {
    id: 'n-1',
    glmId: 'acme:c.spec.prompt',
    stratum: 'spec',
    title: 'Cart prompt',
    description: '',
    revisionStatus: 'in_work',
    body: {
      prompt_template: 'old',
      outputs: [{ path: 'src/old.ts' }],
    },
    contentHash: 'sha256:before',
    revisionMajor: 'A',
    revisionIteration: 0,
    systemRole: null,
    specKind: 'prompt',
  },
  parameters: [],
  constraints: [],
  relationships: [],
};

const UPDATED = {
  ...NODE.node,
  contentHash: 'sha256:after',
  revisionIteration: 1,
};

describe('glm_apply_patch tool', () => {
  test('GET → lock → PUT (patched body) → release, in order', async () => {
    const { client, calls } = fakeClient(NODE, UPDATED);
    await runApplyPatch(
      {
        glm_id: 'acme:c.spec.prompt',
        ops: [{ op: 'replace', path: '/prompt_template', value: 'new template' }],
      },
      { client, config: CONFIG },
    );
    expect(calls.order).toEqual(['get', 'lock', 'put', 'release']);
    expect(calls.putBody).toEqual({
      prompt_template: 'new template',
      outputs: [{ path: 'src/old.ts' }],
    });
  });

  test('releases the lock even when PUT fails', async () => {
    const { client, calls } = fakeClient(NODE, UPDATED, { failOnPut: true });
    await expect(
      runApplyPatch(
        {
          glm_id: 'acme:c.spec.prompt',
          ops: [{ op: 'replace', path: '/prompt_template', value: 'x' }],
        },
        { client, config: CONFIG },
      ),
    ).rejects.toThrow();
    expect(calls.acquireLock).toBe(1);
    expect(calls.releaseLock).toBe(1);
  });

  test('throws when patch makes body non-object (replace root with array)', async () => {
    const { client } = fakeClient(NODE, UPDATED);
    await expect(
      runApplyPatch(
        { glm_id: 'acme:c.spec.prompt', ops: [{ op: 'replace', path: '', value: ['oops'] }] },
        { client, config: CONFIG },
      ),
    ).rejects.toThrow(/plain object/);
  });

  test('renders before+after contentHash in output', async () => {
    const { client } = fakeClient(NODE, UPDATED);
    const result = await runApplyPatch(
      {
        glm_id: 'acme:c.spec.prompt',
        ops: [{ op: 'replace', path: '/prompt_template', value: 'new' }],
      },
      { client, config: CONFIG },
    );
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Patched acme:c.spec.prompt');
    expect(text).toContain('ops applied:       1');
    expect(text).toContain('sha256:before');
    expect(text).toContain('sha256:after');
    expect(text).toContain('revision:           A.1');
  });
});
