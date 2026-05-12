import { describe, expect, test } from 'bun:test';
import { classify, selectAutoHealable } from '../../../src/domain/drift.ts';

describe('classify', () => {
  test('matching hashes → Synced', () => {
    const c = classify({
      desiredHash: 'sha256:a',
      observedHash: 'sha256:a',
      kind: 'hash',
      policy: 'alert',
    });
    expect(c.status).toBe('Synced');
    expect(c.shouldAutoHeal).toBe(false);
  });

  test('mismatched hashes with kind=hash → Hash-Drifted', () => {
    const c = classify({
      desiredHash: 'sha256:a',
      observedHash: 'sha256:b',
      kind: 'hash',
      policy: 'alert',
    });
    expect(c.status).toBe('Hash-Drifted');
  });

  test('mismatched hashes with kind=live_state → Live-Drifted', () => {
    const c = classify({
      desiredHash: 'sha256:a',
      observedHash: 'sha256:b',
      kind: 'live_state',
      policy: 'alert',
    });
    expect(c.status).toBe('Live-Drifted');
  });

  test('Live-Drifted + policy=auto-heal → shouldAutoHeal=true', () => {
    const c = classify({
      desiredHash: 'sha256:a',
      observedHash: 'sha256:b',
      kind: 'live_state',
      policy: 'auto-heal',
    });
    expect(c.shouldAutoHeal).toBe(true);
  });

  test('Hash-Drifted with policy=auto-heal does NOT auto-heal in classifier', () => {
    // Hash drift is healed by re-running the generation pipeline (Phase 5),
    // not by the live-state heal action. Classifier flag is for the latter.
    const c = classify({
      desiredHash: 'sha256:a',
      observedHash: 'sha256:b',
      kind: 'hash',
      policy: 'auto-heal',
    });
    expect(c.shouldAutoHeal).toBe(false);
  });

  test('observed=null → drift detected with "missing" detail', () => {
    const c = classify({
      desiredHash: 'sha256:a',
      observedHash: null,
      kind: 'live_state',
      policy: 'alert',
    });
    expect(c.status).toBe('Live-Drifted');
    expect(c.detail).toContain('missing');
  });

  test('suspended record returns Suspended regardless of hashes', () => {
    const c = classify({
      desiredHash: 'sha256:a',
      observedHash: 'sha256:b',
      kind: 'live_state',
      policy: 'auto-heal',
      suspended: true,
    });
    expect(c.status).toBe('Suspended');
    expect(c.shouldAutoHeal).toBe(false);
  });
});

describe('selectAutoHealable', () => {
  test('returns only records flagged shouldAutoHeal', () => {
    const records = [
      { id: 'r1', classification: classify({ desiredHash: 'sha256:a', observedHash: 'sha256:b', kind: 'live_state', policy: 'auto-heal' }) },
      { id: 'r2', classification: classify({ desiredHash: 'sha256:a', observedHash: 'sha256:b', kind: 'live_state', policy: 'alert' }) },
      { id: 'r3', classification: classify({ desiredHash: 'sha256:a', observedHash: 'sha256:a', kind: 'hash', policy: 'auto-heal' }) },
    ];
    const healable = selectAutoHealable(records);
    expect(healable.map((r) => r.id)).toEqual(['r1']);
  });
});
