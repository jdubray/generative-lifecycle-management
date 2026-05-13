import { describe, expect, test } from 'bun:test';
import { runRefine, type RunRefineOptions } from '../../src/commands/refine.ts';
import { parseCommandLine } from '../../src/lib/argv.ts';
import { GlmClient, type NodeWithChildren } from '../../src/lib/glm-client.ts';
import { HttpError } from '../../src/lib/errors.ts';
import type { RunOneShotResult } from '../../src/lib/claude-cli.ts';

class StringStream {
  public buffer = '';
  write(chunk: string | Uint8Array): boolean {
    this.buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }
}

const SKILL_FILES = { authoringSkill: '# skill stub\n', schemaJson: undefined };

const NODE: NodeWithChildren = {
  node: {
    id: 'node-1',
    glmId: 'acme:web.shop.catalog.product_repository',
    stratum: 'component',
    title: 'Product Repository',
    body: { behaviors: [{ id: 'create', signature: 'create(input)' }] },
    contentHash: 'sha256:abc',
    revisionMajor: 'A',
    revisionIteration: 2,
    revisionStatus: 'in_work',
    overrideKind: 'net_new',
  },
  parameters: [],
  constraints: [],
  relationships: [],
};

interface CapturedClient {
  client: GlmClient;
  getNodeCalls: string[];
  updateNodeCalls: Array<{ body: Record<string, unknown> }>;
  acquireLockCalls: string[];
  releaseLockCalls: string[];
}

function fakeClient(overrides: Partial<{
  getNode: () => Promise<NodeWithChildren>;
  updateNode: (input: Record<string, unknown>) => Promise<NodeWithChildren['node']>;
  acquireLock: () => Promise<void>;
  releaseLock: () => Promise<void>;
}> = {}): CapturedClient {
  const getNodeCalls: string[] = [];
  const updateNodeCalls: Array<{ body: Record<string, unknown> }> = [];
  const acquireLockCalls: string[] = [];
  const releaseLockCalls: string[] = [];
  const client = Object.create(GlmClient.prototype) as GlmClient;
  Object.assign(client, {
    getNode: async (_ws: string, glmId: string) => {
      getNodeCalls.push(glmId);
      return overrides.getNode ? overrides.getNode() : NODE;
    },
    updateNode: async (_ws: string, _glmId: string, input: Record<string, unknown>) => {
      updateNodeCalls.push({ body: input });
      if (overrides.updateNode) return overrides.updateNode(input);
      return { ...NODE.node, revisionIteration: 3, contentHash: 'sha256:new' };
    },
    acquireLock: async (_ws: string, glmId: string) => {
      acquireLockCalls.push(glmId);
      if (overrides.acquireLock) return overrides.acquireLock();
    },
    releaseLock: async (_ws: string, glmId: string) => {
      releaseLockCalls.push(glmId);
      if (overrides.releaseLock) return overrides.releaseLock();
    },
  });
  return { client, getNodeCalls, updateNodeCalls, acquireLockCalls, releaseLockCalls };
}

function fakeClaude(stdout: string): (opts: unknown) => Promise<RunOneShotResult> {
  return () => Promise.resolve({ stdout, stderr: '', exitCode: 0, durationMs: 1 });
}

function makeOpts(extra: Partial<RunRefineOptions> = {}): RunRefineOptions & {
  stdout: StringStream;
  stderr: StringStream;
} {
  const stdout = new StringStream();
  const stderr = new StringStream();
  return {
    io: { stdout, stderr },
    stdout,
    stderr,
    skillFiles: SKILL_FILES,
    resolveOverrides: { env: {}, fileExists: () => false, readFile: () => '' },
    ...extra,
  };
}

describe('glm refine', () => {
  test('happy path: fetch → claude → patch → lock → PUT → unlock', async () => {
    const captured = fakeClient();
    const patchJson = JSON.stringify([
      { op: 'add', path: '/behaviors/-', value: { id: 'search', signature: 'search(q)' } },
    ]);
    const opts = makeOpts({
      clientFactory: () => captured.client,
      claudeRunner: fakeClaude(patchJson),
    });
    const exit = await runRefine(
      parseCommandLine([
        'refine',
        '--node=acme:web.shop.catalog.product_repository',
        '--instruction=add a search behavior',
      ]),
      opts,
    );
    expect(exit).toBe(0);
    expect(captured.getNodeCalls).toEqual(['acme:web.shop.catalog.product_repository']);
    expect(captured.acquireLockCalls).toEqual(['acme:web.shop.catalog.product_repository']);
    expect(captured.releaseLockCalls).toEqual(['acme:web.shop.catalog.product_repository']);
    expect(captured.updateNodeCalls.length).toBe(1);
    const sentBody = captured.updateNodeCalls[0]!.body.body as {
      behaviors: Array<{ id: string }>;
    };
    expect(sentBody.behaviors.length).toBe(2);
    expect(sentBody.behaviors[1]!.id).toBe('search');
    // revisionIteration incremented
    expect(captured.updateNodeCalls[0]!.body.revisionIteration).toBe(3);
    const out = (opts.stdout as StringStream).buffer;
    expect(out).toContain('applied 1 op(s)');
    expect(out).toContain('1 add');
  });

  test('--dry-run: does not lock or PUT, prints the patch ops', async () => {
    const captured = fakeClient();
    const patchJson = JSON.stringify([{ op: 'replace', path: '/title', value: 'x' }]);
    const opts = makeOpts({
      clientFactory: () => captured.client,
      claudeRunner: fakeClaude(patchJson),
    });
    const exit = await runRefine(
      parseCommandLine([
        'refine',
        '--node=acme:web.shop.catalog.product_repository',
        '--instruction=rename',
        '--dry-run',
      ]),
      opts,
    );
    expect(exit).toBe(0);
    expect(captured.acquireLockCalls).toEqual([]);
    expect(captured.updateNodeCalls).toEqual([]);
    expect((opts.stdout as StringStream).buffer).toContain('dry-run');
    expect((opts.stdout as StringStream).buffer).toContain('replace /title');
  });

  test('missing --node → exit 64', async () => {
    const captured = fakeClient();
    const opts = makeOpts({ clientFactory: () => captured.client, claudeRunner: fakeClaude('[]') });
    const exit = await runRefine(parseCommandLine(['refine', '--instruction=x']), opts);
    expect(exit).toBe(64);
    expect((opts.stderr as StringStream).buffer).toContain('--node is required');
  });

  test('missing --instruction → exit 64', async () => {
    const captured = fakeClient();
    const opts = makeOpts({ clientFactory: () => captured.client, claudeRunner: fakeClaude('[]') });
    const exit = await runRefine(parseCommandLine(['refine', '--node=acme:x']), opts);
    expect(exit).toBe(64);
    expect((opts.stderr as StringStream).buffer).toContain('--instruction');
  });

  test('claude returns non-JSON → exit 70', async () => {
    const captured = fakeClient();
    const opts = makeOpts({
      clientFactory: () => captured.client,
      claudeRunner: fakeClaude('this is prose, not JSON'),
    });
    const exit = await runRefine(
      parseCommandLine([
        'refine',
        '--node=acme:x',
        '--instruction=x',
      ]),
      opts,
    );
    expect(exit).toBe(70);
    expect((opts.stderr as StringStream).buffer).toContain('not valid JSON');
    expect(captured.acquireLockCalls).toEqual([]);
  });

  test('claude returns empty patch array → exit 70', async () => {
    const captured = fakeClient();
    const opts = makeOpts({
      clientFactory: () => captured.client,
      claudeRunner: fakeClaude('[]'),
    });
    const exit = await runRefine(
      parseCommandLine(['refine', '--node=acme:x', '--instruction=x']),
      opts,
    );
    expect(exit).toBe(70);
    expect((opts.stderr as StringStream).buffer).toContain('empty');
  });

  test('node 404 → exit 66; no claude invocation', async () => {
    let claudeCalled = false;
    const captured = fakeClient({
      getNode: () => Promise.reject(new HttpError('http://x', 404, 'not found')),
    });
    const opts = makeOpts({
      clientFactory: () => captured.client,
      claudeRunner: () => {
        claudeCalled = true;
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 });
      },
    });
    const exit = await runRefine(
      parseCommandLine(['refine', '--node=acme:nope', '--instruction=x']),
      opts,
    );
    expect(exit).toBe(66);
    expect(claudeCalled).toBe(false);
  });

  test('updateNode failure releases the lock and exits with the HTTP code', async () => {
    const captured = fakeClient({
      updateNode: () => Promise.reject(new HttpError('http://x', 409, 'lock not held')),
    });
    const patchJson = JSON.stringify([{ op: 'replace', path: '/title', value: 'x' }]);
    const opts = makeOpts({
      clientFactory: () => captured.client,
      claudeRunner: fakeClaude(patchJson),
    });
    const exit = await runRefine(
      parseCommandLine(['refine', '--node=acme:x', '--instruction=x']),
      opts,
    );
    // HttpError maps 409 to 70 (internal-software in HttpError) — see errors.ts.
    expect(exit).toBe(70);
    expect(captured.releaseLockCalls.length).toBe(1);
  });

  test('--json emits a single JSON line with applied=true', async () => {
    const captured = fakeClient();
    const patchJson = JSON.stringify([{ op: 'replace', path: '/title', value: 'x' }]);
    const opts = makeOpts({
      clientFactory: () => captured.client,
      claudeRunner: fakeClaude(patchJson),
    });
    await runRefine(
      parseCommandLine([
        'refine',
        '--node=acme:x',
        '--instruction=x',
        '--json',
      ]),
      opts,
    );
    const out = (opts.stdout as StringStream).buffer;
    expect(out.trim().startsWith('{')).toBe(true);
    const parsed = JSON.parse(out.trim());
    expect(parsed.applied).toBe(true);
    expect(parsed.patch.length).toBe(1);
  });
});
