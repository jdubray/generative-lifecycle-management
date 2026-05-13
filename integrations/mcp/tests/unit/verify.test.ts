import { describe, expect, test } from 'bun:test';
import { runVerify } from '../../src/tools/verify.ts';
import type { GlmClient, VerifierRun } from '../../src/lib/glm-client.ts';
import type { ResolvedConfig } from '../../src/lib/config.ts';

const CONFIG: ResolvedConfig = {
  port: 3300,
  workspace: 'demo',
  token: 'tok',
  baseUrl: 'http://localhost:3300',
};

function fakeClient(run: VerifierRun, capture?: (ws: string) => void): GlmClient {
  return {
    baseUrl: 'http://localhost:3300',
    runVerifier: async (ws: string) => {
      capture?.(ws);
      return run;
    },
  } as unknown as GlmClient;
}

const PASS_RUN: VerifierRun = {
  id: 'run-1',
  workspaceId: 'ws-1',
  ts: '2026-05-13T15:00:00Z',
  overallPass: true,
  gateResults: {
    gates: [
      { name: 'envelope', passed: true, issues: [] },
      { name: 'stratum-hierarchy', passed: true, issues: [] },
      { name: 'role-consistency', passed: true, issues: [] },
      { name: 'closure-completeness', passed: true, issues: [] },
      { name: 'brief-coverage', passed: true, issues: [] },
      { name: 'spec-coverage', passed: true, issues: [] },
      { name: 'spec-quality', passed: true, issues: [] },
    ],
  },
};

const FAIL_RUN: VerifierRun = {
  id: 'run-2',
  workspaceId: 'ws-1',
  ts: '2026-05-13T15:01:00Z',
  overallPass: false,
  gateResults: {
    gates: [
      { name: 'envelope', passed: true, issues: [] },
      {
        name: 'spec-coverage',
        passed: false,
        issues: [
          'component acme:web.shop.cart.cart_manager missing spec.prompt',
          'component acme:web.shop.cart.cart_manager missing spec.acceptance',
        ],
      },
    ],
  },
};

describe('glm_verify tool', () => {
  test('renders PASS summary with gate counts', async () => {
    const result = await runVerify({}, { client: fakeClient(PASS_RUN), config: CONFIG });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('PASS');
    expect(text).toContain('7/7 gates');
    expect(text).toContain('Verifier run run-1');
    expect(text).toContain('[PASS] envelope');
  });

  test('renders FAIL with per-issue detail for failing gates', async () => {
    const result = await runVerify({}, { client: fakeClient(FAIL_RUN), config: CONFIG });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('FAIL');
    expect(text).toContain('1/2 gates');
    expect(text).toContain('[FAIL] spec-coverage');
    expect(text).toContain('(2 issues)');
    expect(text).toContain('missing spec.prompt');
    expect(text).toContain('missing spec.acceptance');
  });

  test('uses input workspace when provided', async () => {
    let seen = '';
    await runVerify(
      { workspace: 'other-ws' },
      { client: fakeClient(PASS_RUN, (ws) => { seen = ws; }), config: CONFIG },
    );
    expect(seen).toBe('other-ws');
  });
});
