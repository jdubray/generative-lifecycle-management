import { ulid } from "ulid";
import { db } from "./db.ts";
import type { FilterMode } from "./filter.ts";

export interface Todo {
  id: string;
  title: string;
  completed: boolean;
  created_at: string;
  updated_at: string;
}

interface TodoRow {
  id: string;
  title: string;
  completed: number;
  created_at: string;
  updated_at: string;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

const rowToTodo = (row: TodoRow): Todo => ({
  id: row.id,
  title: row.title,
  completed: row.completed === 1,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const stmts = {
  insert: db.prepare(
    "INSERT INTO todos (id, title, completed, created_at, updated_at) VALUES (?, ?, 0, ?, ?)"
  ),
  selectAll: db.prepare(
    "SELECT id, title, completed, created_at, updated_at FROM todos ORDER BY created_at ASC, id ASC"
  ),
  selectActive: db.prepare(
    "SELECT id, title, completed, created_at, updated_at FROM todos WHERE completed = 0 ORDER BY created_at ASC, id ASC"
  ),
  selectCompleted: db.prepare(
    "SELECT id, title, completed, created_at, updated_at FROM todos WHERE completed = 1 ORDER BY created_at ASC, id ASC"
  ),
  selectById: db.prepare(
    "SELECT id, title, completed, created_at, updated_at FROM todos WHERE id = ?"
  ),
  updateTitle: db.prepare(
    "UPDATE todos SET title = ?, updated_at = ? WHERE id = ?"
  ),
  updateCompleted: db.prepare(
    "UPDATE todos SET completed = ?, updated_at = ? WHERE id = ?"
  ),
  updateBoth: db.prepare(
    "UPDATE todos SET title = ?, completed = ?, updated_at = ? WHERE id = ?"
  ),
  touch: db.prepare("UPDATE todos SET updated_at = ? WHERE id = ?"),
  delete: db.prepare("DELETE FROM todos WHERE id = ?"),
  deleteCompleted: db.prepare("DELETE FROM todos WHERE completed = 1"),
  toggleAll: db.prepare(
    "UPDATE todos SET completed = ?, updated_at = ? WHERE completed != ?"
  ),
};

export class TodoRepository {
  create({ title }: { title: string }): Todo {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      throw new ValidationError("title is empty after trim");
    }
    const id = ulid();
    const now = new Date().toISOString();
    try {
      stmts.insert.run(id, trimmed, now, now);
    } catch (err: any) {
      if (String(err?.message ?? "").includes("UNIQUE")) {
        throw new ConflictError("id collision");
      }
      throw err;
    }
    return {
      id,
      title: trimmed,
      completed: false,
      created_at: now,
      updated_at: now,
    };
  }

  list({ filter: mode = "all" }: { filter?: FilterMode } = {}): Todo[] {
    const stmt =
      mode === "active"
        ? stmts.selectActive
        : mode === "completed"
        ? stmts.selectCompleted
        : stmts.selectAll;
    const rows = stmt.all() as TodoRow[];
    return rows.map(rowToTodo);
  }

  get(id: string): Todo | null {
    const row = stmts.selectById.get(id) as TodoRow | null;
    return row ? rowToTodo(row) : null;
  }

  update(
    id: string,
    patch: { title?: string; completed?: boolean }
  ): Todo | null {
    const existing = stmts.selectById.get(id) as TodoRow | null;
    if (!existing) return null;

    let nextTitle: string | undefined;
    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (t.length === 0) {
        throw new ValidationError("title is empty after trim");
      }
      nextTitle = t;
    }
    const nextCompleted =
      patch.completed === undefined ? undefined : patch.completed ? 1 : 0;

    const now = new Date().toISOString();
    if (nextTitle !== undefined && nextCompleted !== undefined) {
      stmts.updateBoth.run(nextTitle, nextCompleted, now, id);
    } else if (nextTitle !== undefined) {
      stmts.updateTitle.run(nextTitle, now, id);
    } else if (nextCompleted !== undefined) {
      stmts.updateCompleted.run(nextCompleted, now, id);
    } else {
      // no-op patch — still bump updated_at to advance monotonically
      stmts.touch.run(now, id);
    }

    const row = stmts.selectById.get(id) as TodoRow;
    return rowToTodo(row);
  }

  remove(id: string): boolean {
    const result = stmts.delete.run(id);
    return result.changes > 0;
  }

  removeCompleted(): number {
    const result = stmts.deleteCompleted.run();
    return result.changes;
  }

  toggleAll(completed: boolean): number {
    const target = completed ? 1 : 0;
    const now = new Date().toISOString();
    const result = stmts.toggleAll.run(target, now, target);
    return result.changes;
  }
}

export const repository = new TodoRepository();
