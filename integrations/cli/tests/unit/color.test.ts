import { describe, expect, test } from 'bun:test';
import { makeColorize, shouldUseColor } from '../../src/lib/color.ts';

describe('shouldUseColor', () => {
  test('explicit enabled wins over everything', () => {
    expect(shouldUseColor({ enabled: true, env: { NO_COLOR: '1' } })).toBe(true);
    expect(shouldUseColor({ enabled: false, stream: { write: () => true, isTTY: true } as never })).toBe(
      false,
    );
  });

  test('NO_COLOR env disables color', () => {
    expect(
      shouldUseColor({
        env: { NO_COLOR: '1' },
        stream: { write: () => true, isTTY: true } as never,
      }),
    ).toBe(false);
  });

  test('--no-color flag disables color', () => {
    expect(
      shouldUseColor({
        flags: { 'no-color': true },
        stream: { write: () => true, isTTY: true } as never,
      }),
    ).toBe(false);
  });

  test('non-TTY stream → disabled by default', () => {
    expect(
      shouldUseColor({
        env: {},
        flags: {},
        stream: { write: () => true, isTTY: false } as never,
      }),
    ).toBe(false);
  });

  test('TTY stream + no env/flag overrides → enabled', () => {
    expect(
      shouldUseColor({
        env: {},
        flags: {},
        stream: { write: () => true, isTTY: true } as never,
      }),
    ).toBe(true);
  });
});

describe('makeColorize', () => {
  test('returns identity functions when disabled', () => {
    const c = makeColorize(false);
    expect(c.green('hello')).toBe('hello');
    expect(c.red('x')).toBe('x');
  });

  test('wraps with ANSI codes when enabled', () => {
    const c = makeColorize(true);
    expect(c.green('hello')).toBe('\x1b[32mhello\x1b[0m');
    expect(c.red('x')).toBe('\x1b[31mx\x1b[0m');
  });
});
