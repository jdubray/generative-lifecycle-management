import { describe, expect, test } from 'bun:test';
import { resolveConfig } from '../../src/lib/config.ts';
import { ConfigError } from '../../src/lib/errors.ts';

function readerFor(content: string): (p: string) => string {
  return () => content;
}

describe('resolveConfig', () => {
  test('reads port/workspace/token from the config file', () => {
    const cfg = resolveConfig({
      env: {},
      configPath: '/fake/config.json',
      fileExists: () => true,
      readFile: readerFor(
        JSON.stringify({ port: 3300, workspace: 'demo', token: 'tok-from-file' }),
      ),
    });
    expect(cfg.port).toBe(3300);
    expect(cfg.workspace).toBe('demo');
    expect(cfg.token).toBe('tok-from-file');
    expect(cfg.baseUrl).toBe('http://localhost:3300');
  });

  test('env vars override file fields', () => {
    const cfg = resolveConfig({
      env: { PORT: '4444', GLM_WORKSPACE: 'override-ws', GLM_SOLO_TOKEN: 'env-tok' },
      configPath: '/fake/config.json',
      fileExists: () => true,
      readFile: readerFor(
        JSON.stringify({ port: 3000, workspace: 'old', token: 'old-tok' }),
      ),
    });
    expect(cfg.port).toBe(4444);
    expect(cfg.workspace).toBe('override-ws');
    expect(cfg.token).toBe('env-tok');
  });

  test('missing config file is fine — uses defaults', () => {
    const cfg = resolveConfig({
      env: {},
      configPath: '/nope',
      fileExists: () => false,
      readFile: () => {
        throw new Error('should not be read');
      },
    });
    expect(cfg.port).toBe(3000);
    expect(cfg.workspace).toBe('default');
    expect(cfg.token).toBeUndefined();
  });

  test('malformed config file is reported as ConfigError', () => {
    expect(() =>
      resolveConfig({
        env: {},
        configPath: '/bad',
        fileExists: () => true,
        readFile: readerFor('{ this is not valid json'),
      }),
    ).toThrow(ConfigError);
  });

  test('invalid PORT env value is rejected', () => {
    expect(() =>
      resolveConfig({
        env: { PORT: 'not-a-number' },
        configPath: '/fake',
        fileExists: () => false,
        readFile: () => '',
      }),
    ).toThrow(ConfigError);
  });

  test('token is undefined when no source provides one', () => {
    const cfg = resolveConfig({
      env: {},
      configPath: '/fake',
      fileExists: () => true,
      readFile: readerFor(JSON.stringify({ port: 3000, workspace: 'default' })),
    });
    expect(cfg.token).toBeUndefined();
  });
});
