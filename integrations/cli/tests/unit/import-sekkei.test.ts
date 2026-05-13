import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runImportSekkei, type RunImportSekkeiOptions } from '../../src/commands/import-sekkei.ts';
import { parseCommandLine } from '../../src/lib/argv.ts';
import { GlmClient, type ImportSekkeiResult } from '../../src/lib/glm-client.ts';
import { HttpError, ServerUnreachableError } from '../../src/lib/errors.ts';

class StringStream {
  public buffer = '';
  write(chunk: string | Uint8Array): boolean {
    this.buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }
}

const IMPORT_OK: ImportSekkeiResult = {
  workspaceId: 'ws-1',
  workspace: { id: 'ws-1', slug: 'demo', name: 'Demo' },
  summary: { nodesInserted: 3, nodesUpdated: 1, nodesUnchanged: 0 },
};

function fakeClient(impl: () => Promise<ImportSekkeiResult>): GlmClient {
  const c = Object.create(GlmClient.prototype) as GlmClient;
  Object.assign(c, { importSekkei: impl });
  return c;
}

function makeOpts(extra: Partial<RunImportSekkeiOptions> = {}): RunImportSekkeiOptions & {
  stdout: StringStream;
  stderr: StringStream;
} {
  const stdout = new StringStream();
  const stderr = new StringStream();
  return {
    io: { stdout, stderr },
    stdout,
    stderr,
    resolveOverrides: { env: {}, fileExists: () => false, readFile: () => '' },
    ...extra,
  };
}

describe('glm import-sekkei', () => {
  test('reads the file, posts it, prints summary, exit 0', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-import-'));
    const file = join(tmp, 'sekkei.yaml');
    writeFileSync(file, 'id: acme:web.shop\nstratum: system\n', 'utf8');
    try {
      let captured: { slug?: string; yaml?: string; filename?: string } = {};
      const opts = makeOpts({
        clientFactory: () => {
          const c = Object.create(GlmClient.prototype) as GlmClient;
          Object.assign(c, {
            importSekkei: async (req: { slug: string; yaml: string; filename?: string }) => {
              captured = req;
              return IMPORT_OK;
            },
          });
          return c;
        },
      });
      const exit = await runImportSekkei(
        parseCommandLine(['import-sekkei', file, '--slug=demo']),
        opts,
      );
      expect(exit).toBe(0);
      expect(captured.slug).toBe('demo');
      expect(captured.yaml).toContain('id: acme:web.shop');
      expect(captured.filename).toBe('sekkei.yaml');
      const out = (opts.stdout as StringStream).buffer;
      expect(out).toContain("workspace 'demo'");
      expect(out).toContain('inserted   3');
      expect(out).toContain('updated    1');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--json emits one JSON line on stdout', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-import-'));
    const file = join(tmp, 's.yaml');
    writeFileSync(file, 'id: x\nstratum: system\n', 'utf8');
    try {
      const opts = makeOpts({ clientFactory: () => fakeClient(() => Promise.resolve(IMPORT_OK)) });
      const exit = await runImportSekkei(
        parseCommandLine(['import-sekkei', file, '--slug=demo', '--json']),
        opts,
      );
      expect(exit).toBe(0);
      const out = (opts.stdout as StringStream).buffer;
      expect(out.trim().startsWith('{')).toBe(true);
      const parsed = JSON.parse(out.trim());
      expect(parsed.summary.nodesInserted).toBe(3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('missing positional path → exit 64', async () => {
    const opts = makeOpts({ clientFactory: () => fakeClient(() => Promise.resolve(IMPORT_OK)) });
    const exit = await runImportSekkei(parseCommandLine(['import-sekkei', '--slug=demo']), opts);
    expect(exit).toBe(64);
    expect((opts.stderr as StringStream).buffer).toContain('YAML file path is required');
  });

  test('missing --slug → exit 64', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-import-'));
    const file = join(tmp, 's.yaml');
    writeFileSync(file, 'x', 'utf8');
    try {
      const opts = makeOpts({ clientFactory: () => fakeClient(() => Promise.resolve(IMPORT_OK)) });
      const exit = await runImportSekkei(parseCommandLine(['import-sekkei', file]), opts);
      expect(exit).toBe(64);
      expect((opts.stderr as StringStream).buffer).toContain('--slug is required');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('non-existent file → exit 64', async () => {
    const opts = makeOpts({ clientFactory: () => fakeClient(() => Promise.resolve(IMPORT_OK)) });
    const exit = await runImportSekkei(
      parseCommandLine(['import-sekkei', '/no/such/file.yaml', '--slug=demo']),
      opts,
    );
    expect(exit).toBe(64);
    expect((opts.stderr as StringStream).buffer).toContain('file not found');
  });

  test('server unreachable → exit 69', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-import-'));
    const file = join(tmp, 's.yaml');
    writeFileSync(file, 'x', 'utf8');
    try {
      const opts = makeOpts({
        clientFactory: () =>
          fakeClient(() => Promise.reject(new ServerUnreachableError('http://localhost:3000'))),
      });
      const exit = await runImportSekkei(
        parseCommandLine(['import-sekkei', file, '--slug=demo']),
        opts,
      );
      expect(exit).toBe(69);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('HTTP 422 → exit 70', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-import-'));
    const file = join(tmp, 's.yaml');
    writeFileSync(file, 'invalid yaml here', 'utf8');
    try {
      const opts = makeOpts({
        clientFactory: () =>
          fakeClient(() => Promise.reject(new HttpError('http://x/import', 422, 'malformed yaml'))),
      });
      const exit = await runImportSekkei(
        parseCommandLine(['import-sekkei', file, '--slug=demo']),
        opts,
      );
      expect(exit).toBe(70);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
