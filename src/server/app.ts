import { Hono } from 'hono';
import { type AppDeps, buildRepositories, type RuntimeDeps } from './deps.ts';
import { context } from './middleware/context.ts';
import { errorHandler } from './middleware/error.ts';
import { identify, type AppEnv } from './middleware/auth.ts';
import { requestLogging } from './middleware/logging.ts';
import { rateLimit } from './middleware/rate-limit.ts';
import { securityHeaders } from './middleware/security-headers.ts';
import { authRoutes } from './routes/auth.ts';
import { workspaceRoutes } from './routes/workspaces.ts';
import { nodeRoutes } from './routes/nodes.ts';
import { scrRoutes } from './routes/scrs.ts';
import { variantRoutes } from './routes/variants.ts';
import { driftRoutes } from './routes/drift.ts';
import { provenanceRoutes } from './routes/provenance.ts';
import { generationRoutes } from './routes/generation.ts';
import { importRoutes } from './routes/import.ts';
import { reuseRoutes } from './routes/reuse.ts';
import { staticRoutes } from './routes/static.ts';
import { releaseRoutes } from './routes/releases.ts';
import { verifierRoutes } from './routes/verifier.ts';
import { vibeRoutes } from './routes/vibe.ts';
import { soloGenerateRoutes } from './routes/solo-generate.ts';
import { componentSpecRoutes } from './routes/component-spec.ts';
import { acceptanceVerifyRoutes } from './routes/acceptance-verify.ts';
import { recordGenerationRoutes } from './routes/record-generation.ts';
import { HmacSigner } from '../generation/attestation.ts';
import { EventBus } from '../ws/event-bus.ts';
import { GitClient } from '../git/git-client.ts';

/**
 * Build the Hono application.
 *
 * The factory resolves `AppDeps` into `RuntimeDeps` (concrete repos, clock,
 * event bus) and binds them to every request via `context()`. Routes are
 * registered under `/api/v1/`. `GET /api/v1/health` stays unauthenticated.
 */
export interface CreateAppOptions {
  /** Override the directory served as the PWA shell (defaults to `<cwd>/public`). */
  publicDir?: string;
}

export function createApp(input: AppDeps, opts: CreateAppOptions = {}): { app: Hono<AppEnv>; deps: RuntimeDeps } {
  const deps: RuntimeDeps = {
    ...input,
    clock: input.clock ?? (() => new Date()),
    cookieSecure: input.cookieSecure ?? process.env.NODE_ENV === 'production',
    allowTestAuthHeader: input.allowTestAuthHeader ?? process.env.NODE_ENV === 'test',
    lockTtlMs: input.lockTtlMs ?? 30_000,
    events: input.events ?? new EventBus(),
    repos: buildRepositories(input.db, input.repos),
    getSekkeiGit: input.getSekkeiGit ?? ((workspaceId: string) => {
      const row = input.db
        .prepare('SELECT git_clone_dir FROM workspaces WHERE id = ?')
        .get(workspaceId) as { git_clone_dir: string | null } | undefined;
      if (!row?.git_clone_dir) return null;
      return new GitClient({ repoPath: row.git_clone_dir });
    }),
    getRealizationGit: input.getRealizationGit ?? (() => null),
    llm: input.llm ?? null,
    generationCache: input.generationCache ?? null,
    attestationSigner: input.attestationSigner ?? new HmacSigner(),
  };

  const app = new Hono<AppEnv>();
  app.onError(errorHandler);

  app.use('*', context(deps));
  app.use('*', requestLogging());
  app.use('*', securityHeaders());
  app.use('*', identify());
  // Hardening: throttle auth attempts more aggressively than reads.
  app.use('/api/v1/auth/*', rateLimit({ capacity: 12, refillPerSec: 0.2, scope: '/api/v1/auth/' }));

  app.get('/api/v1/health', (c) =>
    c.json({ ok: true, service: 'glm', version: '0.1.0' }),
  );

  const api = new Hono<AppEnv>();
  api.route('/', authRoutes());
  api.route('/', workspaceRoutes());
  api.route('/', nodeRoutes());
  api.route('/', scrRoutes());
  api.route('/', variantRoutes());
  api.route('/', driftRoutes());
  api.route('/', provenanceRoutes());
  api.route('/', generationRoutes());
  api.route('/', reuseRoutes());
  api.route('/', releaseRoutes());
  api.route('/', verifierRoutes());
  api.route('/', vibeRoutes());
  api.route('/', soloGenerateRoutes());
  api.route('/', componentSpecRoutes());
  api.route('/', acceptanceVerifyRoutes());
  api.route('/', recordGenerationRoutes());
  api.route('/', importRoutes());
  app.route('/api/v1', api);

  // PWA shell (must register last so /api/v1 takes precedence over any clash)
  app.route('/', staticRoutes({ publicDir: opts.publicDir }));

  return { app, deps };
}
