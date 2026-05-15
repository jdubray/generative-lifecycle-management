import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVibe, type RunVibeOptions } from '../../src/commands/vibe.ts';
import { parseCommandLine } from '../../src/lib/argv.ts';
import { GlmClient, type ImportSekkeiResult } from '../../src/lib/glm-client.ts';
import type { RunOneShotResult } from '../../src/lib/claude-cli.ts';
import { HttpError } from '../../src/lib/errors.ts';

class StringStream {
  public buffer = '';
  write(chunk: string | Uint8Array): boolean {
    this.buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }
}

const SKILL_FILES = {
  authoringSkill: '# Skill: Sekkei Authoring\nbody\n',
  schemaJson: '{"type":"object"}',
};

const SAMPLE_YAML = [
  '---',
  'id: acme:web.shop',
  'stratum: system',
  'title: Acme Shop',
  '---',
  'id: acme:web.shop.catalog',
  'stratum: capability',
  'title: Catalog',
].join('\n');

const IMPORT_OK: ImportSekkeiResult = {
  workspaceId: 'ws-1',
  workspace: { id: 'ws-1', slug: 'acme-shop', name: 'Acme Shop' },
  summary: { nodesInserted: 2, nodesUpdated: 0, nodesUnchanged: 0 },
};

function fakeClient(importImpl?: () => Promise<ImportSekkeiResult>): GlmClient {
  const client = Object.create(GlmClient.prototype) as GlmClient;
  Object.assign(client, {
    importSekkei: importImpl ?? (() => Promise.resolve(IMPORT_OK)),
  });
  return client;
}

function fakeClaude(stdout: string): (opts: unknown) => Promise<RunOneShotResult> {
  return () => Promise.resolve({ stdout, stderr: '', exitCode: 0, durationMs: 1 });
}

function makeOpts(extra: Partial<RunVibeOptions> = {}): RunVibeOptions {
  const stdout = new StringStream();
  const stderr = new StringStream();
  return {
    io: { stdout, stderr },
    skillFiles: SKILL_FILES,
    resolveOverrides: { env: {}, fileExists: () => false, readFile: () => '' },
    ...extra,
  };
}

describe('glm vibe', () => {
  test('happy path: spawns Claude, posts YAML to import, prints summary', async () => {
    let capturedRequest: unknown;
    const opts = makeOpts({
      clientFactory: () =>
        fakeClient(async () => {
          return IMPORT_OK;
        }),
      claudeRunner: fakeClaude(SAMPLE_YAML),
    });
    const exit = await runVibe(
      parseCommandLine([
        'vibe',
        '--slug=acme-shop',
        '--namespace=acme:web.shop',
        '--description=An online store',
      ]),
      opts,
    );
    expect(exit).toBe(0);
    const out = (opts.io!.stdout as StringStream).buffer;
    const err = (opts.io!.stderr as StringStream).buffer;
    expect(err).toContain('invoking'); // progress on stderr
    expect(out).not.toContain('invoking'); // not on stdout
    expect(out).toContain("imported into workspace 'acme-shop'");
    expect(out).toContain('inserted   2');
  });

  test('captures the YAML sent to the server (post-fence-strip)', async () => {
    let captured: { yaml?: string; slug?: string } = {};
    const opts = makeOpts({
      clientFactory: () => {
        const client = Object.create(GlmClient.prototype) as GlmClient;
        Object.assign(client, {
          importSekkei: async (req: { yaml: string; slug: string }) => {
            captured = req;
            return IMPORT_OK;
          },
        });
        return client;
      },
      claudeRunner: fakeClaude('```yaml\n' + SAMPLE_YAML + '\n```\n'),
    });
    await runVibe(
      parseCommandLine([
        'vibe',
        '--slug=acme-shop',
        '--namespace=acme:web.shop',
        '--description=desc',
      ]),
      opts,
    );
    expect(captured.slug).toBe('acme-shop');
    expect(captured.yaml).toContain('id: acme:web.shop');
    expect(captured.yaml).not.toContain('```'); // fences stripped
  });

  test('missing --slug → exit 64 (usage error)', async () => {
    const opts = makeOpts({ clientFactory: () => fakeClient(), claudeRunner: fakeClaude('x') });
    const exit = await runVibe(
      parseCommandLine(['vibe', '--namespace=acme:web.shop', '--description=desc']),
      opts,
    );
    expect(exit).toBe(64);
    expect((opts.io!.stderr as StringStream).buffer).toContain('--slug is required');
  });

  test('missing --namespace → exit 64', async () => {
    const opts = makeOpts({ clientFactory: () => fakeClient(), claudeRunner: fakeClaude('x') });
    const exit = await runVibe(
      parseCommandLine(['vibe', '--slug=acme-shop', '--description=desc']),
      opts,
    );
    expect(exit).toBe(64);
    expect((opts.io!.stderr as StringStream).buffer).toContain('--namespace is required');
  });

  test('missing description → exit 64', async () => {
    const opts = makeOpts({ clientFactory: () => fakeClient(), claudeRunner: fakeClaude('x') });
    const exit = await runVibe(
      parseCommandLine(['vibe', '--slug=acme-shop', '--namespace=acme:web.shop']),
      opts,
    );
    expect(exit).toBe(64);
    expect((opts.io!.stderr as StringStream).buffer).toContain('description');
  });

  test('--description-file is read from disk', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-vibe-test-'));
    const file = join(tmp, 'desc.txt');
    writeFileSync(file, 'A description from a file.', 'utf8');
    try {
      const opts = makeOpts({
        clientFactory: () => fakeClient(),
        claudeRunner: fakeClaude(SAMPLE_YAML),
      });
      const exit = await runVibe(
        parseCommandLine([
          'vibe',
          '--slug=acme-shop',
          '--namespace=acme:web.shop',
          `--description-file=${file}`,
        ]),
        opts,
      );
      expect(exit).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('empty Claude output → exit 70', async () => {
    const opts = makeOpts({
      clientFactory: () => fakeClient(),
      claudeRunner: fakeClaude('   \n  \n'),
    });
    const exit = await runVibe(
      parseCommandLine([
        'vibe',
        '--slug=acme-shop',
        '--namespace=acme:web.shop',
        '--description=desc',
      ]),
      opts,
    );
    expect(exit).toBe(70);
    expect((opts.io!.stderr as StringStream).buffer).toContain('empty response');
  });

  test('import 422 → mapped to HttpError exit code', async () => {
    const opts = makeOpts({
      clientFactory: () =>
        fakeClient(() =>
          Promise.reject(new HttpError('http://x/import', 422, 'invalid yaml')),
        ),
      claudeRunner: fakeClaude(SAMPLE_YAML),
    });
    const exit = await runVibe(
      parseCommandLine([
        'vibe',
        '--slug=acme-shop',
        '--namespace=acme:web.shop',
        '--description=desc',
      ]),
      opts,
    );
    expect(exit).toBe(70); // 422 maps to internal-software in HttpError
  });

  test('--from-dir rejects a path that does not exist', async () => {
    const opts = makeOpts();
    const exit = await runVibe(
      parseCommandLine([
        'vibe',
        '--slug=acme-shop',
        '--namespace=acme:legacy.app',
        '--from-dir=/nope/this/path/does/not/exist',
      ]),
      opts,
    );
    expect(exit).toBe(64);
    expect((opts.io!.stderr as StringStream).buffer).toContain('does not exist');
  });

  test('--from-dir branch: scans codebase, builds reverse-engineer prompt, imports', async () => {
    // Scan an existing real directory — the cli's own source — so we don't need
    // to mock the scanner. The claude runner returns canned YAML.
    const tmp = mkdtempSync(join(tmpdir(), 'glm-vibe-rev-'));
    writeFileSync(join(tmp, 'README.md'), '# tiny project', 'utf8');
    writeFileSync(join(tmp, 'package.json'), '{"name":"tiny"}', 'utf8');
    try {
      let capturedUserText = '';
      const opts = makeOpts({
        clientFactory: () => fakeClient(),
        claudeRunner: (claudeOpts) => {
          capturedUserText = claudeOpts.userText;
          return Promise.resolve({
            stdout: SAMPLE_YAML,
            stderr: '',
            exitCode: 0,
            durationMs: 1,
          });
        },
      });
      const exit = await runVibe(
        parseCommandLine([
          'vibe',
          '--slug=acme-legacy',
          '--namespace=acme:legacy.app',
          `--from-dir=${tmp}`,
        ]),
        opts,
      );
      expect(exit).toBe(0);
      // Reverse-engineer user prompt should mention the codebase + namespace.
      expect(capturedUserText).toContain('Reverse-engineer a sekkei');
      expect(capturedUserText).toContain('Namespace prefix: acme:legacy.app');
      expect(capturedUserText).toContain(tmp);
      expect(capturedUserText).toContain('README.md');
      expect(capturedUserText).toContain('package.json');
      // Stderr carries the progress messages.
      const err = (opts.io!.stderr as StringStream).buffer;
      expect(err).toContain('scanning codebase');
      expect(err).toContain('key files in the excerpt set');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--from-dir does NOT require --description', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-vibe-rev-'));
    writeFileSync(join(tmp, 'README.md'), '# x', 'utf8');
    try {
      const opts = makeOpts({
        clientFactory: () => fakeClient(),
        claudeRunner: fakeClaude(SAMPLE_YAML),
      });
      const exit = await runVibe(
        parseCommandLine([
          'vibe',
          '--slug=acme-legacy',
          '--namespace=acme:legacy.app',
          `--from-dir=${tmp}`,
        ]),
        opts,
      );
      // Should not exit 64 for missing description.
      expect(exit).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--from-dir uses the reverse-engineer system prompt (rules visible)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-vibe-rev-'));
    writeFileSync(join(tmp, 'README.md'), '# x', 'utf8');
    try {
      let capturedSystemPrompt = '';
      const opts = makeOpts({
        clientFactory: () => fakeClient(),
        claudeRunner: (claudeOpts) => {
          // Read the system prompt file synchronously — the runVibe finally
          // block hasn't run yet because we're still inside the runner.
          capturedSystemPrompt = readFileSync(claudeOpts.systemPromptFile as string, 'utf8');
          return Promise.resolve({ stdout: SAMPLE_YAML, stderr: '', exitCode: 0, durationMs: 1 });
        },
      });
      await runVibe(
        parseCommandLine([
          'vibe',
          '--slug=acme-legacy',
          '--namespace=acme:legacy.app',
          `--from-dir=${tmp}`,
        ]),
        opts,
      );
      expect(capturedSystemPrompt).toContain('reverse-engineering an existing codebase');
      expect(capturedSystemPrompt).toContain('override_kind: net_new');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--out writes the generated YAML to disk before import', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-vibe-out-'));
    const outFile = join(tmp, 'out.yaml');
    try {
      const opts = makeOpts({
        clientFactory: () => fakeClient(),
        claudeRunner: fakeClaude(SAMPLE_YAML),
      });
      await runVibe(
        parseCommandLine([
          'vibe',
          '--slug=acme-shop',
          '--namespace=acme:web.shop',
          '--description=desc',
          `--out=${outFile}`,
        ]),
        opts,
      );
      const written = readFileSync(outFile, 'utf8');
      expect(written).toContain('id: acme:web.shop');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // P1-C regression tests — non-empty workspace guard

  function fakeClientWithWorkspaces(opts: {
    workspaces?: Array<{ id: string; slug: string; name: string }>;
    summaryNodeCount?: number;
    importImpl?: () => Promise<ImportSekkeiResult>;
  }): GlmClient {
    const client = Object.create(GlmClient.prototype) as GlmClient;
    const workspaces = opts.workspaces ?? [];
    const summary = {
      workspace: { id: 'ws-1', slug: 'acme-shop', name: 'Acme Shop' },
      nodes: { total: opts.summaryNodeCount ?? 0, byStratum: {} },
      scrs: { active: 0, byStatus: {} },
      drift: { drifted: 0, byStatus: {} },
      generation: { eventsConsidered: 0, tokensIn: 0, tokensOut: 0, cacheHits: 0, cacheMisses: 0 },
      verifier: null,
    };
    Object.assign(client, {
      listWorkspaces: async () => workspaces,
      getWorkspaceSummary: async () => summary,
      importSekkei: opts.importImpl ?? (() => Promise.resolve(IMPORT_OK)),
    });
    return client;
  }

  test('P1-C: refuses to import into a non-empty workspace without --force', async () => {
    const opts = makeOpts({
      clientFactory: () =>
        fakeClientWithWorkspaces({
          workspaces: [{ id: 'ws-1', slug: 'acme-shop', name: 'Acme Shop' }],
          summaryNodeCount: 50,
        }),
      claudeRunner: fakeClaude(SAMPLE_YAML),
    });
    const exit = await runVibe(
      parseCommandLine([
        'vibe',
        '--slug=acme-shop',
        '--namespace=acme:web.shop',
        '--description=desc',
      ]),
      opts,
    );
    expect(exit).toBe(1);
    const err = (opts.io!.stderr as StringStream).buffer;
    expect(err).toContain("workspace 'acme-shop' already has 50 nodes");
    expect(err).toContain('--force');
  });

  test('P1-C: --force allows merging into a non-empty workspace with a warning', async () => {
    let importCalled = false;
    const opts = makeOpts({
      clientFactory: () =>
        fakeClientWithWorkspaces({
          workspaces: [{ id: 'ws-1', slug: 'acme-shop', name: 'Acme Shop' }],
          summaryNodeCount: 50,
          importImpl: async () => {
            importCalled = true;
            return IMPORT_OK;
          },
        }),
      claudeRunner: fakeClaude(SAMPLE_YAML),
    });
    const exit = await runVibe(
      parseCommandLine([
        'vibe',
        '--slug=acme-shop',
        '--namespace=acme:web.shop',
        '--description=desc',
        '--force',
      ]),
      opts,
    );
    expect(exit).toBe(0);
    expect(importCalled).toBe(true);
    const err = (opts.io!.stderr as StringStream).buffer;
    expect(err).toContain('50 nodes');
    expect(err).toContain('merging (--force)');
  });

  test('P1-C: imports without guard when target workspace is empty', async () => {
    let importCalled = false;
    const opts = makeOpts({
      clientFactory: () =>
        fakeClientWithWorkspaces({
          workspaces: [{ id: 'ws-1', slug: 'acme-shop', name: 'Acme Shop' }],
          summaryNodeCount: 0,
          importImpl: async () => {
            importCalled = true;
            return IMPORT_OK;
          },
        }),
      claudeRunner: fakeClaude(SAMPLE_YAML),
    });
    const exit = await runVibe(
      parseCommandLine([
        'vibe',
        '--slug=acme-shop',
        '--namespace=acme:web.shop',
        '--description=desc',
      ]),
      opts,
    );
    expect(exit).toBe(0);
    expect(importCalled).toBe(true);
    const err = (opts.io!.stderr as StringStream).buffer;
    expect(err).not.toContain('already has');
  });

  test('P1-C: imports without guard when slug does not yet exist', async () => {
    let importCalled = false;
    const opts = makeOpts({
      clientFactory: () =>
        fakeClientWithWorkspaces({
          workspaces: [], // no existing workspaces
          importImpl: async () => {
            importCalled = true;
            return IMPORT_OK;
          },
        }),
      claudeRunner: fakeClaude(SAMPLE_YAML),
    });
    const exit = await runVibe(
      parseCommandLine([
        'vibe',
        '--slug=brand-new',
        '--namespace=acme:web.shop',
        '--description=desc',
      ]),
      opts,
    );
    expect(exit).toBe(0);
    expect(importCalled).toBe(true);
  });

  test('P1-C: --dry-run skips the workspace guard entirely', async () => {
    // dry-run must not call listWorkspaces (no auth needed in dry-run scenarios).
    let listCalled = false;
    const opts = makeOpts({
      clientFactory: () => {
        const client = Object.create(GlmClient.prototype) as GlmClient;
        Object.assign(client, {
          listWorkspaces: async () => {
            listCalled = true;
            return [{ id: 'ws-1', slug: 'acme-shop', name: 'Acme Shop' }];
          },
          getWorkspaceSummary: async () => ({
            workspace: { id: 'ws-1', slug: 'acme-shop', name: 'Acme Shop' },
            nodes: { total: 99, byStratum: {} },
            scrs: { active: 0, byStatus: {} },
            drift: { drifted: 0, byStatus: {} },
            generation: { eventsConsidered: 0, tokensIn: 0, tokensOut: 0, cacheHits: 0, cacheMisses: 0 },
            verifier: null,
          }),
          importSekkei: async () => IMPORT_OK,
        });
        return client;
      },
      claudeRunner: fakeClaude(SAMPLE_YAML),
    });
    const exit = await runVibe(
      parseCommandLine([
        'vibe',
        '--slug=acme-shop',
        '--namespace=acme:web.shop',
        '--description=desc',
        '--dry-run',
      ]),
      opts,
    );
    expect(exit).toBe(0);
    expect(listCalled).toBe(false);
  });

  test('--json emits machine-readable result', async () => {
    const opts = makeOpts({
      clientFactory: () => fakeClient(),
      claudeRunner: fakeClaude(SAMPLE_YAML),
    });
    await runVibe(
      parseCommandLine([
        'vibe',
        '--slug=acme-shop',
        '--namespace=acme:web.shop',
        '--description=desc',
        '--json',
      ]),
      opts,
    );
    const out = (opts.io!.stdout as StringStream).buffer;
    // With progress on stderr, stdout is exactly one JSON line for `--json`.
    expect(out.trim().startsWith('{')).toBe(true);
    const parsed = JSON.parse(out.trim());
    expect(parsed.workspaceId).toBe('ws-1');
  });
});
