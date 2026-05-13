import { describe, expect, test } from 'bun:test';
import { runGenerate, type RunGenerateOptions } from '../../src/commands/generate.ts';
import { parseCommandLine } from '../../src/lib/argv.ts';
import { GlmClient, type SoloGenerateResult } from '../../src/lib/glm-client.ts';
import { HttpError, ServerUnreachableError } from '../../src/lib/errors.ts';

class StringStream {
  public buffer = '';
  write(chunk: string | Uint8Array): boolean {
    this.buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }
}

const SAMPLE_RESULT: SoloGenerateResult = {
  componentGlmId: 'acme:web.shop.catalog.product_repository',
  outputDir: '/tmp/acme-shop',
  dryRun: false,
  filesWritten: [
    { path: 'src/repository.ts', bytes: 1234, sha256: 'sha256:abc' },
    { path: 'test/repository.test.ts', bytes: 567, sha256: 'sha256:def' },
  ],
  verifier: { command: 'bun test', exitCode: 0, stdout: 'ok', stderr: '' },
  provenance: { id: 'prov-1', subjectDigest: 'sha256:agg' },
  durationMs: 42_000,
};

function fakeClient(impl: () => Promise<SoloGenerateResult>): GlmClient {
  const c = Object.create(GlmClient.prototype) as GlmClient;
  Object.assign(c, { soloGenerate: impl });
  return c;
}

function makeOpts(extra: Partial<RunGenerateOptions> = {}): RunGenerateOptions & {
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
    colorEnabled: false,
    ...extra,
  };
}

describe('glm generate', () => {
  test('happy path: prints summary, exits 0', async () => {
    const opts = makeOpts({ clientFactory: () => fakeClient(() => Promise.resolve(SAMPLE_RESULT)) });
    const exit = await runGenerate(
      parseCommandLine(['generate', '--component=acme:web.shop.catalog.product_repository']),
      opts,
    );
    expect(exit).toBe(0);
    const out = (opts.stdout as StringStream).buffer;
    expect(out).toContain('Generated acme:web.shop.catalog.product_repository');
    expect(out).toContain('src/repository.ts');
    expect(out).toContain('test/repository.test.ts');
    expect(out).toContain('verifier:    PASS');
    expect(out).toContain('provenance:  prov-1');
    // Progress message goes to stderr so --json pipes stay clean.
    expect((opts.stderr as StringStream).buffer).toContain('invoking');
    expect(out).not.toContain('invoking');
  });

  test('--json emits a single JSON line on stdout', async () => {
    const opts = makeOpts({ clientFactory: () => fakeClient(() => Promise.resolve(SAMPLE_RESULT)) });
    const exit = await runGenerate(
      parseCommandLine([
        'generate',
        '--component=acme:web.shop.catalog.product_repository',
        '--json',
      ]),
      opts,
    );
    expect(exit).toBe(0);
    const out = (opts.stdout as StringStream).buffer;
    expect(out.trim().startsWith('{')).toBe(true);
    const parsed = JSON.parse(out.trim());
    expect(parsed.componentGlmId).toBe('acme:web.shop.catalog.product_repository');
    expect(parsed.filesWritten.length).toBe(2);
  });

  test('missing --component → exit 64', async () => {
    const opts = makeOpts({ clientFactory: () => fakeClient(() => Promise.resolve(SAMPLE_RESULT)) });
    const exit = await runGenerate(parseCommandLine(['generate']), opts);
    expect(exit).toBe(64);
    expect((opts.stderr as StringStream).buffer).toContain('--component is required');
  });

  test('--source-dir is sent absolute to the server', async () => {
    let captured: { sourceDir?: string; componentGlmId?: string } = {};
    const opts = makeOpts({
      clientFactory: () => {
        const c = Object.create(GlmClient.prototype) as GlmClient;
        Object.assign(c, {
          soloGenerate: (_wsId: string, req: { sourceDir?: string; componentGlmId: string }) => {
            captured = { sourceDir: req.sourceDir, componentGlmId: req.componentGlmId };
            return Promise.resolve(SAMPLE_RESULT);
          },
        });
        return c;
      },
    });
    // Use an absolute path to keep the test deterministic across platforms.
    const abs = process.platform === 'win32' ? 'C:\\tmp\\proj' : '/tmp/proj';
    await runGenerate(
      parseCommandLine([
        'generate',
        '--component=acme:web.shop.catalog.product_repository',
        `--source-dir=${abs}`,
      ]),
      opts,
    );
    expect(captured.sourceDir).toBe(abs);
    expect(captured.componentGlmId).toBe('acme:web.shop.catalog.product_repository');
  });

  test('--dry-run is forwarded to the client', async () => {
    let capturedDryRun: boolean | undefined;
    const dryResult: SoloGenerateResult = {
      ...SAMPLE_RESULT,
      dryRun: true,
      provenance: null,
    };
    const opts = makeOpts({
      clientFactory: () => {
        const c = Object.create(GlmClient.prototype) as GlmClient;
        Object.assign(c, {
          soloGenerate: (_wsId: string, req: { dryRun?: boolean }) => {
            capturedDryRun = req.dryRun;
            return Promise.resolve(dryResult);
          },
        });
        return c;
      },
    });
    const exit = await runGenerate(
      parseCommandLine([
        'generate',
        '--component=acme:web.shop.catalog.product_repository',
        '--dry-run',
      ]),
      opts,
    );
    expect(exit).toBe(0);
    expect(capturedDryRun).toBe(true);
    const out = (opts.stdout as StringStream).buffer;
    expect(out).toContain('(dry-run)');
    expect(out).toContain('(skipped — dry-run)');
  });

  test('server unreachable → exit 69', async () => {
    const opts = makeOpts({
      clientFactory: () =>
        fakeClient(() => Promise.reject(new ServerUnreachableError('http://localhost:3000'))),
    });
    const exit = await runGenerate(
      parseCommandLine(['generate', '--component=acme:web.shop.catalog.product_repository']),
      opts,
    );
    expect(exit).toBe(69);
    expect((opts.stderr as StringStream).buffer).toContain('GLM server not responding');
  });

  test('HTTP 422 (verifier failed server-side) → exit 70', async () => {
    const opts = makeOpts({
      clientFactory: () =>
        fakeClient(() =>
          Promise.reject(new HttpError('http://x/solo-generate', 422, 'verifier failed (exit 1)')),
        ),
    });
    const exit = await runGenerate(
      parseCommandLine(['generate', '--component=acme:web.shop.catalog.product_repository']),
      opts,
    );
    expect(exit).toBe(70);
  });

  test('HTTP 404 (component or workspace not found) → exit 66', async () => {
    const opts = makeOpts({
      clientFactory: () =>
        fakeClient(() =>
          Promise.reject(new HttpError('http://x/solo-generate', 404, 'component not found')),
        ),
    });
    const exit = await runGenerate(
      parseCommandLine(['generate', '--component=acme:no-such.component']),
      opts,
    );
    expect(exit).toBe(66);
  });
});
