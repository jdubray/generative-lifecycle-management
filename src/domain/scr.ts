import type { Scr, ScrStatus } from '../types.ts';

/**
 * SCR state machine (spec §5.3):
 *
 *   Draft ──→ Submitted ──→ Under Review ──┬──→ Approved ──→ Implemented ──→ Released
 *                                          ├──→ Returned ──→ (back to Draft via reopen)
 *                                          └──→ Rejected   (terminal)
 *
 * Implemented as an exhaustive switch over discriminated `ScrEvent` types.
 * Illegal transitions raise `InvalidScrTransitionError`; the function is
 * pure — `apply(scr, event)` returns a new `Scr` value.
 */

export type ScrEvent =
  | { type: 'submit' }
  | { type: 'startReview' }
  | { type: 'approve' }
  | { type: 'return'; reason: string }
  | { type: 'reject' }
  | { type: 'reopen' }
  | { type: 'implement' }
  | { type: 'release' };

export class InvalidScrTransitionError extends Error {
  public readonly from: ScrStatus;
  public readonly event: ScrEvent['type'];
  constructor(from: ScrStatus, event: ScrEvent['type']) {
    super(`cannot apply '${event}' from status '${from}'`);
    this.name = 'InvalidScrTransitionError';
    this.from = from;
    this.event = event;
  }
}

/** Compute the next status produced by `event` applied to an SCR in `status`. */
export function nextStatus(status: ScrStatus, event: ScrEvent): ScrStatus {
  switch (event.type) {
    case 'submit':
      assertFrom(status, event.type, ['Draft']);
      return 'Submitted';
    case 'startReview':
      assertFrom(status, event.type, ['Submitted']);
      return 'Under Review';
    case 'approve':
      assertFrom(status, event.type, ['Under Review']);
      return 'Approved';
    case 'return':
      assertFrom(status, event.type, ['Under Review']);
      return 'Returned';
    case 'reject':
      assertFrom(status, event.type, ['Under Review']);
      return 'Rejected';
    case 'reopen':
      assertFrom(status, event.type, ['Returned']);
      return 'Draft';
    case 'implement':
      assertFrom(status, event.type, ['Approved']);
      return 'Implemented';
    case 'release':
      assertFrom(status, event.type, ['Implemented']);
      return 'Released';
  }
}

/**
 * Return a new `Scr` with the next status applied. `return_reason` is set
 * when the event is `return` and cleared on `reopen`; other fields are
 * unchanged. The function never mutates `scr`.
 */
export function apply(scr: Scr, event: ScrEvent): Scr {
  const status = nextStatus(scr.status, event);
  if (event.type === 'return') {
    return { ...scr, status, returnReason: event.reason };
  }
  if (event.type === 'reopen') {
    return { ...scr, status, returnReason: null };
  }
  return { ...scr, status };
}

/** True if `event` is legal in `status`; false otherwise (no throw). */
export function canApply(status: ScrStatus, event: ScrEvent): boolean {
  try {
    nextStatus(status, event);
    return true;
  } catch (e) {
    if (e instanceof InvalidScrTransitionError) return false;
    throw e;
  }
}

/** Statuses with no outgoing transitions. */
export function isTerminal(status: ScrStatus): boolean {
  return status === 'Rejected' || status === 'Released';
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function assertFrom(status: ScrStatus, event: ScrEvent['type'], allowed: ScrStatus[]): void {
  if (!allowed.includes(status)) {
    throw new InvalidScrTransitionError(status, event);
  }
}
