import type {
  DriftKind,
  DriftPolicy,
  DriftStatus,
  Sha256Hash,
} from '../types.ts';

/**
 * Drift classifier (spec §5.7).
 *
 *   - `hash` drift  : sekkei advanced; deployed artifact still references the
 *     old generation_hash. Caller compares `desiredHash` (latest generation
 *     for the node) against `observedHash` (what the deployer last shipped).
 *
 *   - `live_state` drift : the deployed file was hand-edited outside the
 *     sekkei. Caller computes SHA-256 of the current file content as
 *     `observedHash` and passes the expected generation_hash as `desiredHash`.
 *
 * Pure function: no I/O. Sweeps live in `verifier/runner.ts` (Phase 9).
 */

export interface DriftInput {
  /** Hash the sekkei says the artifact should have. */
  desiredHash: Sha256Hash;
  /** Hash the deployer / filesystem actually shows. May be null for missing files. */
  observedHash: Sha256Hash | null;
  /** Which detection lens to apply. */
  kind: DriftKind;
  /** Policy configured for this node — drives auto-heal / alert / suspend behavior. */
  policy: DriftPolicy;
  /** True iff the drift record is currently in the Suspended state. */
  suspended?: boolean;
}

export interface DriftClassification {
  status: DriftStatus;
  kind: DriftKind;
  policy: DriftPolicy;
  shouldAutoHeal: boolean;
  detail: string;
}

/** Classify a single (desired, observed, kind) triple into a `DriftStatus`. */
export function classify(input: DriftInput): DriftClassification {
  const { desiredHash, observedHash, kind, policy } = input;

  if (input.suspended) {
    return {
      status: 'Suspended',
      kind,
      policy,
      shouldAutoHeal: false,
      detail: 'reconciliation suspended by waiver or operator',
    };
  }

  if (kind === 'none') {
    return {
      status: 'Synced',
      kind: 'none',
      policy,
      shouldAutoHeal: false,
      detail: 'no drift indicator configured',
    };
  }

  if (observedHash === null) {
    return {
      status: kind === 'hash' ? 'Hash-Drifted' : 'Live-Drifted',
      kind,
      policy,
      shouldAutoHeal: policy === 'auto-heal',
      detail: 'observed artifact is missing',
    };
  }

  if (desiredHash === observedHash) {
    return {
      status: 'Synced',
      kind,
      policy,
      shouldAutoHeal: false,
      detail: 'desired and observed hashes match',
    };
  }

  const status: DriftStatus = kind === 'hash' ? 'Hash-Drifted' : 'Live-Drifted';
  return {
    status,
    kind,
    policy,
    shouldAutoHeal: policy === 'auto-heal' && kind === 'live_state',
    detail:
      kind === 'hash'
        ? 'sekkei has advanced; deployed artifact is from a stale generation'
        : 'observed file content does not match the desired generation hash',
  };
}

/**
 * Pick the nodes whose policy is `auto-heal` and whose current classification
 * is a drift state. Caller will run regeneration for these.
 */
export function selectAutoHealable<T extends { classification: DriftClassification }>(
  records: T[],
): T[] {
  return records.filter((r) => r.classification.shouldAutoHeal);
}
