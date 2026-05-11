import { Database } from "bun:sqlite";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DATABASE_PATH = process.env.DATABASE_PATH ?? "./data/todomvc.db";

const dbDir = dirname(resolve(DATABASE_PATH));
if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

export const db = new Database(DATABASE_PATH, { create: true });

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA busy_timeout = 5000;");

const migration = readFileSync(
  new URL("./migrations/001_create_todos.sql", import.meta.url),
  "utf8"
);
db.exec(migration);

export type DB = typeof db;
