-- Source-of-truth: kizo:web.todomvc.todo_management.todo_repository.todo_schema
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS todos (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL CHECK(length(trim(title)) > 0),
  completed  INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_todos_completed ON todos(completed);
CREATE INDEX IF NOT EXISTS idx_todos_created   ON todos(created_at);
