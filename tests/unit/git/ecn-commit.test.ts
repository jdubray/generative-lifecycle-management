import { describe, expect, test } from 'bun:test';
import { buildEcnMessage, EcnMessageError, parseEcnMessage } from '../../../src/git/ecn-commit.ts';

describe('buildEcnMessage', () => {
  test('produces the canonical block layout', () => {
    const msg = buildEcnMessage({
      summary: 'Allow guest checkout',
      affected: ['glm:capability.checkout'],
      why: 'Customers abandon at signup',
      regenRequired: [{ path: 'src/routes/checkout.ts', reason: 'new states' }],
      scrId: 'SCR-2090',
      signedOffBy: 'alice@example.com',
    });
    expect(msg).toContain('ECN: Allow guest checkout');
    expect(msg).toContain('Affected:\n  - glm:capability.checkout');
    expect(msg).toContain('Why:\n  Customers abandon at signup');
    expect(msg).toContain('Regen required:\n  - src/routes/checkout.ts  (re-emit; new states)');
    expect(msg).toContain('SCR: SCR-2090');
    expect(msg).toContain('Signed-off-by: alice@example.com');
  });

  test('rejects empty affected list', () => {
    expect(() =>
      buildEcnMessage({
        summary: 's',
        affected: [],
        why: 'w',
        scrId: 'SCR-1',
        signedOffBy: 'a@b.com',
      }),
    ).toThrow(EcnMessageError);
  });

  test('rejects affected entries missing the glm: prefix', () => {
    expect(() =>
      buildEcnMessage({
        summary: 's',
        affected: ['not-prefixed'],
        why: 'w',
        scrId: 'SCR-1',
        signedOffBy: 'a@b.com',
      }),
    ).toThrow(EcnMessageError);
  });

  test('rejects multi-line summary', () => {
    expect(() =>
      buildEcnMessage({
        summary: 'line\nsecond',
        affected: ['glm:x.y'],
        why: 'w',
        scrId: 'SCR-1',
        signedOffBy: 'a@b.com',
      }),
    ).toThrow(EcnMessageError);
  });

  test('rejects non-conforming scrId', () => {
    expect(() =>
      buildEcnMessage({
        summary: 's',
        affected: ['glm:x.y'],
        why: 'w',
        scrId: 'change-1',
        signedOffBy: 'a@b.com',
      }),
    ).toThrow(EcnMessageError);
  });

  test('omits the Regen block when no entries are supplied', () => {
    const msg = buildEcnMessage({
      summary: 's',
      affected: ['glm:x.y'],
      why: 'w',
      scrId: 'SCR-1',
      signedOffBy: 'a@b.com',
    });
    expect(msg).not.toContain('Regen required:');
  });
});

describe('parseEcnMessage', () => {
  test('round-trips a built message', () => {
    const built = buildEcnMessage({
      summary: 'Add archived state',
      affected: ['glm:component.x', 'glm:component.y'],
      why: 'support archive\nsecond line of context',
      regenRequired: [{ path: 'src/x.ts', reason: 'new state' }],
      scrId: 'SCR-99',
      signedOffBy: 'bob@example.com',
    });
    const parsed = parseEcnMessage(built);
    expect(parsed).not.toBeNull();
    expect(parsed?.summary).toBe('Add archived state');
    expect(parsed?.affected).toEqual(['glm:component.x', 'glm:component.y']);
    expect(parsed?.why).toContain('support archive');
    expect(parsed?.why).toContain('second line of context');
    expect(parsed?.scrId).toBe('SCR-99');
    expect(parsed?.signedOffBy).toBe('bob@example.com');
    expect(parsed?.regenRequired?.[0]).toEqual({ path: 'src/x.ts', reason: 'new state' });
  });

  test('returns null for non-ECN messages', () => {
    expect(parseEcnMessage('chore: update deps')).toBeNull();
  });
});
