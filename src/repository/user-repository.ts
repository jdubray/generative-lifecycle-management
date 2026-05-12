import type { Database, Statement } from 'bun:sqlite';
import type { User, UserRole } from '../types.ts';

export interface UserInsert {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  createdAt?: string;
}

export class UserRepository {
  private readonly stInsert: Statement;
  private readonly stFindById: Statement;
  private readonly stFindByEmail: Statement;

  constructor(db: Database) {
    this.stInsert = db.prepare(
      'INSERT INTO users (id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    this.stFindById = db.prepare(
      'SELECT id, email, display_name, role, created_at FROM users WHERE id = ?',
    );
    this.stFindByEmail = db.prepare(
      'SELECT id, email, display_name, role, created_at FROM users WHERE email = ?',
    );
  }

  insert(u: UserInsert): User {
    const createdAt = u.createdAt ?? new Date().toISOString();
    this.stInsert.run(u.id, u.email, u.displayName, u.role, createdAt);
    return { id: u.id, email: u.email, displayName: u.displayName, role: u.role, createdAt };
  }

  findById(id: string): User | null {
    const r = this.stFindById.get(id) as UserRow | undefined;
    return r ? rowToUser(r) : null;
  }

  findByEmail(email: string): User | null {
    const r = this.stFindByEmail.get(email) as UserRow | undefined;
    return r ? rowToUser(r) : null;
  }
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  created_at: string;
}

function rowToUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    role: r.role as UserRole,
    createdAt: r.created_at,
  };
}
