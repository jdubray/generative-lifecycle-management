import { describe, expect, test } from 'bun:test';
import { runStatus } from '../../src/tools/status.ts';
import type { GlmClient, WorkspaceSummary } from '../../src/lib/glm-client.ts';
import type { ResolvedConfig } from '../../src/lib/config.ts';

function fakeClient(summary: WorkspaceSummary, capture?: (id: string) => void): GlmClient {
  return {
    baseUrl: 'http://localhost:3300',
    getWorkspaceSummary: async (id: string) => {
      capture?.(id);
      return summary;
    },
  } as unknown as GlmClient;
}

const SAMPLE_SUMMARY: WorkspaceSummary = {
  workspace: { id: 'ws-1', slug: 'demo', name: 'Demo Workspace' },
  nodesByStratum: { system: 1, capability: 4, component: 12, interaction: 7, spec: 33 },
  scrsByStatus: { open: 0, merged: 2 },
  driftByStatus: {},
  lastVerifier: {
    id: 'run-1',
    passed: true,
    completedAt: '2026-05-13T14:00:00Z',
    gateCount: 7,
    passCount: 7,
  },
};

const CONFIG: ResolvedConfig = {
  port: 3300,
  workspace: 'demo',
  token: 'tok',
  baseUrl: 'http://localhost:3300',
};

describe('glm_status tool', () => {
  test('renders the workspace summary as text content', async () => {
    const result = await runStatus({}, { client: fakeClient(SAMPLE_SUMMARY), config: CONFIG });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('demo');
    expect(text).toMatch(/component\s+12/);
    expect(text).toContain('Last verifier run');
    expect(text).toContain('7/7');
  });

  test('uses workspace from input when provided', async () => {
    let seenId = '';
    await runStatus(
      { workspace: 'other-ws' },
      { client: fakeClient(SAMPLE_SUMMARY, (id) => { seenId = id; }), config: CONFIG },
    );
    expect(seenId).toBe('other-ws');
  });

  test('falls back to config.workspace when input omits it', async () => {
    let seenId = '';
    await runStatus(
      {},
      { client: fakeClient(SAMPLE_SUMMARY, (id) => { seenId = id; }), config: CONFIG },
    );
    expect(seenId).toBe('demo');
  });

  test('omits "Last verifier run" block when summary has no verifier history', async () => {
    const summary: WorkspaceSummary = { ...SAMPLE_SUMMARY, lastVerifier: null };
    const result = await runStatus({}, { client: fakeClient(summary), config: CONFIG });
    expect(result.content[0]?.text).not.toContain('Last verifier');
  });
});
