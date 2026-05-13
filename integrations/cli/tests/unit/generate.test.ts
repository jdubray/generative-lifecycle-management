import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGenerate, type RunGenerateOptions } from '../../src/commands/generate.ts';
import { parseCommandLine } from '../../src/lib/argv.ts';
import {
  GlmClient,
  type AcceptanceVerifyResult,
  type ComponentSpecPayload,
  type ProvenanceEvent,
} from '../../src/lib/glm-client.ts';
import { HttpError, ServerUnreachableError } from '../../src/lib/errors.ts';

class StringStream {
  public buffer = '';
  write(chunk: string | Uint8Array): boolean {
    this.buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }
}

const COMPONENT = 'acme:web.shop.catalog.product_repository';

function sampleSpec(sourceDir: string | null): ComponentSpecPayload {
  return {
    component: {
      id: 'node-comp',
      glmId: COMPONENT,
      stratum: 'component',
      title: 'Product repository',
      description: '',
      revisionStatus: 'in_work',
      body: { boundary: 'products', runtime: 'in_process' },
      contentHash: 'sha256:component',
    },
    specPrompt: {
      id: 'node-prompt',
      glmId: `${COMPONENT}.spec.prompt`,
      stratum: 'spec',
      title: 'prompt',
      description: '',
      revisionStatus: 'in_work',
      body: {},
      contentHash: 'sha256:prompt',
    },
    specAcceptance: {
      id: 'node-acc',
      glmId: `${COMPONENT}.spec.acceptance`,
      stratum: 'spec',
      title: 'acceptance',
      description: '',
      revisionStatus: 'in_work',
      body: {},
      contentHash: 'sha256:acc',
    },
    outputs: [
      { path: 'src/repository.ts', description: 'repo module' },
      { path: 'test/repository.test.ts', description: 'repo tests' },
    ],
    contextBundle: { text: '# acme:web.shop\n{}', bindingHash: 'sha256:bundle' },
    hardConstraints: 'HARD CONSTRAINTS: ...',
    sourceDir,
    promptTemplate: 'You are generating the product repository.',
    verifierCommand: 'bun test test/repository.test.ts',
  };
}

const SAMPLE_CLAUDE_OUTPUT = [
  '=== FILE: src/repository.ts ===',
  'export class Repository {}',
  '=== FILE: test/repository.test.ts ===',
  "import { test } from 'bun:test';",
  "test('placeholder', () => {});",
].join('\n');

const SAMPLE_PROV: ProvenanceEvent = {
  id: 'prov-1',
  workspaceId: 'demo',
  occurredAt: '2026-05-13T17:00:00Z',
  subjectFile: 'src/repository.ts,test/repository.test.ts',
  subjectDigest: 'sha256:agg',
  sekkeiRoot: COMPONENT,
  sekkeiRev: 'sha256:component',
  bindingHash: 'sha256:bundle',
  generatorLlm: 'claude-cli/claude-sonnet-4-6',
  generatorPromptVersion: 'sha256:prompt',
  durationMs: 42_000,
  note: null,
};

function fakeClient(overrides: Partial<{
  getComponentSpec: GlmClient['getComponentSpec'];
  runAcceptanceVerify: GlmClient['runAcceptanceVerify'];
  recordGeneration: GlmClient['recordGeneration'];
  setSourceDir: GlmClient['setSourceDir'];
}>): GlmClient {
  const c = Object.create(GlmClient.prototype) as GlmClient;
  const defaults = {
    getComponentSpec: async () => sampleSpec('/tmp/will-be-replaced'),
    runAcceptanceVerify: async () =>
      ({
        command: 'bun test',
        cwd: '/tmp/x',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        durationMs: 200,
      } as AcceptanceVerifyResult),
    recordGeneration: async () => SAMPLE_PROV,
    setSourceDir: async () => undefined,
  };
  Object.assign(c, { ...defaults, ...overrides });
  return c;
}

function makeOpts(extra: Partial<RunGenerateOptions> = {}): RunGenerateOptions & {
  stdout: StringStream;
  stderr: StringStream;
  tmpSourceDir: string;
} {
  const stdout = new StringStream();
  const stderr = new StringStream();
  const tmpSourceDir = mkdtempSync(join(tmpdir(), 'glm-gen-test-'));
  return {
    io: { stdout, stderr },
    stdout,
    stderr,
    tmpSourceDir,
    resolveOverrides: { env: {}, fileExists: () => false, readFile: () => '' },
    colorEnabled: false,
    claudeRunner: async () => ({ stdout: SAMPLE_CLAUDE_OUTPUT, stderr: '' }),
    ...extra,
  };
}

describe('glm generate', () => {
  let tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs = [];
  });

  test('happy path: fetches spec → spawns claude → writes files → verifier → provenance', async () => {
    const opts = makeOpts();
    tmpDirs.push(opts.tmpSourceDir);
    const spec = sampleSpec(opts.tmpSourceDir);
    let recordedFiles: Array<{ path: string; sha256: string; bytes: number }> = [];
    const client = fakeClient({
      getComponentSpec: async () => spec,
      recordGeneration: async (_w, req) => {
        recordedFiles = req.files;
        return SAMPLE_PROV;
      },
    });

    const exit = await runGenerate(
      parseCommandLine(['generate', `--component=${COMPONENT}`]),
      { ...opts, clientFactory: () => client },
    );
    expect(exit).toBe(0);

    // Files actually written to source_dir.
    expect(statSync(join(opts.tmpSourceDir, 'src/repository.ts')).isFile()).toBe(true);
    expect(readFileSync(join(opts.tmpSourceDir, 'src/repository.ts'), 'utf8')).toContain('export class Repository');
    expect(statSync(join(opts.tmpSourceDir, 'test/repository.test.ts')).isFile()).toBe(true);

    // recordGeneration received per-file hashes + bytes.
    expect(recordedFiles).toHaveLength(2);
    expect(recordedFiles[0]?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Pretty output.
    const out = (opts.stdout as StringStream).buffer;
    expect(out).toContain(`Generated ${COMPONENT}`);
    expect(out).toContain('files:       2');
    expect(out).toContain('verifier:    PASS');
    expect(out).toContain('provenance:  prov-1');
  });

  test('--json emits a single JSON line on stdout', async () => {
    const opts = makeOpts();
    tmpDirs.push(opts.tmpSourceDir);
    const exit = await runGenerate(
      parseCommandLine(['generate', `--component=${COMPONENT}`, '--json']),
      {
        ...opts,
        clientFactory: () => fakeClient({ getComponentSpec: async () => sampleSpec(opts.tmpSourceDir) }),
      },
    );
    expect(exit).toBe(0);
    const out = (opts.stdout as StringStream).buffer;
    expect(out.trim().startsWith('{')).toBe(true);
    const parsed = JSON.parse(out.trim());
    expect(parsed.componentGlmId).toBe(COMPONENT);
    expect(parsed.filesWritten.length).toBe(2);
    expect(parsed.provenance.id).toBe('prov-1');
  });

  test('missing --component → exit 64', async () => {
    const opts = makeOpts();
    tmpDirs.push(opts.tmpSourceDir);
    const exit = await runGenerate(parseCommandLine(['generate']), {
      ...opts,
      clientFactory: () => fakeClient({}),
    });
    expect(exit).toBe(64);
    expect((opts.stderr as StringStream).buffer).toContain('--component is required');
  });

  test('--source-dir is absolutized + persisted via PATCH before spec fetch', async () => {
    let setSourceDirCalled: string | undefined;
    const opts = makeOpts();
    tmpDirs.push(opts.tmpSourceDir);
    const abs = process.platform === 'win32' ? 'C:\\tmp\\proj' : '/tmp/proj';
    const client = fakeClient({
      // After PATCH, the spec endpoint returns the new source_dir.
      getComponentSpec: async () => sampleSpec(opts.tmpSourceDir),
      setSourceDir: async (_w, sd) => {
        setSourceDirCalled = sd;
      },
    });
    await runGenerate(
      parseCommandLine(['generate', `--component=${COMPONENT}`, `--source-dir=${abs}`]),
      { ...opts, clientFactory: () => client },
    );
    expect(setSourceDirCalled).toBe(abs);
  });

  test('--dry-run skips verifier + provenance, files land in a temp dir', async () => {
    const opts = makeOpts();
    tmpDirs.push(opts.tmpSourceDir);
    let verifierCalled = false;
    let provenanceCalled = false;
    const client = fakeClient({
      getComponentSpec: async () => sampleSpec(opts.tmpSourceDir),
      runAcceptanceVerify: async () => {
        verifierCalled = true;
        throw new Error('should not call');
      },
      recordGeneration: async () => {
        provenanceCalled = true;
        throw new Error('should not call');
      },
    });
    const exit = await runGenerate(
      parseCommandLine(['generate', `--component=${COMPONENT}`, '--dry-run']),
      { ...opts, clientFactory: () => client },
    );
    expect(exit).toBe(0);
    expect(verifierCalled).toBe(false);
    expect(provenanceCalled).toBe(false);
    const out = (opts.stdout as StringStream).buffer;
    expect(out).toContain('(dry-run)');
    expect(out).toContain('(skipped — dry-run)');
  });

  test('spec without sourceDir + no --source-dir override → exit 66', async () => {
    const opts = makeOpts();
    tmpDirs.push(opts.tmpSourceDir);
    const exit = await runGenerate(
      parseCommandLine(['generate', `--component=${COMPONENT}`]),
      {
        ...opts,
        clientFactory: () => fakeClient({ getComponentSpec: async () => sampleSpec(null) }),
      },
    );
    expect(exit).toBe(66);
    expect((opts.stderr as StringStream).buffer).toContain('source_dir');
  });

  test('verifier non-zero exit → exit 1 with stderr summary', async () => {
    const opts = makeOpts();
    tmpDirs.push(opts.tmpSourceDir);
    const exit = await runGenerate(
      parseCommandLine(['generate', `--component=${COMPONENT}`]),
      {
        ...opts,
        clientFactory: () =>
          fakeClient({
            getComponentSpec: async () => sampleSpec(opts.tmpSourceDir),
            runAcceptanceVerify: async () =>
              ({
                command: 'bun test',
                cwd: opts.tmpSourceDir,
                exitCode: 2,
                stdout: '',
                stderr: 'TypeError: undefined is not a function',
                durationMs: 1000,
              } as AcceptanceVerifyResult),
          }),
      },
    );
    expect(exit).toBe(1);
    expect((opts.stderr as StringStream).buffer).toContain('TypeError');
  });

  test('claude returns prose (no FILE markers) → exit 70 GenerateError', async () => {
    const opts = makeOpts({
      claudeRunner: async () => ({ stdout: 'Sure, here are the files...', stderr: '' }),
    });
    tmpDirs.push(opts.tmpSourceDir);
    const exit = await runGenerate(
      parseCommandLine(['generate', `--component=${COMPONENT}`]),
      {
        ...opts,
        clientFactory: () => fakeClient({ getComponentSpec: async () => sampleSpec(opts.tmpSourceDir) }),
      },
    );
    expect(exit).toBe(70);
    expect((opts.stderr as StringStream).buffer).toContain('no `=== FILE');
  });

  test('server unreachable on getComponentSpec → exit 69', async () => {
    const opts = makeOpts();
    tmpDirs.push(opts.tmpSourceDir);
    const exit = await runGenerate(
      parseCommandLine(['generate', `--component=${COMPONENT}`]),
      {
        ...opts,
        clientFactory: () =>
          fakeClient({
            getComponentSpec: async () => {
              throw new ServerUnreachableError('http://localhost:3000', new Error('connect refused'));
            },
          }),
      },
    );
    expect(exit).toBe(69);
    expect((opts.stderr as StringStream).buffer).toContain('not responding');
  });

  test('HTTP 404 from getComponentSpec → exit 66 (no-input)', async () => {
    const opts = makeOpts();
    tmpDirs.push(opts.tmpSourceDir);
    const exit = await runGenerate(
      parseCommandLine(['generate', '--component=acme:no-such']),
      {
        ...opts,
        clientFactory: () =>
          fakeClient({
            getComponentSpec: async () => {
              throw new HttpError('http://x/spec', 404, 'component not found');
            },
          }),
      },
    );
    expect(exit).toBe(66);
  });

  test('HTTP 422 from acceptance-verify → exit 70', async () => {
    const opts = makeOpts();
    tmpDirs.push(opts.tmpSourceDir);
    const exit = await runGenerate(
      parseCommandLine(['generate', `--component=${COMPONENT}`]),
      {
        ...opts,
        clientFactory: () =>
          fakeClient({
            getComponentSpec: async () => sampleSpec(opts.tmpSourceDir),
            runAcceptanceVerify: async () => {
              throw new HttpError('http://x/acceptance-verify', 422, 'bad shape');
            },
          }),
      },
    );
    expect(exit).toBe(70);
  });
});
