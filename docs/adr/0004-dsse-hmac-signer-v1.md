# ADR 0004 — HMAC-SHA256 signer for DSSE attestations (v1)

**Status:** Accepted
**Date:** 2026-05-11
**Deciders:** Full-stack thread
**Phase:** 5 (Generation pipeline) → revisited in Phase 10 (Hardening)

## Context

Spec §5.9 and §9.6 require every generation event to produce a signed in-toto Statement, wrapped in a DSSE envelope, and (eventually) anchored to Rekor. The implementation plan §7 risk register noted that the Sigstore / Fulcio integration is the most uncertain part of the pipeline and proposed a fallback to plain JSON-Web-Signature.

For v1 we needed something that:

- produces a well-formed DSSE envelope today
- keeps the `AttestationSigner` interface stable so a real Sigstore adapter drops in later
- does not add a dependency on `cosign` or a Fulcio CA in test / dev environments
- can be verified server-side on demand (AC-35)

## Decision

Ship an HMAC-SHA256 signer (`HmacSigner` in `src/generation/attestation.ts`) as the default `AttestationSigner` implementation. The `keyId` field on the DSSE envelope carries a stable identifier (`glm-dev-hmac:<first-12-of-sha256(key)>`); the secret is supplied via `GLM_DSSE_HMAC_KEY` env (hex) or generated at boot if absent.

The DSSE envelope structure is the real DSSE wire format:

```
{ payloadType: "application/vnd.in-toto+json",
  payload:     base64(JSON.stringify(statement)),
  signatures:  [{ keyid, sig }] }
```

The PAE (`DSSEv1 <len> <type> <len> <payload>`) is what we sign, so any verifier that follows the DSSE spec can validate the envelope as long as it accepts the keyid → secret mapping.

A mock Rekor entry id is derived deterministically from the signature digest so the UI can render the AC-36 URL today.

## Alternatives considered

- **Real Sigstore client (Fulcio short-lived cert + Rekor upload).** Correct end-state, but requires either a network dependency on the public Sigstore stack in dev or a private CA. Out of scope for v1 done-when.
- **Plain JSON-Web-Signature (JWS).** Compact and well-supported, but not the DSSE wire format — every consumer outside the project would have to special-case the verification path.
- **Ed25519 (Node `crypto.sign('ed25519', …)`).** Cryptographically appropriate, but introduces key-management surface (private key file on disk) without delivering Sigstore's "no long-lived keys" property — a half-step that's worse than either anchor.

## Consequences

- **Positive:** Every generation event produces a verifiable envelope with no external infrastructure, satisfying AC-32, AC-33, AC-34, AC-35.
- **Positive:** `AttestationSigner` interface is the seam; a Phase 10+ Sigstore adapter only needs to satisfy `sign(paeBytes) → base64` + `verify(paeBytes, sig)`.
- **Negative:** An attacker who acquires `GLM_DSSE_HMAC_KEY` can forge attestations. v1 deployment guidance is to store the key in a sealed secret + rotate quarterly; full unlinkability requires the Sigstore adapter.
- **Negative:** The Rekor entry id is a hash of the signature, not an on-chain index. Downstream consumers that follow the `rekor.sigstore.dev/index/<id>` URL get a 404 today. Mitigation: the field is structurally correct; once we switch signers the URL becomes live.

## Follow-ups

- ADR-0006 (future) will record the cut-over from HMAC to Sigstore/Fulcio. The DSSE envelope structure does not change; only `AttestationSigner.keyId` + `sign` body.
- A nightly job verifying every attestation in the workspace is enqueued via `POST /provenance/verify`; alerting on `failed > 0` is operator-side.
