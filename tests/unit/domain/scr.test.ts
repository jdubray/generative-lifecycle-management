import { describe, expect, test } from 'bun:test';
import { apply, canApply, InvalidScrTransitionError, isTerminal, nextStatus } from '../../../src/domain/scr.ts';
import type { Scr } from '../../../src/types.ts';

function sampleScr(overrides: Partial<Scr> = {}): Scr {
  return {
    id: 'SCR-1',
    workspaceId: 'ws-1',
    title: 'demo',
    scrClass: 'I',
    status: 'Draft',
    proposer: 'alice@example.com',
    proposedAt: '2026-05-11T00:00:00.000Z',
    problem: 'p',
    diffYaml: [],
    targetNodes: [],
    effectivity: null,
    returnReason: null,
    impact: null,
    ...overrides,
  };
}

describe('nextStatus — happy paths', () => {
  test('Draft → Submitted via submit', () => {
    expect(nextStatus('Draft', { type: 'submit' })).toBe('Submitted');
  });
  test('Submitted → Under Review via startReview', () => {
    expect(nextStatus('Submitted', { type: 'startReview' })).toBe('Under Review');
  });
  test('Under Review → Approved / Returned / Rejected', () => {
    expect(nextStatus('Under Review', { type: 'approve' })).toBe('Approved');
    expect(nextStatus('Under Review', { type: 'return', reason: 'fix' })).toBe('Returned');
    expect(nextStatus('Under Review', { type: 'reject' })).toBe('Rejected');
  });
  test('Returned → Draft via reopen', () => {
    expect(nextStatus('Returned', { type: 'reopen' })).toBe('Draft');
  });
  test('Approved → Implemented → Released', () => {
    expect(nextStatus('Approved', { type: 'implement' })).toBe('Implemented');
    expect(nextStatus('Implemented', { type: 'release' })).toBe('Released');
  });
});

describe('nextStatus — illegal transitions throw', () => {
  test('cannot approve from Draft', () => {
    expect(() => nextStatus('Draft', { type: 'approve' })).toThrow(InvalidScrTransitionError);
  });
  test('cannot submit from Approved', () => {
    expect(() => nextStatus('Approved', { type: 'submit' })).toThrow(InvalidScrTransitionError);
  });
  test('cannot release before implement', () => {
    expect(() => nextStatus('Approved', { type: 'release' })).toThrow(InvalidScrTransitionError);
  });
  test('Rejected is terminal', () => {
    expect(isTerminal('Rejected')).toBe(true);
    expect(() => nextStatus('Rejected', { type: 'reopen' })).toThrow(InvalidScrTransitionError);
  });
  test('Released is terminal', () => {
    expect(isTerminal('Released')).toBe(true);
  });
});

describe('apply — pure function semantics', () => {
  test('return event records the reason', () => {
    const scr = sampleScr({ status: 'Under Review' });
    const next = apply(scr, { type: 'return', reason: 'needs more detail' });
    expect(next.status).toBe('Returned');
    expect(next.returnReason).toBe('needs more detail');
    expect(scr.returnReason).toBeNull(); // original unchanged
  });
  test('reopen clears the return reason', () => {
    const scr = sampleScr({ status: 'Returned', returnReason: 'fix' });
    const next = apply(scr, { type: 'reopen' });
    expect(next.status).toBe('Draft');
    expect(next.returnReason).toBeNull();
  });
});

describe('canApply', () => {
  test('returns false instead of throwing for illegal events', () => {
    expect(canApply('Draft', { type: 'approve' })).toBe(false);
    expect(canApply('Draft', { type: 'submit' })).toBe(true);
  });
});
