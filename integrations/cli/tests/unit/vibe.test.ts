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
    expect(out).toContain('invoking');
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

  test('--from-dir → exit 2 (Phase 7)', async () => {
    const opts = makeOpts();
    const exit = await runVibe(
      parseCommandLine(['vibe', '--from-dir=./somewhere']),
      opts,
    );
    expect(exit).toBe(2);
    expect((opts.io!.stderr as StringStream).buffer).toContain('Phase 7');
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
    // First line is the "invoking" pre-roll; the second is the JSON.
    const jsonLine = out.split('\n').find((line) => line.startsWith('{'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine as string);
    expect(parsed.workspaceId).toBe('ws-1');
  });
});
