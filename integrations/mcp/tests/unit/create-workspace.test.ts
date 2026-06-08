import { describe, expect, test } from 'bun:test';
import { runCreateWorkspace } from '../../src/tools/create-workspace.ts';
import type { GlmClient } from '../../src/lib/glm-client.ts';
import type { ResolvedConfig } from '../../src/lib/config.ts';

const CONFIG: ResolvedConfig = {
  port: 3300,
  workspace: 'default',
  token: 'tok',
  baseUrl: 'http://localhost:3300',
};

function fakeClient(capture: (slug: string, name?: string) => void): GlmClient {
  return {
    createWorkspace: async (slug: string, name?: string) => {
      capture(slug, name);
      return { id: 'ws-new', slug, name: name ?? slug };
    },
  } as unknown as GlmClient;
}

describe('glm_create_workspace tool', () => {
  test('creates the workspace and reports id + slug', async () => {
    let seen: { slug: string; name?: string } | undefined;
    const result = await runCreateWorkspace(
      { slug: 'myapp', name: 'My App' },
      { client: fakeClient((slug, name) => { seen = { slug, name }; }), config: CONFIG },
    );
    expect(seen).toEqual({ slug: 'myapp', name: 'My App' });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain("'myapp'");
    expect(text).toContain('ws-new');
  });
});
