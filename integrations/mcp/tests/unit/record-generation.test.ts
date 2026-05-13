import { describe, expect, test } from 'bun:test';
import { runRecordGeneration } from '../../src/tools/record-generation.ts';
import type { GlmClient, ProvenanceEvent, RecordGenerationRequest } from '../../src/lib/glm-client.ts';
import type { ResolvedConfig } from '../../src/lib/config.ts';

const CONFIG: ResolvedConfig = {
  port: 3300,
  workspace: 'demo',
  token: 'tok',
  baseUrl: 'http://localhost:3300',
};

function fakeClient(
  prov: ProvenanceEvent,
  capture?: (ws: string, req: RecordGenerationRequest) => void,
): GlmClient {
  return {
    baseUrl: 'http://localhost:3300',
    recordGeneration: async (ws: string, req: RecordGenerationRequest) => {
      capture?.(ws, req);
      return prov;
    },
  } as unknown as GlmClient;
}

const SAMPLE_PROV: ProvenanceEvent = {
  id: 'prov-1',
  workspaceId: 'ws-1',
  occurredAt: '2026-05-13T16:00:00Z',
  subjectFile: 'src/cart.ts',
  subjectDigest: 'sha256:dddd',
  sekkeiRoot: 'acme:c',
  sekkeiRev: 'sha256:aaaa',
  bindingHash: 'sha256:bbbb',
  generatorLlm: 'claude-code/sonnet-4-6',
  generatorPromptVersion: 'sha256:cccc',
  durationMs: 5000,
  note: null,
};

describe('glm_record_generation tool', () => {
  test('passes the request through with snake→camel field names', async () => {
    let seenWs = '';
    let seenReq: RecordGenerationRequest | undefined;
    await runRecordGeneration(
      {
        component_id: 'acme:c',
        files: [{ path: 'src/cart.ts', sha256: `sha256:${'a'.repeat(64)}`, bytes: 1234 }],
        verifier_exit_code: 0,
        binding_hash: 'sha256:beef',
        generator_identity: 'claude-code/sonnet-4-6',
        duration_ms: 5000,
        note: 'first attempt',
      },
      { client: fakeClient(SAMPLE_PROV, (ws, req) => { seenWs = ws; seenReq = req; }), config: CONFIG },
    );
    expect(seenWs).toBe('demo');
    expect(seenReq).toEqual({
      componentId: 'acme:c',
      files: [{ path: 'src/cart.ts', sha256: `sha256:${'a'.repeat(64)}`, bytes: 1234 }],
      verifierExitCode: 0,
      bindingHash: 'sha256:beef',
      generatorIdentity: 'claude-code/sonnet-4-6',
      durationMs: 5000,
      note: 'first attempt',
    });
  });

  test('renders the returned provenance summary', async () => {
    const result = await runRecordGeneration(
      {
        component_id: 'acme:c',
        files: [{ path: 'src/cart.ts', sha256: `sha256:${'a'.repeat(64)}`, bytes: 1234 }],
        verifier_exit_code: 0,
      },
      { client: fakeClient(SAMPLE_PROV), config: CONFIG },
    );
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Recorded provenance prov-1');
    expect(text).toContain('acme:c');
    expect(text).toContain('sha256:bbbb');
    expect(text).toContain('claude-code/sonnet-4-6');
    expect(text).toContain('5000 ms');
  });

  test('omits optional fields cleanly when not provided', async () => {
    let seenReq: RecordGenerationRequest | undefined;
    await runRecordGeneration(
      {
        component_id: 'acme:c',
        files: [{ path: 'src/cart.ts', sha256: `sha256:${'a'.repeat(64)}`, bytes: 1234 }],
        verifier_exit_code: 0,
      },
      { client: fakeClient(SAMPLE_PROV, (_w, req) => { seenReq = req; }), config: CONFIG },
    );
    expect(seenReq?.bindingHash).toBeUndefined();
    expect(seenReq?.generatorIdentity).toBeUndefined();
    expect(seenReq?.durationMs).toBeUndefined();
    expect(seenReq?.note).toBeNull();
  });

  test('input workspace overrides config workspace', async () => {
    let seenWs = '';
    await runRecordGeneration(
      {
        component_id: 'acme:c',
        files: [{ path: 'src/cart.ts', sha256: `sha256:${'a'.repeat(64)}`, bytes: 1 }],
        verifier_exit_code: 0,
        workspace: 'other-ws',
      },
      { client: fakeClient(SAMPLE_PROV, (ws) => { seenWs = ws; }), config: CONFIG },
    );
    expect(seenWs).toBe('other-ws');
  });
});
