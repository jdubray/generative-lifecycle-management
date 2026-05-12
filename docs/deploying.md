# Deploying GLM

This document describes the v1 deployment shape. v1 is single-tenant per organization: one Bun process, one SQLite file, one git checkout of `glm-sekkei/`. Multi-region, multi-process, and replicated deployments are explicitly out of scope.

## Prerequisites

- **Bun ≥ 1.1.** `bun --version` should report at least `1.1.0`.
- **git ≥ 2.40.** Required by the git client + hook installer.
- **A TLS terminator in front of the Bun port.** v1 does not terminate TLS itself; run it behind nginx / Caddy / Cloud Run / Fly's edge.

## Initial setup

1. Clone the repository and install dependencies:

   ```sh
   git clone <git remote> /opt/glm && cd /opt/glm
   bun install --frozen-lockfile
   ```

2. Generate a session secret and configure `.env`:

   ```sh
   cp .env.example .env
   bun -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))" \
     >> .env  # paste into SESSION_SECRET=
   ```

3. Create the data + repo directories referenced in `.env`:

   ```sh
   mkdir -p data repos
   GLM_DB_PATH=./data/glm.db bun run scripts/migrate.ts
   git init --bare repos/glm-sekkei
   ```

4. Install the git pre-commit + pre-receive hooks. The pre-receive hook will refuse pushes that lack an `Affected:` block on commits touching `nodes/`, and (when `GLM_DB_PATH` + `GLM_WORKSPACE` are set in the hook's env) will run the 6-gate verifier:

   ```sh
   bun -e "import('./src/git/hook-installer.ts').then(m => m.installHooks({ repoPath: 'repos/glm-sekkei' }))"
   ```

## Running

```sh
NODE_ENV=production PORT=3000 \
  GLM_DB_PATH=./data/glm.db \
  SESSION_SECRET="$(cat /run/secrets/session_secret)" \
  bun run start
```

For a single-binary deployment:

```sh
bun build src/server/server.ts --target=bun --outdir=dist
./dist/server.js
```

## Operational tasks

- **Backup:** `bun run scripts/backup.ts --db=./data/glm.db --out=./backups/glm-$(date +%FT%H%M).db`. Backups are produced via SQLite `VACUUM INTO`, which is concurrent-reader-safe.
- **Restore:** `bun run scripts/restore.ts --backup=./backups/glm-…db --db=./data/glm.db`. Pass `--force` to overwrite a non-empty destination. The script runs `PRAGMA integrity_check` after copying and exits non-zero if it fails.
- **Verify a workspace on demand:** `bun run scripts/verify.ts --workspace=<slug>`. Exits non-zero if any gate fails (used by the pre-receive hook).
- **Load test:** `bun run scripts/loadtest.ts --workspace=ws-1 --node=glm:component.web --editors=50 --duration=30` exercises the soft-lock contention path. Prints a JSON summary with acquired/busy/error counts and latency percentiles.

## Observability

Each request produces one structured log line via `requestLogging()` middleware:

```json
{"ts":"2026-05-11T12:34:56.789Z","request_id":"…","method":"POST","path":"/api/v1/workspaces/ws-1/scrs","status":201,"duration_ms":42,"user_id":"u-1"}
```

`X-Request-Id` is echoed on every response so you can correlate UI bugs to log lines. Audit history is queryable via `GET /workspaces/:id/provenance` and the `audit_events` table; full traceback for any generation event lives in `generation_attestations` (DSSE bundle exportable via `POST /workspaces/:id/provenance/export`).

## Security

- All `/api/v1/*` endpoints require an authenticated principal; the only exceptions are `/api/v1/auth/login` and `/api/v1/health`.
- Auth endpoints are rate-limited (12 attempts / 5 min / principal-or-IP).
- `SESSION_SECRET` must be 32 bytes (64 hex chars) and rotated quarterly. Cookies are HttpOnly + SameSite=Strict + Secure (when `cookieSecure` is true, which the factory defaults to in `NODE_ENV=production`).
- API tokens are SHA-256 hashes with per-token salts. Phase 10 hardening uses this v1 scheme; ADR-0004 captures the cut-over plan to Argon2id when the dev/test cost is bearable.
- DSSE attestations use HMAC-SHA256 (ADR-0004) with `GLM_DSSE_HMAC_KEY`. A future ADR will cut over to Sigstore / Fulcio without changing the wire format.

## Upgrades

- Migrations live in `migrations/` and are applied at boot by `openDb()`. Number them `NNNN_<slug>.sql`. The runner refuses to start if there's a gap in the version sequence.
- The PWA service worker is versioned by `VERSION` in `public/sw.js`; bump it whenever you add or remove a precached path.
- Roll back by restoring the previous backup + reverting the deploy. Migrations are forward-only; any rollback that crosses a migration requires a fresh backup.
