import { randomUUID } from 'node:crypto';
import type { AuditRepository } from '../repository/audit-repository.ts';
import type { NodeRepository } from '../repository/node-repository.ts';
import type { VerificationRunRepository } from '../repository/verification-run-repository.ts';
import type { VerificationRun } from '../types.ts';
import { runGates, type NodeRecord, type VerifierInput } from './gates.ts';
import type { EventBus } from '../ws/event-bus.ts';

/**
 * Workspace verifier runner.
 *
 *   - Loads every node + supporting rows from the SQLite index.
 *   - Composes the six gates from `gates.ts`.
 *   - Persists one row in `verification_runs` with the per-gate detail.
 *   - Emits a `generation.complete`-shaped event for the WebSocket so the
 *     Dashboard can refresh without polling.
 *   - Writes an `audit_events` row of type `verifier.run`.
 */

export interface RunnerDeps {
  repos: {
    nodes: NodeRepository;
    verificationRuns: VerificationRunRepository;
    audit: AuditRepository;
  };
  events: EventBus;
  clock?: () => Date;
}

export interface RunOptions {
  workspaceId: string;
  /** Optional userId for the audit row. Defaults to "system". */
  userId?: string;
  brief?: VerifierInput['brief'];
}

export async function runWorkspaceVerifier(
  deps: RunnerDeps,
  opts: RunOptions,
): Promise<VerificationRun> {
  const records = loadRecords(deps, opts.workspaceId);
  const result = runGates({ nodes: records, brief: opts.brief });

  const run = deps.repos.verificationRuns.insert({
    id: randomUUID(),
    workspaceId: opts.workspaceId,
    ts: (deps.clock?.() ?? new Date()).toISOString(),
    gateResults: { gates: result.gates },
    overallPass: result.overallPass,
  });

  deps.repos.audit.append({
    id: randomUUID(),
    workspaceId: opts.workspaceId,
    userId: opts.userId ?? 'system',
    eventType: 'verifier.run',
    payload: {
      runId: run.id,
      overallPass: result.overallPass,
      failingGates: result.gates.filter((g) => !g.passed).map((g) => g.name),
    },
  });

  deps.events.publish(opts.workspaceId, {
    type: 'generation.complete',
    payload: { verifierRunId: run.id, overallPass: result.overallPass },
    ts: run.ts,
  });

  return run;
}

function loadRecords(deps: RunnerDeps, workspaceId: string): NodeRecord[] {
  return deps.repos.nodes.listByWorkspace(workspaceId).map((n) => ({
    node: n.node,
    parameters: n.parameters,
    constraints: n.constraints,
    relationships: n.relationships,
  }));
}
