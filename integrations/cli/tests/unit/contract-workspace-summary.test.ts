/**
 * P2-C — CLI/server contract test for GET /workspaces/:id/summary.
 *
 * The bug: `glm status` crashed with `Object.values of undefined` because
 * the CLI's `WorkspaceSummary` type had drifted from the actual server
 * response shape (ADR-0006 accepted this risk; this test materialises the
 * guard that was missing).
 *
 * Strategy: mirror the *exact* JSON the server emits (derived directly from
 * the `workspaces.ts` route handler) as a `CONTRACT_SHAPE` constant, then
 * assert that:
 *   1. The shape is assignable to `WorkspaceSummary` (TypeScript compile-time).
 *   2. `runStatus` can consume it without throwing (runtime).
 *   3. The specific field accesses that previously crashed work correctly.
 *
 * When the server's summary route changes its response shape, update
 * `CONTRACT_SHAPE` here first (TDD) — the failing test will tell you exactly
 * which CLI field broke.
 */

import { describe, expect, test } from 'bun:test';
import { runStatus, type RunStatusOptions } from '../../src/commands/status.ts';
import { GlmClient, type WorkspaceSummary } from '../../src/lib/glm-client.ts';
import { parseCommandLine } from '../../src/lib/argv.ts';

class StringStream {
  public buffer = '';
  write(chunk: string | Uint8Array): boolean {
    this.buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }
}

/**
 * Canonical shape of `GET /api/v1/workspaces/:id/summary` as emitted by
 * `src/server/routes/workspaces.ts`. This is the single source of truth for
 * the contract test. Update it whenever the server route changes.
 *
 * TypeScript compile-time assertion: the `satisfies WorkspaceSummary` below
 * will error if the CLI type no longer covers the server response.
 */
const CONTRACT_SHAPE = {
  workspace: { id: 'ws-uuid-1', slug: 'demo', name: 'Demo', createdAt: '2026-05-01T00:00:00Z' },
  nodes: {
    total: 31,
    byStratum: {
      system: 1,
      capability: 3,
      component: 7,
      interaction: 2,
      spec: 18,
    },
  },
  scrs: {
    active: 3,
    byStatus: {
      Draft: 0,
      Submitted: 2,
      'Under Review': 1,
      Approved: 0,
      Returned: 0,
      Rejected: 0,
      Implemented: 0,
      Released: 0,
    },
  },
  drift: {
    drifted: 1,
    byStatus: {
      Synced: 5,
      'Hash-Drifted': 1,
      'Live-Drifted': 0,
      Suspended: 0,
    },
  },
  generation: {
    eventsConsidered: 4,
    tokensIn: 12_000,
    tokensOut: 3_500,
    cacheHits: 2,
    cacheMisses: 2,
  },
  verifier: { id: 'vr-1', ts: '2026-05-14T10:00:00Z', overallPass: true },
  activity: [],
} satisfies WorkspaceSummary;
// ↑ TypeScript compile-time gate: if this line errors, the CLI type no longer
//   covers the server shape. Fix `WorkspaceSummary` in glm-client.ts.

const HEALTH = { ok: true, service: 'glm', version: '1.0.0' };

function fakeClientWithContract(summary: WorkspaceSummary): GlmClient {
  const client = Object.create(GlmClient.prototype) as GlmClient;
  Object.assign(client, {
    health: async () => HEALTH,
    getWorkspaceSummary: async () => summary,
    getWorkspace: async () => summary.workspace,
  });
  return client;
}

function makeOpts(extra: Partial<RunStatusOptions> = {}): RunStatusOptions & {
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

describe('P2-C: CLI/server WorkspaceSummary contract', () => {
  test('CONTRACT_SHAPE satisfies WorkspaceSummary (TypeScript compile-time check embedded above)', () => {
    // Runtime assertion: verify the shape is a plain object with the right keys.
    expect(typeof CONTRACT_SHAPE.nodes.total).toBe('number');
    expect(typeof CONTRACT_SHAPE.nodes.byStratum).toBe('object');
    expect(typeof CONTRACT_SHAPE.scrs.active).toBe('number');
    expect(typeof CONTRACT_SHAPE.drift.drifted).toBe('number');
    expect(typeof CONTRACT_SHAPE.generation.tokensIn).toBe('number');
    expect(CONTRACT_SHAPE.verifier).not.toBeNull();
  });

  test('runStatus renders CONTRACT_SHAPE without crashing', async () => {
    const opts = makeOpts({
      clientFactory: () => fakeClientWithContract(CONTRACT_SHAPE),
    });
    const exit = await runStatus(parseCommandLine(['status']), opts);
    expect(exit).toBe(0);
    const out = (opts.stdout as StringStream).buffer;
    expect(out).toContain('31 total');
    expect(out).toContain('PASS');
  });

  test('Object.entries(nodes.byStratum) works on the contract shape (regression for the crash)', () => {
    // Reproduces the exact operation that crashed: `Object.entries(summary.nodes.byStratum)`.
    const entries = Object.entries(CONTRACT_SHAPE.nodes.byStratum);
    expect(entries.length).toBeGreaterThan(0);
    for (const [stratum, count] of entries) {
      expect(typeof stratum).toBe('string');
      expect(typeof count).toBe('number');
    }
  });

  test('null verifier renders "never run" without crashing', async () => {
    const noVerifier: WorkspaceSummary = { ...CONTRACT_SHAPE, verifier: null };
    const opts = makeOpts({
      clientFactory: () => fakeClientWithContract(noVerifier),
    });
    const exit = await runStatus(parseCommandLine(['status']), opts);
    expect(exit).toBe(0);
    expect((opts.stdout as StringStream).buffer).toContain('never run');
  });

  test('generation fields are all numbers (guards against undefined tokensIn etc.)', () => {
    const gen = CONTRACT_SHAPE.generation;
    for (const [key, value] of Object.entries(gen)) {
      expect(typeof value, `generation.${key} should be a number`).toBe('number');
    }
  });

  test('--json mode serialises the contract shape without loss', async () => {
    const opts = makeOpts({
      clientFactory: () => fakeClientWithContract(CONTRACT_SHAPE),
    });
    const exit = await runStatus(parseCommandLine(['status', '--json']), opts);
    expect(exit).toBe(0);
    const raw = (opts.stdout as StringStream).buffer.trim();
    expect(raw.startsWith('{')).toBe(true);
    const parsed = JSON.parse(raw) as { summary: WorkspaceSummary };
    expect(parsed.summary.nodes.total).toBe(31);
    expect(parsed.summary.generation.tokensIn).toBe(12_000);
    expect(parsed.summary.verifier?.overallPass).toBe(true);
  });
});
