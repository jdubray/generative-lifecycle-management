import { describe, expect, test } from 'bun:test';
import { runVerify, type RunVerifyOptions } from '../../src/commands/verify.ts';
import { parseCommandLine } from '../../src/lib/argv.ts';
import { GlmClient, type VerifierRun } from '../../src/lib/glm-client.ts';
import { HttpError, ServerUnreachableError } from '../../src/lib/errors.ts';

class StringStream {
  public buffer = '';
  write(chunk: string | Uint8Array): boolean {
    this.buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }
}

const PASS_RUN: VerifierRun = {
  id: 'run-1',
  workspaceId: 'default',
  ts: '2026-05-12T12:00:00Z',
  overallPass: true,
  gateResults: {
    gates: [
      { name: 'Envelope', passed: true, issues: [] },
      { name: 'Stratum hierarchy', passed: true, issues: [] },
      { name: 'Role consistency', passed: true, issues: [] },
      { name: 'Closure completeness', passed: true, issues: [] },
      { name: 'Brief coverage', passed: true, issues: [] },
      { name: 'Spec coverage', passed: true, issues: [] },
      { name: 'Spec quality', passed: true, issues: [] },
    ],
  },
};

function failRun(issues: string[] = ['missing field foo', 'bad id bar']): VerifierRun {
  return {
    id: 'run-2',
    workspaceId: 'default',
    ts: '2026-05-12T12:00:00Z',
    overallPass: false,
    gateResults: {
      gates: [
        { name: 'Envelope', passed: true, issues: [] },
        { name: 'Stratum hierarchy', passed: false, issues },
        { name: 'Role consistency', passed: true, issues: [] },
        { name: 'Closure completeness', passed: true, issues: [] },
        { name: 'Brief coverage', passed: true, issues: [] },
        { name: 'Spec coverage', passed: true, issues: [] },
        { name: 'Spec quality', passed: true, issues: [] },
      ],
    },
  };
}

function fakeClient(impl: () => Promise<VerifierRun>): GlmClient {
  const c = Object.create(GlmClient.prototype) as GlmClient;
  Object.assign(c, { runVerifier: impl });
  return c;
}

function makeOpts(extra: Partial<RunVerifyOptions> = {}): RunVerifyOptions & {
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
    colorEnabled: false, // deterministic output in tests
    ...extra,
  };
}

describe('glm verify', () => {
  test('all gates pass → prints PASS summary and exits 0', async () => {
    const opts = makeOpts({ clientFactory: () => fakeClient(() => Promise.resolve(PASS_RUN)) });
    const exit = await runVerify(parseCommandLine(['verify']), opts);
    expect(exit).toBe(0);
    const out = (opts.stdout as StringStream).buffer;
    expect(out).toContain('Verifier run run-1');
    expect(out).toContain('✓ gate 1: Envelope');
    expect(out).toContain('✓ gate 7: Spec quality');
    expect(out).toContain('PASS: 7/7 gates passed');
    expect(out).not.toContain('FAIL');
  });

  test('one gate fails → exit 1 and FAIL summary with issue list', async () => {
    const opts = makeOpts({ clientFactory: () => fakeClient(() => Promise.resolve(failRun())) });
    const exit = await runVerify(parseCommandLine(['verify']), opts);
    expect(exit).toBe(1);
    const out = (opts.stdout as StringStream).buffer;
    expect(out).toContain('✗ gate 2: Stratum hierarchy');
    expect(out).toContain('missing field foo');
    expect(out).toContain('bad id bar');
    expect(out).toContain('FAIL: 6/7 gates passed');
  });

  test('issue list is capped at 5 by default; --verbose shows all', async () => {
    const manyIssues = Array.from({ length: 12 }, (_, i) => `issue ${i + 1}`);
    const factory = () => fakeClient(() => Promise.resolve(failRun(manyIssues)));

    const opts1 = makeOpts({ clientFactory: factory });
    await runVerify(parseCommandLine(['verify']), opts1);
    const out1 = (opts1.stdout as StringStream).buffer;
    expect(out1).toContain('issue 5');
    expect(out1).not.toContain('issue 6');
    expect(out1).toContain('… 7 more (use --verbose');

    const opts2 = makeOpts({ clientFactory: factory });
    await runVerify(parseCommandLine(['verify', '--verbose']), opts2);
    const out2 = (opts2.stdout as StringStream).buffer;
    expect(out2).toContain('issue 12');
    expect(out2).not.toContain('use --verbose');
  });

  test('--json emits a single JSON line and exit 0/1 matches overallPass', async () => {
    const optsPass = makeOpts({ clientFactory: () => fakeClient(() => Promise.resolve(PASS_RUN)) });
    expect(await runVerify(parseCommandLine(['verify', '--json']), optsPass)).toBe(0);
    const parsedPass = JSON.parse((optsPass.stdout as StringStream).buffer.trim());
    expect(parsedPass.overallPass).toBe(true);

    const optsFail = makeOpts({ clientFactory: () => fakeClient(() => Promise.resolve(failRun())) });
    expect(await runVerify(parseCommandLine(['verify', '--json']), optsFail)).toBe(1);
    const parsedFail = JSON.parse((optsFail.stdout as StringStream).buffer.trim());
    expect(parsedFail.overallPass).toBe(false);
    expect(parsedFail.gateResults.gates[1].issues).toEqual(['missing field foo', 'bad id bar']);
  });

  test('server unreachable → exit 69', async () => {
    const opts = makeOpts({
      clientFactory: () =>
        fakeClient(() => Promise.reject(new ServerUnreachableError('http://localhost:3000'))),
    });
    const exit = await runVerify(parseCommandLine(['verify']), opts);
    expect(exit).toBe(69);
    expect((opts.stderr as StringStream).buffer).toContain('GLM server not responding');
  });

  test('workspace 404 → exit 66', async () => {
    const opts = makeOpts({
      clientFactory: () =>
        fakeClient(() =>
          Promise.reject(new HttpError('http://x/verify', 404, 'workspace not found')),
        ),
    });
    const exit = await runVerify(parseCommandLine(['verify']), opts);
    expect(exit).toBe(66);
  });

  test('color output emits ANSI codes when colorEnabled=true', async () => {
    const opts = makeOpts({
      clientFactory: () => fakeClient(() => Promise.resolve(PASS_RUN)),
      colorEnabled: true,
    });
    await runVerify(parseCommandLine(['verify']), opts);
    const out = (opts.stdout as StringStream).buffer;
    expect(out).toContain('\x1b[32m'); // green for ✓
    expect(out).toContain('\x1b[0m'); // reset
  });

  test('--no-color suppresses ANSI even when colorEnabled is unspecified', async () => {
    // colorEnabled left undefined → falls back to auto-detect from stream + flags.
    // The StringStream has no isTTY → no color anyway, but assert flag works too.
    const opts = makeOpts({
      clientFactory: () => fakeClient(() => Promise.resolve(PASS_RUN)),
      colorEnabled: undefined,
    });
    await runVerify(parseCommandLine(['verify', '--no-color']), opts);
    const out = (opts.stdout as StringStream).buffer;
    expect(out).not.toContain('\x1b[');
  });
});
