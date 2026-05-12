import { describe, expect, test } from 'bun:test';
import {
  buildDsseEnvelope,
  buildStatement,
  decodeStatement,
  dsseEncode,
  HmacSigner,
  PREDICATE_TYPE,
  rekorEntryId,
  rekorUrl,
  STATEMENT_TYPE,
  verifyDsseEnvelope,
} from '../../../src/generation/attestation.ts';

const GENERATOR = {
  llm: 'claude-sonnet-4-6',
  promptVersion: 'sha256:aaa',
  toolChain: 'sha256:bbb',
};

function sampleStatement() {
  return buildStatement({
    subjectFile: 'src/routes/checkout.ts',
    subjectDigest: 'sha256:1bf2',
    sekkeiRootId: 'glm:system.web',
    sekkeiRevision: 'A.0',
    sekkeiLockDigest: 'sha256:6c1f',
    bindingParameterHash: 'sha256:bind',
    generator: GENERATOR,
    tokensIn: 1200,
    tokensOut: 800,
    durationMs: 1500,
    cache: 'miss',
  });
}

describe('buildStatement', () => {
  test('emits the spec-mandated _type, predicateType, and shape', () => {
    const s = sampleStatement();
    expect(s._type).toBe(STATEMENT_TYPE);
    expect(s.predicateType).toBe(PREDICATE_TYPE);
    expect(s.subject[0]?.name).toBe('src/routes/checkout.ts');
    expect(s.subject[0]?.digest.sha256).toBe('1bf2');
    expect(s.predicate.metrics.cache).toBe('miss');
    expect(s.predicate.generator.llm).toBe('claude-sonnet-4-6');
  });

  test('cache=hit Statement still carries the metrics block', () => {
    const s = buildStatement({
      subjectFile: 'x',
      subjectDigest: 'sha256:abc',
      sekkeiRootId: 'glm:x',
      sekkeiRevision: 'A.0',
      sekkeiLockDigest: 'sha256:lk',
      bindingParameterHash: 'sha256:b',
      generator: GENERATOR,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
      cache: 'hit',
    });
    expect(s.predicate.metrics.tokens_in).toBe(0);
    expect(s.predicate.metrics.cache).toBe('hit');
  });
});

describe('dsseEncode', () => {
  test('produces the DSSEv1 PAE format', () => {
    const payload = Buffer.from('hello', 'utf8');
    const pae = dsseEncode('application/x-test', payload);
    const asString = Buffer.from(pae).toString('utf8');
    expect(asString.startsWith('DSSEv1 18 application/x-test 5 ')).toBe(true);
    expect(asString.endsWith('hello')).toBe(true);
  });
});

describe('buildDsseEnvelope + verifyDsseEnvelope', () => {
  test('round-trips via HmacSigner', () => {
    const signer = new HmacSigner({ keyId: 'test-key', keyHex: 'a'.repeat(64) });
    const env = buildDsseEnvelope(sampleStatement(), signer);
    expect(env.payloadType).toBe('application/vnd.in-toto+json');
    expect(env.signatures[0]?.keyid).toBe('test-key');
    const result = verifyDsseEnvelope(env, signer);
    expect(result.passed).toBe(true);
  });

  test('verification fails with a different key', () => {
    const a = new HmacSigner({ keyId: 'a', keyHex: 'a'.repeat(64) });
    const b = new HmacSigner({ keyId: 'a', keyHex: 'b'.repeat(64) });
    const env = buildDsseEnvelope(sampleStatement(), a);
    expect(verifyDsseEnvelope(env, b).passed).toBe(false);
  });

  test('decodeStatement returns the original Statement', () => {
    const signer = new HmacSigner({ keyId: 'k', keyHex: 'a'.repeat(64) });
    const original = sampleStatement();
    const env = buildDsseEnvelope(original, signer);
    const decoded = decodeStatement(env);
    expect(decoded.predicate.generator.llm).toBe('claude-sonnet-4-6');
  });
});

describe('rekor URL helpers (AC-36)', () => {
  test('rekorUrl uses the canonical rekor.sigstore.dev/index/<id> format', () => {
    const url = rekorUrl('abc123');
    expect(url).toBe('https://rekor.sigstore.dev/index/abc123');
  });

  test('rekorEntryId is deterministic for the same envelope', () => {
    const signer = new HmacSigner({ keyId: 'k', keyHex: 'a'.repeat(64) });
    const env = buildDsseEnvelope(sampleStatement(), signer);
    expect(rekorEntryId(env)).toBe(rekorEntryId(env));
  });
});
