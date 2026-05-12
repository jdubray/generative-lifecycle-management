import type { Database } from 'bun:sqlite';
import type { GitClient } from '../git/git-client.ts';
import type { LlmClient } from '../generation/llm-client.ts';
import type { GenerationCache } from '../generation/cache.ts';
import type { AttestationSigner } from '../generation/attestation.ts';
import { ApiTokenRepository } from '../repository/api-token-repository.ts';
import { AttestationRepository } from '../repository/attestation-repository.ts';
import { AuditRepository } from '../repository/audit-repository.ts';
import { ChangeLogRepository } from '../repository/change-log-repository.ts';
import { DriftRepository } from '../repository/drift-repository.ts';
import { EditLockRepository } from '../repository/edit-lock-repository.ts';
import { NodeRepository } from '../repository/node-repository.ts';
import { ProvenanceRepository } from '../repository/provenance-repository.ts';
import { ReuseRepository } from '../repository/reuse-repository.ts';
import { ScrRepository } from '../repository/scr-repository.ts';
import { UserRepository } from '../repository/user-repository.ts';
import { VariantRepository } from '../repository/variant-repository.ts';
import { GenerationInputsRepository } from '../repository/generation-inputs-repository.ts';
import { RolloutRepository } from '../repository/rollout-repository.ts';
import { VerificationRunRepository } from '../repository/verification-run-repository.ts';
import { WorkspaceRepository } from '../repository/workspace-repository.ts';
import { WorkspaceConflictsRepository } from '../repository/workspace-conflicts-repository.ts';
import { EventBus } from '../ws/event-bus.ts';

/**
 * Application-wide dependencies passed to `createApp(deps)`. Everything that
 * depends on side-effectful infrastructure (DB, clock, event bus, secrets)
 * lives here so route handlers stay pure and unit-testable.
 */
export interface AppDeps {
  db: Database;
  sessionSecret: string;
  /** When set, `Set-Cookie` includes `Secure`. Defaults to true in production. */
  cookieSecure?: boolean;
  /** When true, requests bearing `x-test-user-id` are authenticated as that user. */
  allowTestAuthHeader?: boolean;
  /** Override `Date.now`/`new Date()` for deterministic tests. */
  clock?: () => Date;
  /** Lock TTL in milliseconds (spec §6.2: 30 s). */
  lockTtlMs?: number;
  /** Optional event bus; created automatically when omitted. */
  events?: EventBus;
  repos?: Partial<Repositories>;
  /**
   * Optional factory for a per-workspace git client. When set, the SCR
   * `implement` transition writes affected nodes to disk and creates an
   * ECN commit (spec §9.5).
   */
  getSekkeiGit?: (workspaceId: string) => GitClient | null;
  /**
   * Optional factory for the `glm-realization/` git client. When set, drift
   * sweeps compare actual file hashes against the desired hashes from the DB.
   */
  getRealizationGit?: (workspaceId: string) => GitClient | null;
  /** LLM provider for the generation pipeline. Required for /generate. */
  llm?: LlmClient;
  /** Content-addressed cache for generated artifacts. */
  generationCache?: GenerationCache;
  /** DSSE signer for attestations (defaults to a dev HMAC signer). */
  attestationSigner?: AttestationSigner;
}

/** AppDeps after the factory has resolved repositories + event bus. */
export interface RuntimeDeps extends AppDeps {
  repos: Repositories;
  events: EventBus;
  clock: () => Date;
  lockTtlMs: number;
  cookieSecure: boolean;
  allowTestAuthHeader: boolean;
  getSekkeiGit: (workspaceId: string) => GitClient | null;
  getRealizationGit: (workspaceId: string) => GitClient | null;
  llm: LlmClient | null;
  generationCache: GenerationCache | null;
  attestationSigner: AttestationSigner;
}

export interface Repositories {
  users: UserRepository;
  workspaces: WorkspaceRepository;
  workspaceConflicts: WorkspaceConflictsRepository;
  nodes: NodeRepository;
  locks: EditLockRepository;
  scrs: ScrRepository;
  variants: VariantRepository;
  drift: DriftRepository;
  provenance: ProvenanceRepository;
  changeLog: ChangeLogRepository;
  audit: AuditRepository;
  apiTokens: ApiTokenRepository;
  attestations: AttestationRepository;
  reuse: ReuseRepository;
  verificationRuns: VerificationRunRepository;
  generationInputs: GenerationInputsRepository;
  rollout: RolloutRepository;
}

export function buildRepositories(db: Database, overrides: Partial<Repositories> = {}): Repositories {
  return {
    users: overrides.users ?? new UserRepository(db),
    workspaces: overrides.workspaces ?? new WorkspaceRepository(db),
    workspaceConflicts: overrides.workspaceConflicts ?? new WorkspaceConflictsRepository(db),
    nodes: overrides.nodes ?? new NodeRepository(db),
    locks: overrides.locks ?? new EditLockRepository(db),
    scrs: overrides.scrs ?? new ScrRepository(db),
    variants: overrides.variants ?? new VariantRepository(db),
    drift: overrides.drift ?? new DriftRepository(db),
    provenance: overrides.provenance ?? new ProvenanceRepository(db),
    changeLog: overrides.changeLog ?? new ChangeLogRepository(db),
    audit: overrides.audit ?? new AuditRepository(db),
    apiTokens: overrides.apiTokens ?? new ApiTokenRepository(db),
    attestations: overrides.attestations ?? new AttestationRepository(db),
    reuse: overrides.reuse ?? new ReuseRepository(db),
    verificationRuns: overrides.verificationRuns ?? new VerificationRunRepository(db),
    generationInputs: overrides.generationInputs ?? new GenerationInputsRepository(db),
    rollout: overrides.rollout ?? new RolloutRepository(db),
  };
}
