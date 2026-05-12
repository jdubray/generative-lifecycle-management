import type { Database, Statement } from 'bun:sqlite';

export interface ApiTokenRow {
  id: string;
  userId: string;
  prefix: string;
  tokenHash: string;
  salt: string;
  name: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface ApiTokenInsert {
  id: string;
  userId: string;
  prefix: string;
  tokenHash: string;
  salt: string;
  name: string;
  scopes?: string[];
  createdAt?: string;
  expiresAt?: string | null;
}

export class ApiTokenRepository {
  private readonly stInsert: Statement;
  private readonly stListByPrefix: Statement;
  private readonly stListByUser: Statement;
  private readonly stTouchLastUsed: Statement;
  private readonly stRevoke: Statement;

  constructor(db: Database) {
    this.stInsert = db.prepare(
      `INSERT INTO api_tokens (id, user_id, prefix, token_hash, salt, name, scopes_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stListByPrefix = db.prepare(
      `SELECT id, user_id, prefix, token_hash, salt, name, scopes_json, created_at, last_used_at, expires_at, revoked_at
       FROM api_tokens WHERE prefix = ? AND revoked_at IS NULL`,
    );
    this.stListByUser = db.prepare(
      `SELECT id, user_id, prefix, token_hash, salt, name, scopes_json, created_at, last_used_at, expires_at, revoked_at
       FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`,
    );
    this.stTouchLastUsed = db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?');
    this.stRevoke = db.prepare(
      'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    );
  }

  insert(t: ApiTokenInsert): ApiTokenRow {
    const createdAt = t.createdAt ?? new Date().toISOString();
    const scopes = t.scopes ?? [];
    this.stInsert.run(
      t.id,
      t.userId,
      t.prefix,
      t.tokenHash,
      t.salt,
      t.name,
      JSON.stringify(scopes),
      createdAt,
      t.expiresAt ?? null,
    );
    return {
      id: t.id,
      userId: t.userId,
      prefix: t.prefix,
      tokenHash: t.tokenHash,
      salt: t.salt,
      name: t.name,
      scopes,
      createdAt,
      lastUsedAt: null,
      expiresAt: t.expiresAt ?? null,
      revokedAt: null,
    };
  }

  /** Return all active tokens whose visible prefix matches (usually 0 or 1). */
  findCandidatesByPrefix(prefix: string): ApiTokenRow[] {
    return (this.stListByPrefix.all(prefix) as TokenRow[]).map(rowTo);
  }

  listByUser(userId: string): ApiTokenRow[] {
    return (this.stListByUser.all(userId) as TokenRow[]).map(rowTo);
  }

  touchLastUsed(id: string, now = new Date()): void {
    this.stTouchLastUsed.run(now.toISOString(), id);
  }

  revoke(id: string, now = new Date()): boolean {
    return this.stRevoke.run(now.toISOString(), id).changes > 0;
  }
}

interface TokenRow {
  id: string;
  user_id: string;
  prefix: string;
  token_hash: string;
  salt: string;
  name: string;
  scopes_json: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

function rowTo(r: TokenRow): ApiTokenRow {
  return {
    id: r.id,
    userId: r.user_id,
    prefix: r.prefix,
    tokenHash: r.token_hash,
    salt: r.salt,
    name: r.name,
    scopes: JSON.parse(r.scopes_json) as string[],
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  };
}
