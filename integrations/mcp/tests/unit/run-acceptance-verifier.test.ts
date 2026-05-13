import { describe, expect, test } from 'bun:test';
import { runRunAcceptanceVerifier } from '../../src/tools/run-acceptance-verifier.ts';
import type { GlmClient, AcceptanceVerifyResult } from '../../src/lib/glm-client.ts';
import type { ResolvedConfig } from '../../src/lib/config.ts';

const CONFIG: ResolvedConfig = {
  port: 3300,
  workspace: 'demo',
  token: 'tok',
  baseUrl: 'http://localhost:3300',
};

function fakeClient(
  result: AcceptanceVerifyResult,
  capture?: (ws: string, cid: string) => void,
): GlmClient {
  return {
    baseUrl: 'http://localhost:3300',
    runAcceptanceVerify: async (ws: string, cid: string) => {
      capture?.(ws, cid);
      return result;
    },
  } as unknown as GlmClient;
}

describe('glm_run_acceptance_verifier tool', () => {
  test('renders PASS with the command and duration', async () => {
    const result = await runRunAcceptanceVerifier(
      { component_id: 'acme:web.shop.cart.cart_manager' },
      {
        client: fakeClient({
          command: 'bun test test/cart.test.ts',
          cwd: '/work/petshop',
          exitCode: 0,
          stdout: 'pass!\n',
          stderr: '',
          durationMs: 1234,
        }),
        config: CONFIG,
      },
    );
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Acceptance verifier: PASS');
    expect(text).toContain('Command:   bun test test/cart.test.ts');
    expect(text).toContain('Cwd:       /work/petshop');
    expect(text).toContain('Exit code: 0');
    expect(text).toContain('Duration:  1234 ms');
    expect(text).toContain('Stdout:');
    expect(text).toContain('pass!');
  });

  test('renders FAIL when exit code is non-zero, surfaces stderr', async () => {
    const result = await runRunAcceptanceVerifier(
      { component_id: 'acme:web.shop.cart.cart_manager' },
      {
        client: fakeClient({
          command: 'bun test',
          cwd: '/work/petshop',
          exitCode: 1,
          stdout: 'partial output',
          stderr: 'TypeError: undefined is not a function\n  at /src/cart.ts:42',
          durationMs: 250,
        }),
        config: CONFIG,
      },
    );
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Acceptance verifier: FAIL');
    expect(text).toContain('Exit code: 1');
    expect(text).toContain('Stderr:');
    expect(text).toContain('TypeError');
  });

  test('truncates very long stdout to the last 4 KB with a leading marker', async () => {
    const big = 'a'.repeat(10_000) + 'TAIL_MARKER';
    const result = await runRunAcceptanceVerifier(
      { component_id: 'acme:web.shop.cart.cart_manager' },
      {
        client: fakeClient({
          command: 'bun test',
          cwd: '/work',
          exitCode: 0,
          stdout: big,
          stderr: '',
          durationMs: 99,
        }),
        config: CONFIG,
      },
    );
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('truncated to last 4000 bytes');
    expect(text).toContain('TAIL_MARKER'); // the tail is preserved
    expect(text.length).toBeLessThan(big.length); // overall block shrank
  });

  test('uses input workspace when provided', async () => {
    let seenWs = '';
    let seenCid = '';
    await runRunAcceptanceVerifier(
      { component_id: 'acme:web.shop.cart.cart_manager', workspace: 'other-ws' },
      {
        client: fakeClient(
          {
            command: 'true',
            cwd: '/x',
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 1,
          },
          (ws, cid) => { seenWs = ws; seenCid = cid; },
        ),
        config: CONFIG,
      },
    );
    expect(seenWs).toBe('other-ws');
    expect(seenCid).toBe('acme:web.shop.cart.cart_manager');
  });
});
