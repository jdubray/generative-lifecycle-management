import { describe, expect, test } from 'bun:test';
import { parseCommandLine } from '../../src/lib/argv.ts';

describe('parseCommandLine', () => {
  test('returns undefined command when argv is empty', () => {
    const r = parseCommandLine([]);
    expect(r.command).toBeUndefined();
    expect(r.positional).toEqual([]);
    expect(r.flags).toEqual({});
  });

  test('captures the first positional as the command', () => {
    const r = parseCommandLine(['status']);
    expect(r.command).toBe('status');
    expect(r.positional).toEqual([]);
  });

  test('treats boolean flag without value as true', () => {
    const r = parseCommandLine(['verify', '--json']);
    expect(r.command).toBe('verify');
    expect(r.flags.json).toBe(true);
  });

  test('--key=value consumes the equals form', () => {
    const r = parseCommandLine(['vibe', '--workspace=default']);
    expect(r.flags.workspace).toBe('default');
  });

  test('--key value consumes the next argv for known value flags', () => {
    const r = parseCommandLine(['generate', '--component', 'acme:web.shop.repo']);
    expect(r.command).toBe('generate');
    expect(r.flags.component).toBe('acme:web.shop.repo');
  });

  test('--help is captured as a boolean flag, not a positional', () => {
    const r = parseCommandLine(['--help']);
    expect(r.command).toBeUndefined();
    expect(r.flags.help).toBe(true);
  });

  test('positional values after the command are preserved', () => {
    const r = parseCommandLine(['import-sekkei', './my-sekkei.yaml']);
    expect(r.command).toBe('import-sekkei');
    expect(r.positional).toEqual(['./my-sekkei.yaml']);
  });

  test('does not consume a value that starts with - for value flags', () => {
    const r = parseCommandLine(['vibe', '--workspace', '--json']);
    // --workspace has no real value here; --json was the next flag.
    expect(r.flags.workspace).toBe(true);
    expect(r.flags.json).toBe(true);
  });
});
