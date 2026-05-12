# GLM Realization Inventory

Reverse-engineering pass over `src/` to ground-truth the GLM's own sekkei
against the actual TypeScript implementation. This document is the input
to the next pass, which rewrites the structural sekkei to match.

## Top-level summary

**Realized footprint (TypeScript only):**
- 1 `types.ts` (shared domain types — no behavior)
- 6 domain modules (`src/domain/`)
- 3 auth modules (`src/auth/`)
- 2 agent modules (`src/agent/`)
- 5 generation modules (`src/generation/`)
- 7 git modules (`src/git/`)
- 15 repository modules (`src/repository/`)
- 3 server bootstrap modules (`src/server/{app,server,deps}.ts`)
- 6 middleware (`src/server/middleware/`)
- 13 route modules (`src/server/routes/`)
- 2 verifier modules (`src/verifier/`)
- 2 websocket modules (`src/ws/`)
- PWA shell (`public/`): 7 top-level JS modules + 10 view modules + 10 component modules + 2 stylesheets + html shells + service worker

**Total realized Components (back-end TS only):** ~65 if every back-end TS module is a Component. If grouped by Capability+folder, ~55. (The speculative sekkei said 44.)

**Major realization findings:**
- The codebase is **monolithic Bun + Hono** — there is no `workbench`/`engine` Sub-System separation in code. They share `repos`, `events`, `clock`, and one `Database` handle (`server/deps.ts:RuntimeDeps`).
- WebSockets, not SSE. `ws/event-bus.ts` is the in-process pub/sub; `ws/workspace-socket.ts` is the per-socket fan-out (Bun ServerWebSocket).
- Vibe Mode is **fully scripted** — `agent/scripts.ts` is hand-coded scenarios + cards, not an LLM agent harness. `agent/intent.ts` is a 4-regex classifier. The LLM is only the fallback (`/vibe/llm-fallback`).
- The verifier has **7 gates**, not 6 (gate 2.b is role-consistency, added with v1.1.9 system_role).
- Drift, SCR, reuse, variants, change_management, attestation, and reuse-promotion are all **realized server-side**, with full FSMs in three places (SCR, drift, rollout).
- The "git" capability is real: a typed git CLI client, a YAML store, ECN commit builder/parser, hooks installer, `sekkei.lock` serializer, and a sekkei git service that turns approved SCRs into commits. This was completely absent from the speculative sekkei.

The "engine vs workbench" partition speculated in the structural sekkei does not exist in the realization. There is **no** separate engine process. The whole runtime is one Bun server with one Hono app and one SQLite database.

---

## 1. Per-file inventory

### `src/types.ts`
- responsibility: All shared domain TypeScript types (entities, body shapes by stratum, supporting rows, operational tables, SCR/Variant/Drift/Reuse/Provenance).
- exports: `User`, `Workspace`, `WorkspaceMember`, `Stratum`, `RevisionStatus`, `OverrideKind`, `SystemBody`, `CapabilityBody`, `ComponentBody`, `InteractionBody` (union over `contract: 'fsm'|'integration_adapter'|'schema_binding'|'event_flow'`), `SpecBody`, `NodeBody`, `SekkeiNode`, `NodeParameter`, `NodeConstraint`, `NodeRelationship`, `ExternalDep`, `GeneratedArtifact`, `EditLock`, `ChangeLogEntry`, `VerificationRun`, `AuditEvent`, `Scr`, `ScrApproval`, `Variant`, `VariantRollout`, `DriftRecord`, `ReuseCandidate`, `ProvenanceEvent`, `GeneratorIdentity`.
- collaborators: (none — pure types)
- external_deps: (none)
- sekkei_capability: cross-cutting (domain types)
- proposed_component_id: `kizo:dev.glm.persistence.domain_types`

### `src/domain/node.ts`
- responsibility: Stratum-aware body validation (structural). Tagged-result + throwing variants.
- exports: `NodeBodyValidationError`, `ValidationResult`, `validateBody`, `assertValidBody`
- collaborators: `../types.ts`
- external_deps: (none)
- sekkei_capability: `authoring`
- proposed_component_id: `kizo:dev.glm.authoring.node_body_validator`

### `src/domain/scr.ts`
- responsibility: SCR finite-state machine — `nextStatus`, `apply`, `canApply`, `isTerminal`. Pure.
- FSM (verbatim):
  - states: `Draft, Submitted, Under Review, Approved, Returned, Rejected, Implemented, Released`
  - events: `submit, startReview, approve, return, reject, reopen, implement, release`
  - transitions:
    - `Draft --submit--> Submitted`
    - `Submitted --startReview--> Under Review`
    - `Under Review --approve--> Approved`
    - `Under Review --return--> Returned`
    - `Under Review --reject--> Rejected`
    - `Returned --reopen--> Draft`
    - `Approved --implement--> Implemented`
    - `Implemented --release--> Released`
  - terminal: `Rejected`, `Released`
- exports: `ScrEvent`, `InvalidScrTransitionError`, `nextStatus`, `apply`, `canApply`, `isTerminal`
- collaborators: `../types.ts`
- external_deps: (none)
- sekkei_capability: `change_management`
- proposed_component_id: `kizo:dev.glm.change_management.scr_fsm`

### `src/domain/cel.ts`
- responsibility: Minimal CEL-style expression evaluator (tokenize → parse → eval). Supported: comparisons, logical, `in`, identifiers with dot-access, literals, list literals; special-case `.length` on strings/arrays. Used for constraint evaluation in variant resolution.
- exports: `CelParseError`, `CelUnsupportedError`, `CelValue`, `CelBindings`, `evaluate`, `evaluateConstraint`
- collaborators: (none)
- external_deps: (none)
- sekkei_capability: `authoring`
- proposed_component_id: `kizo:dev.glm.authoring.cel_evaluator`

### `src/domain/content-hash.ts`
- responsibility: Canonical-JSON serializer + sha256 content addressing (`HASH_PREFIX = 'sha256:'`). Repositories call this on every write and verify on every read.
- exports: `HASH_PREFIX`, `JsonValue`, `canonicalize`, `contentHash`, `verifyContentHash`, `ContentHashMismatchError`
- collaborators: (none)
- external_deps: `node:crypto`
- sekkei_capability: `persistence`
- proposed_component_id: `kizo:dev.glm.persistence.content_hash`

### `src/domain/drift.ts`
- responsibility: Drift classifier. Pure `classify({desiredHash, observedHash, kind, policy, suspended})` → `{status, kind, policy, shouldAutoHeal, detail}`. Plus `selectAutoHealable`.
- States (verbatim): `Synced, Hash-Drifted, Live-Drifted, Suspended`. Kinds: `none, hash, live_state`. Policies: `auto-heal, alert, suspend`.
- exports: `DriftInput`, `DriftClassification`, `classify`, `selectAutoHealable`
- collaborators: `../types.ts`
- external_deps: (none)
- sekkei_capability: `drift_reconciliation`
- proposed_component_id: `kizo:dev.glm.drift_reconciliation.drift_classifier`

### `src/domain/relationships.ts`
- responsibility: Where-used traversal — `directDependents`, `transitiveConsumers` (BFS upward), `whereUsed`, `estimateImpact`. Pure.
- exports: `NodeWithRels`, `DirectDependent`, `TransitiveConsumer`, `WhereUsedResult`, `directDependents`, `transitiveConsumers`, `whereUsed`, `estimateImpact`
- collaborators: `../types.ts`
- external_deps: (none)
- sekkei_capability: `authoring`
- proposed_component_id: `kizo:dev.glm.authoring.where_used`

### `src/domain/variant.ts`
- responsibility: Six-step variant resolution pipeline. Pure `resolve()`. Steps: closure walk (composes-of + derives-from + derives_from_node_id lineage), parameter binding (apply defaults, report missing), constraint validation (CEL), external dep collection, cache key hash computation (closure/binding/design/generator/generation hashes), `sekkei.lock` emission.
- exports: `ResolveInput`, `ResolverNode`, `StepResult`, `ConstraintResult`, `LockEntry`, `ResolutionResult`, `resolve`
- collaborators: `./content-hash.ts`, `./cel.ts`, `../types.ts`
- external_deps: `node:crypto`
- sekkei_capability: `variant_resolution`
- proposed_component_id: `kizo:dev.glm.variant_resolution.resolver`

### `src/auth/api-token.ts`
- responsibility: Issue + validate API tokens. Format `glm_<prefix-8>_<random-32hex>`, stored as sha256 with per-token salt. Constant-time compare.
- exports: `InvalidApiTokenError`, `IssuedToken`, `IssueOptions`, `issueApiToken`, `validateApiToken`, `readBearer`
- collaborators: `../repository/api-token-repository.ts`
- external_deps: `node:crypto`
- sekkei_capability: `identity`
- proposed_component_id: `kizo:dev.glm.identity.api_token`

### `src/auth/roles.ts`
- responsibility: RBAC gates — two layers (org UserRole, workspace WorkspaceMemberRole). Throws `ForbiddenError`.
- exports: `ForbiddenError`, `hasUserRole`, `hasMemberRole`, `requireUserRole`, `requireMemberRole`
- collaborators: `../types.ts`
- external_deps: (none)
- sekkei_capability: `identity`
- proposed_component_id: `kizo:dev.glm.identity.rbac`

### `src/auth/session.ts`
- responsibility: Signed-cookie session. 7-day TTL. Cookie name `glm_session`. HMAC-SHA256.
- exports: `COOKIE_NAME`, `DEFAULT_TTL_MS`, `SessionPayload`, `InvalidSessionError`, `signSession`, `verifySession`, `buildSetCookie`, `buildClearCookie`, `readSessionCookie`, `generateSecret`
- collaborators: (none)
- external_deps: `node:crypto`
- sekkei_capability: `identity`
- proposed_component_id: `kizo:dev.glm.identity.session`

### `src/agent/intent.ts`
- responsibility: Vibe Mode intent classification — 4 regex rules → scenario `archive`/`multi`/`drift`/`promote`. Unmatched → null.
- exports: `ScenarioKey`, `ClassifiedIntent`, `classifyIntent`
- collaborators: (none)
- external_deps: (none)
- sekkei_capability: `agent_orchestration`
- proposed_component_id: `kizo:dev.glm.agent_orchestration.intent_classifier`

### `src/agent/scripts.ts`
- responsibility: Vibe Mode scripted scenarios + cards (archive, multi, drift, promote). Includes `FORMAL_GATE_INVARIANTS` (4 things the agent must never bypass).
- exports: `ScenarioKey`, `CardKind` (10 kinds), `Card` union, `SUGGESTIONS`, `FORMAL_GATE_INVARIANTS`, `SCRIPTS`, continuation functions.
- collaborators: (none, pure data + functions)
- external_deps: (none)
- sekkei_capability: `agent_orchestration`
- proposed_component_id: `kizo:dev.glm.agent_orchestration.vibe_scripts`

### `src/generation/attestation.ts`
- responsibility: in-toto Statement v1 + DSSE envelope. `HmacSigner` (dev), `buildStatement`, `buildDsseEnvelope`, `verifyDsseEnvelope`, `decodeStatement`, deterministic `rekorEntryId`/`rekorUrl`.
- exports: `STATEMENT_TYPE`, `PREDICATE_TYPE`, `DSSE_PAYLOAD_TYPE`, `REKOR_URL_PREFIX`, `InTotoStatement`, `DsseEnvelope`, `StatementInput`, `buildStatement`, `dsseEncode`, `AttestationSigner`, `HmacSigner`, `buildDsseEnvelope`, `VerificationResult`, `verifyDsseEnvelope`, `DsseDecodeError`, `decodeStatement`, `rekorEntryId`, `rekorUrl`
- collaborators: `../types.ts`
- external_deps: `node:crypto`
- sekkei_capability: `provenance`
- proposed_component_id: `kizo:dev.glm.provenance.attestation_builder`

### `src/generation/cache.ts`
- responsibility: Content-addressed cache for generated artifacts. `InMemoryGenerationCache` + `FileSystemGenerationCache` (atomic write into `<prefix>/<rest>/<safe-filename>` with `/`/`\` → `__SLASH__`).
- exports: `CacheKeyInput`, `generationHash`, `CacheGetResult`, `GenerationCache`, `InMemoryGenerationCache`, `FileSystemGenerationCache`
- collaborators: `../domain/content-hash.ts`, `../types.ts`
- external_deps: `node:crypto`, `node:fs`, `node:path`
- sekkei_capability: `generation`
- proposed_component_id: `kizo:dev.glm.generation.artifact_cache`

### `src/generation/llm-client.ts`
- responsibility: LLM provider abstraction. `FakeLlmClient` (canned responses) + `AnthropicLlmClient` (fetch-based Messages API, cache_control:ephemeral; default model claude-sonnet-4-6).
- exports: `LlmGenerateInput`, `LlmGenerateResult`, `LlmClient`, `FakeLlmClient`, `FakeLlmResponse`, `AnthropicLlmClient`, `AnthropicClientOptions`
- collaborators: (none)
- external_deps: `fetch`
- sekkei_capability: `generation`
- proposed_component_id: `kizo:dev.glm.generation.llm_client`

### `src/generation/pipeline.ts`
- responsibility: Generation pipeline. compute cache key → probe cache → on miss invoke LLM → compute artifact digest → build Statement + DSSE → persist `provenance_events` + `generation_attestations` rows.
- exports: `PipelineInput`, `PipelineResult`, `PipelineDeps`, `runPipeline`
- collaborators: `./attestation.ts`, `./cache.ts`, `./llm-client.ts`, `../domain/content-hash.ts`, `../repository/attestation-repository.ts`, `../repository/provenance-repository.ts`, `../types.ts`
- external_deps: `node:crypto`
- sekkei_capability: `generation`
- proposed_component_id: `kizo:dev.glm.generation.pipeline`

### `src/generation/queue.ts`
- responsibility: In-process FIFO queue with concurrency cap.
- exports: `QueuedJob`, `JobHandler`, `JobResult`, `QueueOptions`, `GenerationQueue<T,R>`
- collaborators: (none)
- external_deps: (none)
- sekkei_capability: `generation`
- proposed_component_id: `kizo:dev.glm.generation.queue`

### `src/git/git-client.ts`
- responsibility: Typed wrapper around `git` CLI via spawnSync. `GitClient` — init/config/add/commit (msg via stdin)/showMessage/logGrep/showFiles/showFile/revParse/branch/checkout/tag/statusPorcelain. `GitError` on non-zero exit.
- exports: `GitError`, `GitClientOptions`, `GitCommitOptions`, `GitCommitInfo`, `GitLogEntry`, `GitClient`
- collaborators: (none)
- external_deps: `node:child_process`
- sekkei_capability: `git`
- proposed_component_id: `kizo:dev.glm.git.git_client`

### `src/git/git-notes.ts`
- responsibility: `git notes` wrapper. Default ref `refs/notes/generation`.
- exports: `GitNotesClient`
- collaborators: `./git-client.ts`
- external_deps: (none)
- sekkei_capability: `git`
- proposed_component_id: `kizo:dev.glm.git.git_notes`

### `src/git/hook-installer.ts`
- responsibility: Installs `pre-commit` (verify_sekkei.py + null-byte check) and `pre-receive` (Affected: block + 6-gate verifier when GLM_DB_PATH+GLM_WORKSPACE set) hooks.
- exports: `PRE_COMMIT_HOOK`, `PRE_RECEIVE_HOOK`, `HookInstallOptions`, `installHooks`, `hookInstalled`
- collaborators: (none)
- external_deps: `node:fs`, `node:path`
- sekkei_capability: `git`
- proposed_component_id: `kizo:dev.glm.git.hook_installer`

### `src/git/ecn-commit.ts`
- responsibility: ECN commit message builder + parser. `ECN: <summary>` + `Affected:` + `Why:` + optional `Regen required:` + `SCR: SCR-<n>` + `Signed-off-by:`.
- exports: `EcnMessageError`, `EcnRegen`, `EcnMessageInput`, `buildEcnMessage`, `parseEcnMessage`
- collaborators: (none)
- external_deps: (none)
- sekkei_capability: `git`
- proposed_component_id: `kizo:dev.glm.git.ecn_commit`

### `src/git/yaml-store.ts`
- responsibility: Node-as-YAML serializer + parser. Path `<repoRoot>/nodes/<stratum>/<safe-glm-id>.yaml` (`:` → `__`). Verifies content_hash on read.
- exports: `YamlNode`, `YamlStoreError`, `nodeFilePath`, `safeGlmId`, `serializeNode`, `parseNode`, `yamlToNodeInput`, `writeNodeFile`, `readNodeFile`
- collaborators: `../domain/content-hash.ts`, `../repository/node-repository.ts`, `../types.ts`
- external_deps: `node:fs`, `node:path`, `yaml`
- sekkei_capability: `git`
- proposed_component_id: `kizo:dev.glm.git.yaml_store`

### `src/git/sekkei-lock.ts`
- responsibility: `sekkei.lock` YAML serializer/parser. Deterministic key order. `lockHash`.
- exports: `LockNode`, `SekkeiLock`, `SekkeiLockInput`, `serializeSekkeiLock`, `parseSekkeiLock`, `lockHash`
- collaborators: `../types.ts`
- external_deps: `node:crypto`, `yaml`
- sekkei_capability: `variant_resolution`
- proposed_component_id: `kizo:dev.glm.variant_resolution.sekkei_lock`

### `src/git/sekkei-git-service.ts`
- responsibility: Turns an approved + implemented SCR into one ECN commit. Per-workspace promise-chain mutex. `commitScrImplementation` writes target nodes' YAML, stages, commits (signed when Class I and `GLM_SIGN_COMMITS=true`).
- exports: `ImplementOptions`, `ImplementResult`, `commitScrImplementation`, `nodeFile`
- collaborators: `./ecn-commit.ts`, `./git-client.ts`, `./yaml-store.ts`, `../repository/node-repository.ts`, `../repository/scr-repository.ts`, `../types.ts`
- external_deps: `node:path`
- sekkei_capability: `change_management`
- proposed_component_id: `kizo:dev.glm.change_management.scr_implementer`

### `src/repository/db.ts`
- responsibility: SQLite singleton open + migration runner. Pragmas WAL/NORMAL/FK ON/busy=5000. Migration files `NNNN_<slug>.sql`.
- exports: `OpenDbOptions`, `MigrationRecord`, `openDb`, `closeDb`, `requireDb`, `runMigrations`, `appliedMigrations`
- collaborators: (none)
- external_deps: `bun:sqlite`, `node:fs`, `node:path`
- sekkei_capability: `persistence`
- proposed_component_id: `kizo:dev.glm.persistence.db_bootstrap`

### `src/repository/node-repository.ts`
- responsibility: Repository over `nodes` + `node_parameters` + `node_constraints` + `node_relationships`. Computes/verifies content_hash.
- exports: `NodeInput`, `NodeWithChildren`, `NodeRepository`
- collaborators: `../domain/content-hash.ts`, `../types.ts`
- external_deps: `bun:sqlite`
- sekkei_capability: `authoring`
- proposed_component_id: `kizo:dev.glm.authoring.node_repository`

### `src/repository/api-token-repository.ts`
- responsibility: CRUD on `api_tokens`. `insert`, `findCandidatesByPrefix`, `touchLastUsed`.
- exports: `ApiTokenRow`, `ApiTokenInsert`, `ApiTokenRepository`
- collaborators: (none)
- external_deps: `bun:sqlite`
- sekkei_capability: `identity`
- proposed_component_id: `kizo:dev.glm.identity.api_token_repository`

### `src/repository/attestation-repository.ts`
- responsibility: CRUD on `generation_attestations` (DSSE envelope + Statement persisted alongside provenance event).
- exports: `AttestationRow`, `AttestationInsert`, `AttestationRepository`
- collaborators: (none)
- external_deps: `bun:sqlite`
- sekkei_capability: `provenance`
- proposed_component_id: `kizo:dev.glm.provenance.attestation_repository`

### `src/repository/audit-repository.ts`
- responsibility: Append-only `audit_events`. `append`, `listByWorkspace`, `listByType`.
- exports: `AuditEventInsert`, `AuditRepository`
- collaborators: `../types.ts`
- external_deps: `bun:sqlite`
- sekkei_capability: `observability`
- proposed_component_id: `kizo:dev.glm.observability.audit_repository`

### `src/repository/change-log-repository.ts`
- responsibility: Append-only `change_log` feed of node mutations. `append`, `listSince`, `listLatest`. Powers WebSocket replay + dashboard activity.
- exports: `ChangeLogInsert`, `ChangeLogRepository`
- collaborators: `../types.ts`
- external_deps: `bun:sqlite`
- sekkei_capability: `collaboration`
- proposed_component_id: `kizo:dev.glm.collaboration.change_log_repository`

### `src/repository/drift-repository.ts`
- responsibility: CRUD on `drift_records`. `upsert`, `findById`, `listByStatus`.
- exports: `DriftInsert`, `DriftRepository`
- collaborators: `../types.ts`
- external_deps: `bun:sqlite`
- sekkei_capability: `drift_reconciliation`
- proposed_component_id: `kizo:dev.glm.drift_reconciliation.drift_repository`

### `src/repository/edit-lock-repository.ts`
- responsibility: Soft-lock storage (`edit_locks`). Schema `(node_id, user_id, acquired_at, heartbeat_at)`. `find`, `acquire`, `heartbeat`, `release`, `delete`. 30s TTL per spec §6.2 (route-level sweep).
- exports: `EditLockRepository`
- collaborators: `../types.ts`
- external_deps: `bun:sqlite`
- sekkei_capability: `collaboration`
- proposed_component_id: `kizo:dev.glm.collaboration.edit_lock_repository`

### `src/repository/provenance-repository.ts`
- responsibility: CRUD on `provenance_events`. `insert`, `findById`, `listByWorkspace`, `listBySubject`.
- exports: `ProvenanceInsert`, `ProvenanceRepository`
- collaborators: `../types.ts`
- external_deps: `bun:sqlite`
- sekkei_capability: `provenance`
- proposed_component_id: `kizo:dev.glm.provenance.provenance_repository`

### `src/repository/reuse-repository.ts`
- responsibility: CRUD on `reuse_candidates`. `insert`, `findById`, `list`, `listByStage`, `update`, `delete`.
- exports: `ReuseCandidateInsert`, `ReuseCandidateUpdate`, `ReuseRepository`
- collaborators: `../types.ts`
- external_deps: `bun:sqlite`
- sekkei_capability: `reuse_management`
- proposed_component_id: `kizo:dev.glm.reuse_management.reuse_repository`

### `src/repository/scr-repository.ts`
- responsibility: Repository over `scrs` + `scr_approvals`. `insert`, `setStatus`, `findById`, `listByStatus`, `upsertApproval`, `listApprovals`.
- exports: `ScrInsert`, `ScrApprovalUpsert`, `ScrRepository`
- collaborators: `../types.ts`
- external_deps: `bun:sqlite`
- sekkei_capability: `change_management`
- proposed_component_id: `kizo:dev.glm.change_management.scr_repository`

### `src/repository/user-repository.ts`
- responsibility: CRUD on `users`. `insert`, `findById`, `findByEmail`.
- exports: `UserInsert`, `UserRepository`
- collaborators: `../types.ts`
- external_deps: `bun:sqlite`
- sekkei_capability: `identity`
- proposed_component_id: `kizo:dev.glm.identity.user_repository`

### `src/repository/variant-repository.ts`
- responsibility: Repository over `variants` + `variant_rollout`.
- exports: `VariantInsert`, `VariantRolloutUpsert`, `VariantRepository`
- collaborators: `../types.ts`
- external_deps: `bun:sqlite`
- sekkei_capability: `variant_resolution`
- proposed_component_id: `kizo:dev.glm.variant_resolution.variant_repository`

### `src/repository/verification-run-repository.ts`
- responsibility: Persists workspace verifier run outcomes `(id, workspace_id, ts, gate_results_json, overall_pass)`.
- exports: `VerificationRunInsert`, `VerificationRunRepository`
- collaborators: `../types.ts`
- external_deps: `bun:sqlite`
- sekkei_capability: `verification`
- proposed_component_id: `kizo:dev.glm.verification.verification_run_repository`

### `src/repository/workspace-repository.ts`
- responsibility: Repository over `workspaces` + `workspace_members`.
- exports: `WorkspaceInsert`, `WorkspaceMemberInsert`, `WorkspaceRepository`
- collaborators: `../types.ts`
- external_deps: `bun:sqlite`
- sekkei_capability: `identity`
- proposed_component_id: `kizo:dev.glm.identity.workspace_repository`

### `src/server/server.ts`
- responsibility: Bun.serve bootstrap. Reads `PORT`, `SESSION_SECRET`, opens DB, creates app, listens.
- exports: (none — top-level script)
- collaborators: `../repository/db.ts`, `../auth/session.ts`, `./app.ts`
- external_deps: `Bun`
- sekkei_capability: `runtime`
- proposed_component_id: `kizo:dev.glm.runtime.server_entry`

### `src/server/app.ts`
- responsibility: Hono app factory `createApp(deps, opts)`. Wires middleware, all `/api/v1` routes, PWA static last.
- exports: `CreateAppOptions`, `createApp`
- collaborators: `./deps.ts`, all middleware + routes, `../generation/attestation.ts`, `../ws/event-bus.ts`
- external_deps: `hono`
- sekkei_capability: `runtime`
- proposed_component_id: `kizo:dev.glm.runtime.app_factory`

### `src/server/deps.ts`
- responsibility: `AppDeps`/`RuntimeDeps`/`Repositories` interfaces + `buildRepositories(db, overrides)`. The DI surface.
- exports: `AppDeps`, `RuntimeDeps`, `Repositories`, `buildRepositories`
- collaborators: all repositories, `../git/git-client.ts`, `../generation/*`, `../ws/event-bus.ts`
- external_deps: `bun:sqlite`
- sekkei_capability: `runtime`
- proposed_component_id: `kizo:dev.glm.runtime.deps_container`

### `src/server/middleware/context.ts`
- responsibility: Attach `deps` + `repos` to `c.var`.
- exports: `context(deps)`
- collaborators: `../deps.ts`, `./auth.ts`
- external_deps: `hono`
- sekkei_capability: `runtime`
- proposed_component_id: `kizo:dev.glm.runtime.context_middleware`

### `src/server/middleware/auth.ts`
- responsibility: `identify()` — try Bearer token, then session cookie, then `x-test-user-id` (test-only). `requireAuth`, `requirePrincipal`. Defines `AppEnv`.
- exports: `Principal`, `AppEnv`, `UnauthorizedError`, `identify`, `requireAuth`, `requirePrincipal`
- collaborators: `../../auth/api-token.ts`, `../../auth/session.ts`, `../deps.ts`, `../../types.ts`
- external_deps: `hono`
- sekkei_capability: `identity`
- proposed_component_id: `kizo:dev.glm.identity.auth_middleware`

### `src/server/middleware/error.ts`
- responsibility: Domain-exception → HTTP mapping. UnauthorizedError→401, ForbiddenError→403, NodeBodyValidationError→422, InvalidScrTransitionError→409, ContentHashMismatchError→500. `httpError()` shortcut.
- exports: `errorHandler`, `HttpErrorStatus`, `httpError`
- collaborators: `../../domain/content-hash.ts`, `../../domain/node.ts`, `../../domain/scr.ts`, `../../auth/roles.ts`, `./auth.ts`
- external_deps: `hono`, `hono/http-exception`
- sekkei_capability: `runtime`
- proposed_component_id: `kizo:dev.glm.runtime.error_middleware`

### `src/server/middleware/logging.ts`
- responsibility: Structured per-request logging + `X-Request-Id`. Suppressed under `NODE_ENV=test`; skipped for static paths.
- exports: `requestLogging`
- collaborators: `./auth.ts`
- external_deps: `hono`, `node:crypto`
- sekkei_capability: `observability`
- proposed_component_id: `kizo:dev.glm.observability.request_logging`

### `src/server/middleware/rate-limit.ts`
- responsibility: In-process token-bucket rate limiter. capacity=60 / refillPerSec=10 default. 429 with `Retry-After`.
- exports: `RateLimitOptions`, `rateLimit`
- collaborators: `./auth.ts`
- external_deps: `hono`, `hono/http-exception`
- sekkei_capability: `runtime`
- proposed_component_id: `kizo:dev.glm.runtime.rate_limit`

### `src/server/middleware/security-headers.ts`
- responsibility: CSP (strict), Referrer-Policy, X-Content-Type-Options, X-Frame-Options:DENY, Permissions-Policy, HSTS when HTTPS.
- exports: `SecurityHeadersOptions`, `securityHeaders`
- collaborators: `./auth.ts`
- external_deps: `hono`
- sekkei_capability: `runtime`
- proposed_component_id: `kizo:dev.glm.runtime.security_headers`

### `src/server/routes/auth.ts`
- responsibility: `POST /auth/login` (passwordless dev login), `POST /auth/logout`, `GET /auth/me`.
- exports: `authRoutes`
- collaborators: `../../auth/session.ts`, `../middleware/auth.ts`, `../middleware/error.ts`, `../../types.ts`
- external_deps: `hono`, `node:crypto`
- sekkei_capability: `identity`
- proposed_component_id: `kizo:dev.glm.identity.auth_routes`

### `src/server/routes/workspaces.ts`
- responsibility: `GET /workspaces`, `GET /workspaces/:id`, `GET /workspaces/:id/summary` (Dashboard aggregations).
- exports: `workspaceRoutes`
- collaborators: `../middleware/auth.ts`, `../middleware/error.ts`, `../../types.ts`
- external_deps: `hono`
- sekkei_capability: `identity`
- proposed_component_id: `kizo:dev.glm.identity.workspace_routes`

### `src/server/routes/nodes.ts`
- responsibility: Node CRUD + lock management + where-used. 423 LOCKED on conflict.
- exports: `nodeRoutes`
- collaborators: `../../domain/relationships.ts`, `../../domain/node.ts`, `../../repository/node-repository.ts`, `../middleware/auth.ts`, `../middleware/error.ts`, `../../types.ts`
- external_deps: `hono`, `node:crypto`
- sekkei_capability: `authoring`
- proposed_component_id: `kizo:dev.glm.authoring.node_routes`

### `src/server/routes/scrs.ts`
- responsibility: SCR CRUD + status transitions + approvals. On `implement` → calls `commitScrImplementation` if a git client is registered.
- exports: `scrRoutes`
- collaborators: `../../domain/scr.ts`, `../../git/sekkei-git-service.ts`, `../../repository/scr-repository.ts`, `../middleware/auth.ts`, `../middleware/error.ts`, `../../types.ts`
- external_deps: `hono`, `node:crypto`
- sekkei_capability: `change_management`
- proposed_component_id: `kizo:dev.glm.change_management.scr_routes`

### `src/server/routes/variants.ts`
- responsibility: Variants CRUD + resolve + rollout. Rollout order `Released → Available-on-Channel → Pinned-by-Variant → Generated-for-Instance → Deployed-to-dBOM`. AC-20 refuses advance when pin==available.
- exports: `variantRoutes`
- collaborators: `../../domain/variant.ts`, `../middleware/auth.ts`, `../middleware/error.ts`, `../../types.ts`
- external_deps: `hono`, `node:crypto`
- sekkei_capability: `variant_resolution`
- proposed_component_id: `kizo:dev.glm.variant_resolution.variant_routes`

### `src/server/routes/drift.ts`
- responsibility: `GET /drift`, `POST /drift/sweep`, `PUT /drift/:record_id/resolve` (actions: heal/suspend/waiver/scr; AC-26 waiver needs positive durationDays), `POST /drift/auto-heal` (AC-24).
- exports: `driftRoutes`
- collaborators: `../../domain/drift.ts`, `../middleware/auth.ts`, `../middleware/error.ts`, `../../types.ts`
- external_deps: `hono`, `node:crypto`
- sekkei_capability: `drift_reconciliation`
- proposed_component_id: `kizo:dev.glm.drift_reconciliation.drift_routes`

### `src/server/routes/generation.ts`
- responsibility: `POST /workspaces/:id/generate` runs `runPipeline` synchronously; emits `generation.complete`.
- exports: `generationRoutes`
- collaborators: `../../generation/pipeline.ts`, `../middleware/auth.ts`, `../middleware/error.ts`, `../../types.ts`
- external_deps: `hono`
- sekkei_capability: `generation`
- proposed_component_id: `kizo:dev.glm.generation.generation_routes`

### `src/server/routes/provenance.ts`
- responsibility: List/get provenance events. NDJSON export (AC-34). Server-side re-verification (AC-35).
- exports: `provenanceRoutes`
- collaborators: `../../generation/attestation.ts`, `../middleware/auth.ts`, `../middleware/error.ts`
- external_deps: `hono`
- sekkei_capability: `provenance`
- proposed_component_id: `kizo:dev.glm.provenance.provenance_routes`

### `src/server/routes/reuse.ts`
- responsibility: List/create/stage-advance reuse candidates. `POST /reuse/find-candidates` (AC-28). `PUT /reuse/:rid/stage` (AC-30 requires steward to promote past Candidate-for-Promotion). Stage order `Variant-Local → Candidate-for-Promotion → Promoted-to-Library → Stewarded-by-Owner`.
- exports: `reuseRoutes`
- collaborators: `../../domain/relationships.ts`, `../middleware/auth.ts`, `../middleware/error.ts`, `../../types.ts`
- external_deps: `hono`, `node:crypto`
- sekkei_capability: `reuse_management`
- proposed_component_id: `kizo:dev.glm.reuse_management.reuse_routes`

### `src/server/routes/verifier.ts`
- responsibility: `POST /workspaces/:id/verify` (run 7-gate verifier), `GET /verifier/runs[/latest|/:id]`.
- exports: `verifierRoutes`
- collaborators: `../../verifier/runner.ts`, `../middleware/auth.ts`, `../middleware/error.ts`
- external_deps: `hono`
- sekkei_capability: `verification`
- proposed_component_id: `kizo:dev.glm.verification.verifier_routes`

### `src/server/routes/vibe.ts`
- responsibility: Vibe Mode endpoints. `GET /vibe/scripts`, `POST /vibe/intent`, `POST /vibe/continue`, `POST /vibe/llm-fallback` (AC-40 graceful degradation when no LLM configured).
- exports: `vibeRoutes`
- collaborators: `../../agent/intent.ts`, `../../agent/scripts.ts`, `../middleware/auth.ts`, `../middleware/error.ts`
- external_deps: `hono`
- sekkei_capability: `agent_orchestration`
- proposed_component_id: `kizo:dev.glm.agent_orchestration.vibe_routes`

### `src/server/routes/static.ts`
- responsibility: Static PWA serving. `/`, `/login`, `/manifest.json`, `/sw.js` (with `Service-Worker-Allowed: /`), `/public/*`. Path-traversal blocked.
- exports: `StaticRoutesOptions`, `staticRoutes`
- collaborators: `../middleware/auth.ts`
- external_deps: `hono`, `node:fs`, `node:path`
- sekkei_capability: `distribution`
- proposed_component_id: `kizo:dev.glm.distribution.static_routes`

### `src/verifier/gates.ts`
- responsibility: Pure-function 7-gate verifier. Gates: `1.envelope`, `2.stratum_hierarchy`, `2.b.role_consistency` (system_role discriminator: root/subsystem/platform — exactly 1 root, root cannot be composed-of, subsystem must be composed-of, root requires body.acceptance_gate, subsystem requires body.dbom_ref=null), `3.closure_completeness`, `4.brief_coverage`, `5.spec_coverage` (functional+technical+acceptance+prompt per component), `6.spec_quality` (acceptance: v1.1 deliverables+verifier OR legacy inspection_assertions; prompt: context_bundle+outputs+verifier).
- exports: `NodeRecord`, `GateResult`, `VerifierInput`, `VerifierResult`, `runGates`, `gate1Envelope`, `gate2StratumHierarchy`, `gate2bRoleConsistency`, `gate3ClosureCompleteness`, `gate4BriefCoverage`, `gate5SpecCoverage`, `gate6SpecQuality`
- collaborators: `../domain/node.ts`, `../types.ts`
- external_deps: (none)
- sekkei_capability: `verification`
- proposed_component_id: `kizo:dev.glm.verification.gates`

### `src/verifier/runner.ts`
- responsibility: `runWorkspaceVerifier`: load nodes, run gates, persist `verification_runs`, append audit `verifier.run`, publish `generation.complete` event.
- exports: `RunnerDeps`, `RunOptions`, `runWorkspaceVerifier`
- collaborators: `./gates.ts`, `../repository/audit-repository.ts`, `../repository/node-repository.ts`, `../repository/verification-run-repository.ts`, `../ws/event-bus.ts`, `../types.ts`
- external_deps: `node:crypto`
- sekkei_capability: `verification`
- proposed_component_id: `kizo:dev.glm.verification.runner`

### `src/ws/event-bus.ts`
- responsibility: Workspace-scoped in-process pub/sub. Synchronous fan-out. Event types: `node.changed, node.locked, node.unlocked, scr.created, scr.status_changed, scr.approval_added, drift.detected, drift.resolved, generation.started, generation.progress, generation.complete`.
- exports: `WorkspaceEventType`, `WorkspaceEvent`, `WorkspaceEventHandler`, `Subscription`, `EventBus`
- collaborators: (none)
- external_deps: (none)
- sekkei_capability: `collaboration`
- proposed_component_id: `kizo:dev.glm.collaboration.event_bus`

### `src/ws/workspace-socket.ts`
- responsibility: Bun ServerWebSocket per-socket handler. On open → welcome + subscribe. Messages: ping→pong, replay→stream change_log rows as node.changed events bracketed by replay.start/replay.end.
- exports: `SocketContext`, `SocketDeps`, `makeWebSocketHandler`
- collaborators: `../repository/change-log-repository.ts`, `./event-bus.ts`
- external_deps: `bun` (`ServerWebSocket`)
- sekkei_capability: `collaboration`
- proposed_component_id: `kizo:dev.glm.collaboration.workspace_socket`

### PWA shell (`public/`)

- `public/index.html`, `public/login.html`, `public/manifest.json` — shell + PWA metadata.
- `public/sw.js` — service worker (read-through cache, supports offline read).
- `public/styles/{tokens.css, app.css}` — design tokens + app styles.
- `public/js/api.js` — REST client; same-origin; 401 bubbles to redirect.
- `public/js/store.js` — observable store.
- `public/js/router.js` — hash-based router.
- `public/js/ws.js` — workspace WebSocket client.
- `public/js/node-lock.js` — soft-lock helper.
- `public/js/offline-queue.js` — write-queue while offline.
- `public/js/app.js` — top-level boot.
- `public/js/views/{dashboard, change-management, drift, effectivity, provenance, reuse, sekkei-browser, variants, vibe-mode, where-used}.js` — 10 views.
- `public/js/components/{class-badge, diff-block, empty, hash, index, kv, section, status-pill, stratum-tag, yaml-block}.js` — 10 UI atoms.
- sekkei_capability: `distribution`
- proposed_component_id parent: `kizo:dev.glm.distribution.pwa_shell`

---

## 2. Concepts the speculative sekkei missed (or got wrong)

### `agent/` — Vibe Mode (scripted, not LLM-driven)
A "Vibe Mode" agent surface (spec §5.10). Two TS files: `intent.ts` (4-regex classifier → `archive`/`multi`/`drift`/`promote` or null) and `scripts.ts` (≈480 lines of hand-coded scenarios — card sequences with `agent_text`/`plan`/`console`/`clarifier`/`scr_draft`/`gate`/`choice`/`drift_card`/`resolution_card`/`result` kinds — plus `FORMAL_GATE_INVARIANTS` listing 4 things the agent must never bypass). The endpoints (`/vibe/scripts`, `/vibe/intent`, `/vibe/continue`, `/vibe/llm-fallback`) never execute a gate themselves; the cards include `link.tab` pointers + `gate.actions` buttons that the frontend turns into real REST calls against the regular routes. The LLM is only the *fallback* path — out-of-scripted messages go to `c.var.deps.llm` with a 256-token cap, and AC-40 says it must gracefully degrade with a canned reply when no LLM is configured.

### `scr` — Sekkei Change Request
A first-class entity (FSM in `domain/scr.ts`, table `scrs` + `scr_approvals` via `scr-repository.ts`, routes at `/workspaces/:id/scrs`). Two classes: `I` (contract change — requires platform-review approval) and `II` (internal, solo-dev approval). 8 statuses. Body fields: `problem`, `diffYaml` (typed diff lines: `context|add|remove|change`), `targetNodes` (`glm:` ids), `effectivity`, `impact` (`{variantsAffected, tokensEst, cacheMissCount}`), `returnReason`. The `Implemented` transition (on `PUT /scrs/:id/status` with event=`implement`) optionally writes affected nodes' YAML and creates an ECN commit via `commitScrImplementation` (per-workspace promise-chain mutex).

### `vibe` route
The HTTP face of Vibe Mode. NOT a casual-authoring shortcut — it's a guided demo-runner that calls the normal authoring/SCR/drift/reuse APIs underneath.

### `reuse`
A `reuse_candidates` table (with `id, workspace_id, subtree, title, stage, rationale, usages, invariants_held_in, steward`) plus 4-stage machine: `Variant-Local → Candidate-for-Promotion → Promoted-to-Library → Stewarded-by-Owner`. `POST /reuse/find-candidates` scans the graph: anything with ≥2 direct dependents (via `whereUsed`) becomes a `Variant-Local` row (AC-28). Promotion past `Candidate-for-Promotion` requires a steward (AC-30).

### WebSocket — confirmed (not SSE)
`ws/event-bus.ts` is the in-process pub/sub; `ws/workspace-socket.ts` is the Bun ServerWebSocket handler. Event types: `node.changed`, `node.locked`, `node.unlocked`, `scr.created`, `scr.status_changed`, `scr.approval_added`, `drift.detected`, `drift.resolved`, `generation.started`, `generation.progress`, `generation.complete`. Client may send `{type:'ping'}` → `{type:'pong'}` or `{type:'replay', since:'<iso>'}` → server replays change_log entries as `node.changed` events bracketed by `replay.start`/`replay.end`. CSP allows `connect-src 'self' ws: wss:`.

### `cel.ts` — CEL expression evaluator
Minimal CEL-style evaluator (comparisons, `&&/||/!`, `in`, identifiers with dot access, literals, list literals, `.length` accessor on strings/arrays). Used by `domain/variant.ts:resolve()` step 3 (constraint validation against the resolved binding) — every `NodeConstraint.expression` flows through `evaluateConstraint()`, returning `{passed, reason}` and never throwing. NOT used by the verifier gates; that's a separate code path.

### `edit-lock-repository` — yes, this is the soft-lock manager
Confirmed. Per-node, per-user. Schema `(node_id, user_id, acquired_at, heartbeat_at)`. Exposes `find`, `acquire` (returns `{granted: false, lock}` if held by another), `heartbeat` (only if caller holds the lock), `release`. 30-second TTL per spec §6.2 (route-level, not repo-swept). HTTP status 423 LOCKED on conflict. `node.locked` / `node.unlocked` events fan out via EventBus.

### `verification-run-repository` — persisted gate runs
A `verification_runs` row is the persisted outcome of running the 7-gate verifier over a workspace. Schema `(id, workspace_id, ts, gate_results_json, overall_pass)`. `gate_results_json` stores `{gates: [{name, passed, issues}]}`. This is NOT a record of per-spec-acceptance-verifier-command runs — the realization's `verifier` is the sekkei-shape verifier (not running spec.acceptance verifier scripts).

### `attestation-repository` vs `generation/attestation.ts`
- `generation/attestation.ts` = **producer**: builds the in-toto Statement, DSSE envelope, signs (HmacSigner — dev key, Ed25519 planned), verifies, computes deterministic `rekorEntryId`.
- `repository/attestation-repository.ts` = **store**: persists `(id, provenance_event_id, workspace_id, statement_json, dsse_json, key_id, rekor_entry_id, created_at)` in the `generation_attestations` table.
The pipeline (`generation/pipeline.ts`) is the ONLY producer of attestation rows. Provenance routes both read the table and offer NDJSON export + server-side re-verification of every DSSE envelope.

---

## 3. Capability-level shape (after the inventory)

The speculative sekkei had 11 Capabilities under 2 Sub-Systems (`workbench` + `engine`). The realization does NOT have that Sub-System partition. Propose flattening to a single Sub-System (the runtime itself) with **15-16 Capabilities**:

1. **identity** — users, sessions, API tokens, RBAC, workspaces, auth middleware/routes. Components: `user_repository`, `workspace_repository`, `api_token`, `api_token_repository`, `session`, `rbac`, `auth_middleware`, `auth_routes`, `workspace_routes`.

2. **authoring** — node model + writes/reads + where-used + CEL constraint language. Components: `node_body_validator`, `node_repository`, `node_routes`, `where_used`, `cel_evaluator`.

3. **collaboration** — soft-locks, change log, WebSocket fan-out, event bus. Components: `edit_lock_repository`, `change_log_repository`, `event_bus`, `workspace_socket`.

4. **change_management** — SCR FSM, repository, routes, SCR→git commit service. Components: `scr_fsm`, `scr_repository`, `scr_routes`, `scr_implementer`.

5. **variant_resolution** — 6-step pipeline, variants/rollouts, sekkei.lock. Components: `resolver`, `variant_repository`, `variant_routes`, `sekkei_lock`.

6. **generation** — LLM client, pipeline, queue, artifact cache. Components: `llm_client`, `pipeline`, `queue`, `artifact_cache`, `generation_routes`.

7. **provenance** — in-toto Statement + DSSE attestation builder, store, routes. Components: `attestation_builder`, `attestation_repository`, `provenance_repository`, `provenance_routes`.

8. **drift_reconciliation** — classifier + storage + routes; auto-heal + waiver flows. Components: `drift_classifier`, `drift_repository`, `drift_routes`.

9. **reuse_management** — candidate scan + 4-stage promotion + steward gate. Components: `reuse_repository`, `reuse_routes`.

10. **verification** — 7 gates + persisted runs + audit emission. Components: `gates`, `runner`, `verification_run_repository`, `verifier_routes`.

11. **agent_orchestration** — Vibe Mode (scripted scenarios + intent classifier + LLM fallback). Components: `intent_classifier`, `vibe_scripts`, `vibe_routes`.

12. **git** — git CLI client, notes, hooks, ECN commit grammar, YAML store. Components: `git_client`, `git_notes`, `hook_installer`, `ecn_commit`, `yaml_store`.

13. **persistence** — db bootstrap + migrations + domain types + content addressing. Components: `db_bootstrap`, `content_hash`, `domain_types`.

14. **runtime** — Bun + Hono bootstrap, DI container, runtime middleware. Components: `server_entry`, `app_factory`, `deps_container`, `context_middleware`, `error_middleware`, `rate_limit`, `security_headers`.

15. **observability** — request logging + audit feed. Components: `audit_repository`, `request_logging`.

16. **distribution** — PWA shell + static serving. Components: `static_routes`, `pwa_shell` (with view/module sub-components).

---

## 4. Drift report — speculative vs realized

### Speculative Sub-Systems
- `workbench` — **DROP**. No such code-level boundary exists.
- `engine` — **DROP**. No separate process.

### Speculative Capabilities

| Speculative Capability | Verdict | Notes |
|---|---|---|
| identity | KEEP | Realized as `identity`. |
| persistence | RENAME/SPLIT | Each repository is a Component of its owning Capability; `persistence` becomes db + content-hash + types. |
| audit | MERGE→`observability` | Realized as `audit_events` + request logging. |
| observability | KEEP | Owns request logging + audit feed. |
| distribution | KEEP | PWA shell + static routes. |
| workbench.authoring | RENAME→`authoring` | Drop sub-system prefix. |
| workbench.collaboration | RENAME→`collaboration` | Drop sub-system prefix. |
| workbench.review | DROP/MERGE | "Review" as separate Capability doesn't exist; reviewing is `change_management` (SCR FSM) + `verification` (gates). |
| engine.generation | RENAME→`generation` | LLM client + pipeline + queue + cache + routes. |
| engine.cache | MERGE→`generation` | `generation/cache.ts` is a Component of `generation`. |
| engine.verification | RENAME→`verification` | 7 gates + runner + run repo + routes. |

### Realized Capabilities the speculative sekkei missed — **NEW**

- `change_management` — SCRs first-class. NEW.
- `variant_resolution` — 6-step pipeline + variants/rollouts + sekkei.lock. NEW.
- `provenance` — distinct from generation: builders, store, routes for in-toto/DSSE/Rekor. NEW.
- `drift_reconciliation` — classifier + store + routes + auto-heal/waiver flows. NEW.
- `reuse_management` — candidate scan + 4-stage promotion + steward. NEW.
- `agent_orchestration` — Vibe Mode. NEW.
- `git` — typed git CLI + notes + hooks + ECN + YAML store + sekkei-git service. NEW.
- `runtime` — Bun entry + Hono factory + DI container + middleware. NEW.

### Realized Components — **NEW** (high-impact, easy to miss)

- `vibe_scripts` — 480 lines of hand-coded card scenarios + the explicit `FORMAL_GATE_INVARIANTS` declaration.
- `intent_classifier` — 4-regex matcher with `null` fallback to LLM.
- `ecn_commit` — ECN message grammar + parser.
- `hook_installer` — installs pre-commit + pre-receive shell scripts.
- `sekkei_lock` — sekkei.lock YAML serializer + content hashing of the lock file.
- `attestation_builder` (vs `attestation_repository`) — producer/store split.
- `drift_classifier` — pure function returning the (status, shouldAutoHeal, detail) classification.
- `cel_evaluator` — tokenizer + parser + AST evaluator with its own error types.
- `scr_implementer` — per-workspace promise-chain mutex.

### FSMs found and copied verbatim

1. **SCR (domain/scr.ts):**
   - states: `Draft, Submitted, Under Review, Approved, Returned, Rejected, Implemented, Released`
   - events: `submit, startReview, approve, return, reject, reopen, implement, release`
   - transitions: `Draft--submit→Submitted`; `Submitted--startReview→Under Review`; `Under Review--approve→Approved`; `Under Review--return→Returned`; `Under Review--reject→Rejected`; `Returned--reopen→Draft`; `Approved--implement→Implemented`; `Implemented--release→Released`
   - terminal: `Rejected, Released`

2. **Drift (domain/drift.ts + types.ts):**
   - statuses: `Synced, Hash-Drifted, Live-Drifted, Suspended`
   - kinds: `none, hash, live_state`
   - policies: `auto-heal, alert, suspend`
   - rules (paraphrased from `classify()`): suspended → `Suspended`; kind=none → `Synced`; observed=null → drift status per kind, auto-heal iff policy=auto-heal; desired==observed → `Synced`; otherwise → drift status by kind, auto-heal iff policy=auto-heal AND kind=live_state.

3. **Variant rollout (server/routes/variants.ts):**
   - order: `Released → Available-on-Channel → Pinned-by-Variant → Generated-for-Instance → Deployed-to-dBOM`
   - advance refuses when `pinRev === availableRev` (AC-20)

4. **Reuse stage (server/routes/reuse.ts):**
   - order: `Variant-Local → Candidate-for-Promotion → Promoted-to-Library → Stewarded-by-Owner`
   - one-step-at-a-time only; `Promoted-to-Library` requires steward (AC-30)

5. **WebSocket event types (ws/event-bus.ts):**
   - `node.changed, node.locked, node.unlocked, scr.created, scr.status_changed, scr.approval_added, drift.detected, drift.resolved, generation.started, generation.progress, generation.complete`

6. **Vibe Mode `FORMAL_GATE_INVARIANTS` (agent/scripts.ts) — verbatim:**
   - "Class I SCRs always route to platform-review for approval; the agent cannot self-approve."
   - "auto-heal on live-state drift is only executed if the node's configured policy is auto-heal."
   - "Waivers always carry a positive duration and produce an audit_event."
   - "The agent may draft, propose, and submit — but never transition Under Review → Approved unilaterally."

7. **Acceptance-criteria identifiers referenced inline:** AC-07, AC-08, AC-14, AC-16, AC-19, AC-20, AC-21, AC-24, AC-26, AC-28, AC-30, AC-32, AC-33, AC-34, AC-35, AC-36, AC-40.
