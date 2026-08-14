import { describe, expect, test } from 'bun:test';
import type { ResolvedConfig } from '../../src/lib/config.ts';
import type { GlmClient } from '../../src/lib/glm-client.ts';
import { runDeleteNode } from '../../src/tools/delete-node.ts';

const CONFIG: ResolvedConfig = {
  port: 3300,
  workspace: 'demo',
  token: 'tok',
  baseUrl: 'http://localhost:3300',
};

interface Seen {
  ws: string;
  glmId: string;
  hard: boolean;
}

function fakeClient(capture: (seen: Seen) => void): GlmClient {
  return {
    deleteNode: async (ws: string, glmId: string, opts: { hard?: boolean } = {}) => {
      capture({ ws, glmId, hard: opts.hard === true });
      return opts.hard
        ? { hard: true, inboundEdgesRemoved: 2 }
        : { hard: false, revisionStatus: 'obsolete' };
    },
  } as unknown as GlmClient;
}

describe('glm_delete_node tool', () => {
  test('defaults to a soft delete', async () => {
    let seen: Seen | undefined;
    const result = await runDeleteNode(
      { glm_id: 'acme:app.shop' },
      {
        client: fakeClient((s) => {
          seen = s;
        }),
        config: CONFIG,
      },
    );

    expect(seen).toEqual({ ws: 'demo', glmId: 'acme:app.shop', hard: false });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('obsolete');
    expect(text).toContain('hard=true');
  });

  test('hard=true is forwarded and the swept edge count is reported', async () => {
    let seen: Seen | undefined;
    const result = await runDeleteNode(
      { workspace: 'myapp', glm_id: 'acme:app.shop', hard: true },
      {
        client: fakeClient((s) => {
          seen = s;
        }),
        config: CONFIG,
      },
    );

    expect(seen).toEqual({ ws: 'myapp', glmId: 'acme:app.shop', hard: true });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Hard-deleted');
    expect(text).toContain('2 inbound edges');
    expect(text).toContain('free to re-author');
  });

  test('hard=false is treated as soft, not as "hard mode with a falsy flag"', async () => {
    let seen: Seen | undefined;
    await runDeleteNode(
      { glm_id: 'acme:app.shop', hard: false },
      {
        client: fakeClient((s) => {
          seen = s;
        }),
        config: CONFIG,
      },
    );
    expect(seen?.hard).toBe(false);
  });
});
