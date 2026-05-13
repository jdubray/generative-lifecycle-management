import { describe, expect, test } from 'bun:test';
import { runStatus, type RunStatusOptions } from '../../src/commands/status.ts';
import { GlmClient, type WorkspaceSummary } from '../../src/lib/glm-client.ts';
import { HttpError, ServerUnreachableError } from '../../src/lib/errors.ts';
import { parseCommandLine } from '../../src/lib/argv.ts';

class StringStream {
  public buffer = '';
  write(chunk: string | Uint8Array): boolean {
    this.buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }
}

const HEALTH = { ok: true, service: 'glm', version: '1.0.0' };

const SAMPLE_SUMMARY: WorkspaceSummary = {
  workspace: { id: 'default', slug: 'default', name: 'Default' },
  nodesByStratum: { system: 1, capability: 3, component: 7, interaction: 2, spec: 18 },
  scrsByStatus: { Submitted: 2, 'Under Review': 1, Approved: 0 },
  driftByStatus: { Synced: 5, 'Hash-Drifted': 1, 'Live-Drifted': 0, Suspended: 0 },
  lastVerifier: { id: 'v-1', passed: true, completedAt: '2026-05-12T10:00:00Z', gateCount: 6, passCount: 6 },
};

/** Build a fake GlmClient whose methods return canned values or throw. */
function fakeClient(responses: {
  health?: () => Promise<typeof HEALTH>;
  summary?: () => Promise<WorkspaceSummary>;
}): GlmClient {
  const client = Object.create(GlmClient.prototype) as GlmClient;
  Object.assign(client, {
    health: responses.health ?? (() => Promise.resolve(HEALTH)),
    getWorkspaceSummary: responses.summary ?? (() => Promise.resolve(SAMPLE_SUMMARY)),
    getWorkspace: () => Promise.resolve(SAMPLE_SUMMARY.workspace),
  });
  return client;
}

/** Inject empty env + no config file so tests don't pick up the developer's real config. */
function makeOpts(extra: Partial<RunStatusOptions> = {}): RunStatusOptions {
  const stdout = new StringStream();
  const stderr = new StringStream();
  return {
    io: { stdout, stderr },
    resolveOverrides: { env: {}, fileExists: () => false, readFile: () => '' },
    ...extra,
  };
}

describe('glm status', () => {
  test('prints health + workspace summary and exits 0', async () => {
    const opts = makeOpts({ clientFactory: () => fakeClient({}) });
    const exit = await runStatus(parseCommandLine(['status']), opts);
    const out = (opts.io!.stdout as StringStream).buffer;
    expect(exit).toBe(0);
    expect(out).toContain('Server:');
    expect(out).toContain('glm 1.0.0');
    expect(out).toContain('Workspace:');
    expect(out).toContain('default');
    expect(out).toContain('Nodes:      31 total');
    expect(out).toContain('SCRs:       3 active');
    expect(out).toContain('Drift:      1 open');
    expect(out).toContain('Verifier:   PASS');
  });

  test('--json emits a single line of JSON with the full payload', async () => {
    const opts = makeOpts({ clientFactory: () => fakeClient({}) });
    const exit = await runStatus(parseCommandLine(['status', '--json']), opts);
    const out = (opts.io!.stdout as StringStream).buffer;
    expect(exit).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed.workspace).toBe('default');
    expect(parsed.health.version).toBe('1.0.0');
    expect(parsed.summary.nodesByStratum.system).toBe(1);
  });

  test('server unreachable → exit 69 with helpful message on stderr', async () => {
    const opts = makeOpts({
      clientFactory: () =>
        fakeClient({ health: () => Promise.reject(new ServerUnreachableError('http://localhost:3000')) }),
    });
    const exit = await runStatus(parseCommandLine(['status']), opts);
    expect(exit).toBe(69);
    expect((opts.io!.stderr as StringStream).buffer).toContain('GLM server not responding');
    expect((opts.io!.stdout as StringStream).buffer).toBe('');
  });

  test('summary 404 still prints health and exits 66', async () => {
    const opts = makeOpts({
      clientFactory: () =>
        fakeClient({
          summary: () => Promise.reject(new HttpError('http://x/summary', 404, 'workspace not found')),
        }),
    });
    const exit = await runStatus(parseCommandLine(['status']), opts);
    expect(exit).toBe(66);
    const out = (opts.io!.stdout as StringStream).buffer;
    expect(out).toContain('Server:');
    expect(out).toContain('Workspace summary: unavailable');
  });

  test('summary 401 → exit 77 (auth)', async () => {
    const opts = makeOpts({
      clientFactory: () =>
        fakeClient({
          summary: () => Promise.reject(new HttpError('http://x/summary', 401, 'unauthorized')),
        }),
    });
    const exit = await runStatus(parseCommandLine(['status']), opts);
    expect(exit).toBe(77);
  });

  test('shows "no token (anonymous)" when token is unset', async () => {
    const opts = makeOpts({ clientFactory: () => fakeClient({}) });
    await runStatus(parseCommandLine(['status']), opts);
    expect((opts.io!.stdout as StringStream).buffer).toContain('no token (anonymous)');
  });

  test('shows "token configured" when token is provided via --token', async () => {
    const opts = makeOpts({ clientFactory: () => fakeClient({}) });
    await runStatus(parseCommandLine(['status', '--token', 'abc123']), opts);
    expect((opts.io!.stdout as StringStream).buffer).toContain('token configured');
  });

  test('shows "token configured" when token is in env', async () => {
    const opts = makeOpts({
      clientFactory: () => fakeClient({}),
      resolveOverrides: { env: { GLM_SOLO_TOKEN: 'env-token' }, fileExists: () => false, readFile: () => '' },
    });
    await runStatus(parseCommandLine(['status']), opts);
    expect((opts.io!.stdout as StringStream).buffer).toContain('token configured');
  });

  test('honors --port flag in the resolved baseUrl', async () => {
    let capturedBaseUrl = '';
    const opts = makeOpts({
      clientFactory: (cfg) => {
        capturedBaseUrl = cfg.baseUrl;
        return fakeClient({});
      },
    });
    await runStatus(parseCommandLine(['status', '--port=4444']), opts);
    expect(capturedBaseUrl).toBe('http://localhost:4444');
  });
});
