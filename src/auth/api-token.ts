import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiTokenRepository, ApiTokenRow } from '../repository/api-token-repository.ts';

/**
 * API token issuance + validation (spec §6.4).
 *
 * Format of the raw token shown to the user:
 *
 *   glm_<prefix-8>_<random-32-bytes-hex>
 *
 * The `prefix` is stored alongside a salted SHA-256 hash; lookups happen by
 * prefix and verification is constant-time on the hash.
 *
 * Note: spec §6.4 calls for Argon2id; v1 ships SHA-256 with per-token salt
 * to avoid a heavy hash on every request. Phase 10 hardening replaces this
 * with `Bun.password.hash(token, { algorithm: 'argon2id' })`.
 */

export class InvalidApiTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidApiTokenError';
  }
}

export interface IssuedToken {
  /** Raw token to show the user exactly once. */
  rawToken: string;
  /** Stored row (without the raw token). */
  stored: ApiTokenRow;
}

export interface IssueOptions {
  id: string;
  userId: string;
  name: string;
  scopes?: string[];
  expiresAt?: string | null;
}

/** Generate a new token, persist its hash, and return the raw token. */
export function issueApiToken(repo: ApiTokenRepository, opts: IssueOptions): IssuedToken {
  const prefix = randomBytes(4).toString('hex'); // 8 hex chars
  const body = randomBytes(32).toString('hex');
  const rawToken = `glm_${prefix}_${body}`;
  const salt = randomBytes(16).toString('hex');
  const tokenHash = hashToken(rawToken, salt);
  const stored = repo.insert({
    id: opts.id,
    userId: opts.userId,
    prefix,
    tokenHash,
    salt,
    name: opts.name,
    scopes: opts.scopes ?? [],
    expiresAt: opts.expiresAt ?? null,
  });
  return { rawToken, stored };
}

/**
 * Validate a raw token against the repository. Returns the row on success,
 * throws `InvalidApiTokenError` on malformed/unknown/expired/revoked.
 * Updates `last_used_at` on success.
 */
export function validateApiToken(repo: ApiTokenRepository, raw: string, now = new Date()): ApiTokenRow {
  const parts = raw.split('_');
  if (parts.length !== 3 || parts[0] !== 'glm') {
    throw new InvalidApiTokenError('malformed token');
  }
  const prefix = parts[1] as string;
  const candidates = repo.findCandidatesByPrefix(prefix);
  if (candidates.length === 0) throw new InvalidApiTokenError('unknown token');

  for (const cand of candidates) {
    const expected = hashToken(raw, cand.salt);
    if (constantTimeEqualHex(expected, cand.tokenHash)) {
      if (cand.revokedAt) throw new InvalidApiTokenError('token revoked');
      if (cand.expiresAt && new Date(cand.expiresAt).getTime() <= now.getTime()) {
        throw new InvalidApiTokenError('token expired');
      }
      repo.touchLastUsed(cand.id, now);
      return cand;
    }
  }
  throw new InvalidApiTokenError('token hash mismatch');
}

/** Read the bearer token from an Authorization header (case-insensitive). */
export function readBearer(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? (match[1] ?? null) : null;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function hashToken(raw: string, salt: string): string {
  return createHash('sha256').update(`${raw}|${salt}`).digest('hex');
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a, 'hex');
  const bBuf = Buffer.from(b, 'hex');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
