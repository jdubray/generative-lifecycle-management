/**
 * P3-C: Unit tests for `glm export-sekkei`.
 *
 * Tests the CLI command layer — GlmClient is stubbed so no real HTTP.
 */

import { describe, expect, test } from 'bun:test';
import { runExport, type RunExportOptions } from '../../src/commands/export-sekkei.ts';
import { GlmClient } from '../../src/lib/glm-client.ts';
import { parseCommandLine } from '../../src/lib/argv.ts';

const FAKE_YAML = `---\nid: acme:web\nstratum: system\n`;

class StringStream {
  public buffer = '';
  write(chunk: string | Uint8Array): boolean {
    this.buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }
}

function fakeClient(yaml: string): GlmClient {
  const client = Object.create(GlmClient.prototype) as GlmClient;
  Object.assign(client, {
    exportWorkspace: async (_workspaceId: string) => yaml,
  });
  return client;
}

function makeOpts(extra: Partial<RunExportOptions> = {}): RunExportOptions & {
  stdout: StringStream;
  stderr: StringStream;
} {
  const stdout = new StringStream();
  const stderr = new StringStream();
  return {
    io: { stdout, stderr },
    stdout,
    stderr,
    resolveOverrides: { env: { GLM_WORKSPACE: 'demo', GLM_BASE_URL: 'http://localhost:3000' }, fileExists: () => false, readFile: () => '' },
    ...extra,
  };
}

describe('P3-C: glm export-sekkei', () => {
  test('writes YAML to stdout when no --out flag', async () => {
    const opts = makeOpts({ clientFactory: () => fakeClient(FAKE_YAML) });
    const exit = await runExport(parseCommandLine(['export-sekkei']), opts);
    expect(exit).toBe(0);
    expect(opts.stdout.buffer).toContain('id: acme:web');
  });

  test('writes YAML to --out file and prints path on stderr', async () => {
    const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmp = mkdtempSync(join(tmpdir(), 'glm-export-test-'));
    const outFile = join(tmp, 'export.yaml');
    try {
      const opts = makeOpts({ clientFactory: () => fakeClient(FAKE_YAML) });
      const exit = await runExport(
        parseCommandLine(['export-sekkei', '--out', outFile]),
        opts,
      );
      expect(exit).toBe(0);
      const written = readFileSync(outFile, 'utf8');
      expect(written).toContain('id: acme:web');
      expect(opts.stderr.buffer).toContain(outFile);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('exits 1 when server returns unexpected error', async () => {
    const client = Object.create(GlmClient.prototype) as GlmClient;
    Object.assign(client, {
      exportWorkspace: async () => { throw new Error('boom'); },
    });
    const opts = makeOpts({ clientFactory: () => client });
    const exit = await runExport(parseCommandLine(['export-sekkei']), opts);
    expect(exit).toBe(1);
    expect(opts.stderr.buffer).toContain('boom');
  });

  test('exits 69 when server is unreachable', async () => {
    const client = Object.create(GlmClient.prototype) as GlmClient;
    Object.assign(client, {
      exportWorkspace: async () => {
        const { ServerUnreachableError } = await import('../../src/lib/errors.ts');
        throw new ServerUnreachableError('http://localhost:3000', new Error('ECONNREFUSED'));
      },
    });
    const opts = makeOpts({ clientFactory: () => client });
    const exit = await runExport(parseCommandLine(['export-sekkei']), opts);
    expect(exit).toBe(69);
  });

  test('exportWorkspace client method is wired to the correct URL path', async () => {
    let capturedPath = '';
    const mockFetch = async (url: string) => {
      capturedPath = url;
      return new Response(FAKE_YAML, {
        headers: { 'Content-Type': 'text/yaml' },
      });
    };
    const client = new GlmClient({ baseUrl: 'http://localhost:3000', token: 'tok', fetch: mockFetch });
    const yaml = await client.exportWorkspace('ws-demo');
    expect(capturedPath).toBe('http://localhost:3000/api/v1/workspaces/ws-demo/export');
    expect(yaml).toBe(FAKE_YAML);
  });
});
