// Loaded by bunfig.toml [test].preload BEFORE any test file imports.
// Routes bun:sqlite at an in-memory database for unit tests.
process.env.DATABASE_PATH = ":memory:";
process.env.REQUEST_LOGGING = "false";
