import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { GeneratorIdentity, Sha256Hash } from '../types.ts';

/**
 * in-toto Statement v1 + DSSE envelope (spec §5.9).
 *
 * Statement shape (mirrors spec §5.9 exactly):
 *
 *   { _type: "https://in-toto.io/Statement/v1",
 *     subject: [{ name, digest: { sha256 } }],
 *     predicateType: "https://puffin.dev/glm/v1/generation",
 *     predicate: { sekkei, binding, generator, metrics } }
 *
 * DSSE envelope:
 *
 *   { payloadType: "application/vnd.in-toto+json",
 *     payload:     base64(JSON.stringify(statement)),
 *     signatures:  [{ keyid, sig }] }
 *
 * v1 ships an HMAC-SHA256 signer ("dev key"). The interface is shaped so a
 * Phase 10 Fulcio/Sigstore adapter can drop in without changing callers.
 * The Rekor URL is derived deterministically from the signature digest for
 * AC-36; a real Rekor upload happens in production hardening.
 */

export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const PREDICATE_TYPE = 'https://puffin.dev/glm/v1/generation';
export const DSSE_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
export const REKOR_URL_PREFIX = 'https://rekor.sigstore.dev/index';

// ---------------------------------------------------------------------------
// Statement shape
// ---------------------------------------------------------------------------

export interface InTotoStatement {
  _type: typeof STATEMENT_TYPE;
  subject: Array<{ name: string; digest: { sha256: string } }>;
  predicateType: typeof PREDICATE_TYPE;
  predicate: {
    sekkei: { root_id: string; revision: string; lock_digest: string };
    binding: { parameter_hash: string };
    generator: { llm: string; prompt_version: string; tool_chain: string };
    metrics: {
      tokens_in: number;
      tokens_out: number;
      duration_ms: number;
      cache: 'hit' | 'miss';
    };
  };
}

export interface DsseEnvelope {
  payloadType: string;
  /** base64 of the payload bytes. */
  payload: string;
  signatures: Array<{ keyid: string; sig: string }>;
}

export interface StatementInput {
  subjectFile: string;
  subjectDigest: Sha256Hash;
  sekkeiRootId: string;
  sekkeiRevision: string;
  sekkeiLockDigest: Sha256Hash;
  bindingParameterHash: Sha256Hash;
  generator: GeneratorIdentity;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  cache: 'hit' | 'miss';
}

/** Build the canonical in-toto Statement v1 for a generation event. */
export function buildStatement(input: StatementInput): InTotoStatement {
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: input.subjectFile, digest: { sha256: stripPrefix(input.subjectDigest) } }],
    predicateType: PREDICATE_TYPE,
    predicate: {
      sekkei: {
        root_id: input.sekkeiRootId,
        revision: input.sekkeiRevision,
        lock_digest: input.sekkeiLockDigest,
      },
      binding: { parameter_hash: input.bindingParameterHash },
      generator: {
        llm: input.generator.llm,
        prompt_version: input.generator.promptVersion ?? '',
        tool_chain: input.generator.toolChain ?? '',
      },
      metrics: {
        tokens_in: input.tokensIn,
        tokens_out: input.tokensOut,
        duration_ms: input.durationMs,
        cache: input.cache,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// DSSE pre-authentication encoding (DSSEv1)
// ---------------------------------------------------------------------------

/**
 * Build the bytes that DSSE actually signs. Format:
 *   "DSSEv1 <len(payloadType)> <payloadType> <len(payload)> <payload>"
 * with single ASCII space separators (per the DSSE spec).
 */
export function dsseEncode(payloadType: string, payload: Uint8Array): Uint8Array {
  const prefix = `DSSEv1 ${payloadType.length} ${payloadType} ${payload.length} `;
  const prefixBytes = Buffer.from(prefix, 'utf8');
  const out = new Uint8Array(prefixBytes.length + payload.length);
  out.set(prefixBytes, 0);
  out.set(payload, prefixBytes.length);
  return out;
}

// ---------------------------------------------------------------------------
// Signer abstraction
// ---------------------------------------------------------------------------

export interface AttestationSigner {
  /** Stable identifier surfaced in the DSSE `keyid` field. */
  readonly keyId: string;
  /** Sign the DSSE PAE bytes. Returns base64 of the signature. */
  sign(paeBytes: Uint8Array): string;
  /** Verify a signature produced by `sign`. */
  verify(paeBytes: Uint8Array, signatureBase64: string): boolean;
}

/**
 * Dev / test signer: HMAC-SHA256 over the DSSE PAE bytes. The "key" is a
 * fixed bytes value; in v1 we use a process-lifetime random key unless
 * the caller supplies one via `GLM_DSSE_HMAC_KEY` for reproducibility.
 *
 * Production hardening (Phase 10) replaces this with an Ed25519 signer
 * backed by Fulcio short-lived certs. The interface is unchanged.
 */
export class HmacSigner implements AttestationSigner {
  public readonly keyId: string;
  private readonly key: Buffer;

  constructor(opts: { keyId?: string; keyHex?: string } = {}) {
    const keyHex = opts.keyHex ?? process.env.GLM_DSSE_HMAC_KEY ?? randomBytes(32).toString('hex');
    this.key = Buffer.from(keyHex, 'hex');
    this.keyId = opts.keyId ?? `glm-dev-hmac:${sha256Hex(this.key).slice(0, 12)}`;
  }

  sign(paeBytes: Uint8Array): string {
    return createHmac('sha256', this.key).update(paeBytes).digest('base64');
  }

  verify(paeBytes: Uint8Array, signatureBase64: string): boolean {
    const expected = createHmac('sha256', this.key).update(paeBytes).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signatureBase64, 'base64');
    } catch {
      return false;
    }
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }
}

// ---------------------------------------------------------------------------
// Envelope assembly + verification
// ---------------------------------------------------------------------------

/** Build a DSSE envelope wrapping a JSON-serialized Statement. */
export function buildDsseEnvelope(statement: InTotoStatement, signer: AttestationSigner): DsseEnvelope {
  const payloadJson = JSON.stringify(statement);
  const payloadBytes = Buffer.from(payloadJson, 'utf8');
  const pae = dsseEncode(DSSE_PAYLOAD_TYPE, payloadBytes);
  const sig = signer.sign(pae);
  return {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: payloadBytes.toString('base64'),
    signatures: [{ keyid: signer.keyId, sig }],
  };
}

export interface VerificationResult {
  /** True iff every signature in the envelope verifies. */
  passed: boolean;
  /** Detail per signature, in the order they appear in the envelope. */
  signatures: Array<{ keyid: string; passed: boolean; reason?: string }>;
}

/** Verify every signature on `envelope` against `signer`. */
export function verifyDsseEnvelope(envelope: DsseEnvelope, signer: AttestationSigner): VerificationResult {
  let payloadBytes: Buffer;
  try {
    payloadBytes = Buffer.from(envelope.payload, 'base64');
  } catch {
    return { passed: false, signatures: [{ keyid: '?', passed: false, reason: 'payload not base64' }] };
  }
  const pae = dsseEncode(envelope.payloadType, payloadBytes);
  const sigs = envelope.signatures.map((s) => {
    if (s.keyid !== signer.keyId) {
      return { keyid: s.keyid, passed: false, reason: `unknown keyid (have ${signer.keyId})` };
    }
    const ok = signer.verify(pae, s.sig);
    return { keyid: s.keyid, passed: ok, reason: ok ? undefined : 'signature mismatch' } as const;
  });
  return { passed: sigs.length > 0 && sigs.every((s) => s.passed), signatures: sigs };
}

export class DsseDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DsseDecodeError';
  }
}

/**
 * Parse the Statement back out of a DSSE envelope. Throws `DsseDecodeError`
 * (rather than a raw `SyntaxError`) on malformed base64 / non-JSON payload
 * so callers can map it cleanly to a 4xx instead of crashing the handler.
 */
export function decodeStatement(envelope: DsseEnvelope): InTotoStatement {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(envelope.payload, 'base64');
  } catch {
    throw new DsseDecodeError('payload is not base64');
  }
  let text: string;
  try {
    text = bytes.toString('utf8');
  } catch {
    throw new DsseDecodeError('payload is not valid utf-8');
  }
  try {
    return JSON.parse(text) as InTotoStatement;
  } catch (err) {
    throw new DsseDecodeError(`payload is not JSON: ${(err as Error).message}`);
  }
}

/**
 * Derive a deterministic mock Rekor entry id from a DSSE signature (AC-36).
 * Real Rekor uploads are out of scope until Phase 10; this id format matches
 * the public Rekor `/index/<id>` URL convention.
 */
export function rekorEntryId(envelope: DsseEnvelope): string {
  const firstSig = envelope.signatures[0]?.sig ?? '';
  return sha256Hex(Buffer.from(firstSig, 'base64'));
}

/** AC-36: format the Rekor transparency-log URL. */
export function rekorUrl(entryId: string): string {
  return `${REKOR_URL_PREFIX}/${entryId}`;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function stripPrefix(h: Sha256Hash): string {
  return h.startsWith('sha256:') ? h.slice('sha256:'.length) : h;
}
