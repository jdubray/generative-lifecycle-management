import { describe, expect, test } from 'bun:test';
import { resolveConfig, DEFAULT_CONFIG } from '../../src/lib/config.ts';
import { ConfigError } from '../../src/lib/errors.ts';
import { parseCommandLine } from '../../src/lib/argv.ts';

function fakeFile(contents: string | null) {
  return {
    fileExists: () => contents !== null,
    readFile: () => contents ?? '',
  };
}

describe('resolveConfig — precedence', () => {
  test('returns defaults when nothing is set', () => {
    const cfg = resolveConfig({
      args: parseCommandLine([]),
      env: {},
      ...fakeFile(null),
    });
    expect(cfg.port).toBe(DEFAULT_CONFIG.port);
    expect(cfg.workspace).toBe(DEFAULT_CONFIG.workspace);
    expect(cfg.model).toBe(DEFAULT_CONFIG.model);
    expect(cfg.token).toBeUndefined();
    expect(cfg.json).toBe(false);
    expect(cfg.baseUrl).toBe('http://localhost:3000');
  });

  test('flags beat env beat file beat defaults', () => {
    const cfg = resolveConfig({
      args: parseCommandLine(['status', '--port=4444', '--workspace=flag-ws']),
      env: { PORT: '3333', GLM_WORKSPACE: 'env-ws', GLM_SOLO_TOKEN: 'env-token' },
      ...fakeFile(JSON.stringify({ port: 2222, workspace: 'file-ws', token: 'file-token' })),
    });
    expect(cfg.port).toBe(4444); // flag wins
    expect(cfg.workspace).toBe('flag-ws'); // flag wins
    expect(cfg.token).toBe('env-token'); // env beats file (no flag)
    expect(cfg.baseUrl).toBe('http://localhost:4444');
  });

  test('file is used when env and flags are absent', () => {
    const cfg = resolveConfig({
      args: parseCommandLine([]),
      env: {},
      ...fakeFile(JSON.stringify({ port: 7000, workspace: 'file-ws', token: 't' })),
    });
    expect(cfg.port).toBe(7000);
    expect(cfg.workspace).toBe('file-ws');
    expect(cfg.token).toBe('t');
  });

  test('--json sets the json flag', () => {
    const cfg = resolveConfig({
      args: parseCommandLine(['status', '--json']),
      env: {},
      ...fakeFile(null),
    });
    expect(cfg.json).toBe(true);
  });

  test('malformed config file throws ConfigError', () => {
    expect(() =>
      resolveConfig({
        args: parseCommandLine([]),
        env: {},
        ...fakeFile('{ not valid json'),
      }),
    ).toThrow(ConfigError);
  });

  test('invalid port value throws ConfigError', () => {
    expect(() =>
      resolveConfig({
        args: parseCommandLine(['status', '--port=not-a-number']),
        env: {},
        ...fakeFile(null),
      }),
    ).toThrow(ConfigError);
  });

  test('empty token in env is treated as unset (falls through)', () => {
    const cfg = resolveConfig({
      args: parseCommandLine([]),
      env: { GLM_SOLO_TOKEN: '' },
      ...fakeFile(JSON.stringify({ token: 'file-token' })),
    });
    expect(cfg.token).toBe('file-token');
  });
});
