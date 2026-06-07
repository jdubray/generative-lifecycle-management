import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { runInit, type RunInitOptions } from '../../src/commands/init.ts';
import { parseCommandLine } from '../../src/lib/argv.ts';

class StringStream {
  public buffer = '';
  write(chunk: string | Uint8Array): boolean {
    this.buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }
}

function makeOpts(extra: Partial<RunInitOptions> = {}): RunInitOptions & {
  stdout: StringStream;
  stderr: StringStream;
} {
  const stdout = new StringStream();
  const stderr = new StringStream();
  return {
    io: { stdout, stderr },
    stdout,
    stderr,
    ...extra,
  };
}

describe('glm init', () => {
  test('writes ~/.glm/config.json with a generated token; exits 0', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-init-'));
    const cfg = join(tmp, 'config.json');
    try {
      const opts = makeOpts({ configPath: cfg, generateToken: () => 'a'.repeat(64) });
      const exit = await runInit(parseCommandLine(['init']), opts);
      expect(exit).toBe(0);
      const written = JSON.parse(readFileSync(cfg, 'utf8'));
      expect(written.port).toBe(3000);
      expect(written.workspace).toBe('default');
      expect(written.token).toBe('a'.repeat(64));
      expect((opts.stdout as StringStream).buffer).toContain('GLM_SOLO_TOKEN=');
      expect((opts.stdout as StringStream).buffer).toContain(cfg);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('honors --port and --name', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-init-'));
    const cfg = join(tmp, 'config.json');
    try {
      const opts = makeOpts({ configPath: cfg, generateToken: () => 'b'.repeat(64) });
      const exit = await runInit(
        parseCommandLine(['init', '--port=4444', '--name=my-project']),
        opts,
      );
      expect(exit).toBe(0);
      const written = JSON.parse(readFileSync(cfg, 'utf8'));
      expect(written.port).toBe(4444);
      expect(written.workspace).toBe('my-project');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('honors --token (skips token generation)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-init-'));
    const cfg = join(tmp, 'config.json');
    try {
      const opts = makeOpts({
        configPath: cfg,
        generateToken: () => {
          throw new Error('should not be called');
        },
      });
      await runInit(
        parseCommandLine(['init', '--token=cafebabe' + 'f'.repeat(56)]),
        opts,
      );
      const written = JSON.parse(readFileSync(cfg, 'utf8'));
      expect(written.token).toBe('cafebabe' + 'f'.repeat(56));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects a non-hex --token', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-init-'));
    const cfg = join(tmp, 'config.json');
    try {
      const opts = makeOpts({ configPath: cfg });
      const exit = await runInit(
        parseCommandLine(['init', '--token=not-hex!!!']),
        opts,
      );
      expect(exit).toBe(64);
      expect((opts.stderr as StringStream).buffer).toContain('hex string');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('refuses to overwrite an existing config without --force', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-init-'));
    const cfg = join(tmp, 'config.json');
    try {
      writeFileSync(cfg, JSON.stringify({ port: 3000, workspace: 'x', token: 'deadbeef'.repeat(8) }));
      const opts = makeOpts({ configPath: cfg });
      const exit = await runInit(parseCommandLine(['init']), opts);
      expect(exit).toBe(78);
      expect((opts.stderr as StringStream).buffer).toContain('already exists');
      expect((opts.stderr as StringStream).buffer).toContain('--force');
      // Existing token is surfaced so the user can copy it.
      expect((opts.stderr as StringStream).buffer).toContain('deadbeef');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('overwrites with --force', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-init-'));
    const cfg = join(tmp, 'config.json');
    try {
      writeFileSync(cfg, JSON.stringify({ token: 'oldtoken' + '0'.repeat(56) }));
      const opts = makeOpts({ configPath: cfg, generateToken: () => 'c'.repeat(64) });
      const exit = await runInit(parseCommandLine(['init', '--force']), opts);
      expect(exit).toBe(0);
      const written = JSON.parse(readFileSync(cfg, 'utf8'));
      expect(written.token).toBe('c'.repeat(64));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('malformed existing config reports config error and exits 78', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-init-'));
    const cfg = join(tmp, 'config.json');
    try {
      writeFileSync(cfg, '{ this is not valid json');
      const opts = makeOpts({ configPath: cfg });
      const exit = await runInit(parseCommandLine(['init']), opts);
      expect(exit).toBe(78);
      expect((opts.stderr as StringStream).buffer).toContain('not valid JSON');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('creates parent directory if missing', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-init-'));
    const nested = join(tmp, 'nested', 'sub', 'config.json');
    try {
      const opts = makeOpts({ configPath: nested, generateToken: () => 'd'.repeat(64) });
      const exit = await runInit(parseCommandLine(['init']), opts);
      expect(exit).toBe(0);
      expect(readFileSync(nested, 'utf8')).toContain('d'.repeat(64));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--write-env=<path> creates the .env file with GLM_SOLO_TOKEN when missing', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-init-'));
    const cfg = join(tmp, 'config.json');
    const env = join(tmp, '.env');
    try {
      const opts = makeOpts({ configPath: cfg, generateToken: () => 'e'.repeat(64) });
      const exit = await runInit(parseCommandLine(['init', `--write-env=${env}`]), opts);
      expect(exit).toBe(0);
      const contents = readFileSync(env, 'utf8');
      expect(contents).toContain(`GLM_SOLO_TOKEN=${'e'.repeat(64)}`);
      expect((opts.stdout as StringStream).buffer).toContain('wrote GLM_SOLO_TOKEN');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--write-env appends GLM_SOLO_TOKEN to an existing .env that has no such line', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-init-'));
    const cfg = join(tmp, 'config.json');
    const env = join(tmp, '.env');
    try {
      writeFileSync(env, 'PORT=3300\nNODE_ENV=development\n', 'utf8');
      const opts = makeOpts({ configPath: cfg, generateToken: () => 'f'.repeat(64) });
      const exit = await runInit(parseCommandLine(['init', `--write-env=${env}`]), opts);
      expect(exit).toBe(0);
      const contents = readFileSync(env, 'utf8');
      expect(contents).toContain('PORT=3300');
      expect(contents).toContain('NODE_ENV=development');
      expect(contents).toContain(`GLM_SOLO_TOKEN=${'f'.repeat(64)}`);
      expect((opts.stdout as StringStream).buffer).toContain('appended GLM_SOLO_TOKEN');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--write-env replaces an existing GLM_SOLO_TOKEN line in-place', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-init-'));
    const cfg = join(tmp, 'config.json');
    const env = join(tmp, '.env');
    try {
      writeFileSync(
        env,
        'PORT=3300\nGLM_SOLO_TOKEN=stale-token-value\nNODE_ENV=development\n',
        'utf8',
      );
      const opts = makeOpts({ configPath: cfg, generateToken: () => '9'.repeat(64) });
      const exit = await runInit(parseCommandLine(['init', `--write-env=${env}`]), opts);
      expect(exit).toBe(0);
      const contents = readFileSync(env, 'utf8');
      expect(contents).not.toContain('stale-token-value');
      expect(contents).toContain(`GLM_SOLO_TOKEN=${'9'.repeat(64)}`);
      // surrounding lines preserved
      expect(contents).toContain('PORT=3300');
      expect(contents).toContain('NODE_ENV=development');
      expect((opts.stdout as StringStream).buffer).toContain('replaced GLM_SOLO_TOKEN');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--write-env without a value uses opts.defaultEnvPath', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-init-'));
    const cfg = join(tmp, 'config.json');
    const env = join(tmp, 'default.env');
    try {
      const opts = makeOpts({
        configPath: cfg,
        generateToken: () => '7'.repeat(64),
        defaultEnvPath: env,
      });
      const exit = await runInit(parseCommandLine(['init', '--write-env']), opts);
      expect(exit).toBe(0);
      expect(readFileSync(env, 'utf8')).toContain(`GLM_SOLO_TOKEN=${'7'.repeat(64)}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--source-dir on an existing config PATCHes the workspace (no 78 guard)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-init-'));
    const cfg = join(tmp, 'config.json');
    try {
      writeFileSync(cfg, JSON.stringify({ port: 3300, workspace: 'myapp', token: 'deadbeef'.repeat(8) }));
      const calls: Array<{ ws: string; dir: string }> = [];
      const opts = makeOpts({
        configPath: cfg,
        clientFactory: () => ({
          setSourceDir: async (ws: string, dir: string) => {
            calls.push({ ws, dir });
          },
        }),
      });
      const exit = await runInit(
        parseCommandLine(['init', '--source-dir=/abs/code', '--workspace=myapp']),
        opts,
      );
      expect(exit).toBe(0); // NOT the 78 "already exists" guard
      expect(calls).toEqual([{ ws: 'myapp', dir: '/abs/code' }]);
      expect((opts.stdout as StringStream).buffer).toContain("set source_dir for workspace 'myapp'");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--source-dir resolves a relative path to absolute before PATCHing', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-init-'));
    const cfg = join(tmp, 'config.json');
    try {
      writeFileSync(cfg, JSON.stringify({ port: 3300, workspace: 'myapp', token: 'deadbeef'.repeat(8) }));
      let seenDir = '';
      const opts = makeOpts({
        configPath: cfg,
        clientFactory: () => ({
          setSourceDir: async (_ws: string, dir: string) => {
            seenDir = dir;
          },
        }),
      });
      const exit = await runInit(
        parseCommandLine(['init', '--source-dir=rel/sub', '--workspace=myapp']),
        opts,
      );
      expect(exit).toBe(0);
      expect(isAbsolute(seenDir)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--source-dir surfaces a PATCH failure as a non-zero exit', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-init-'));
    const cfg = join(tmp, 'config.json');
    try {
      writeFileSync(cfg, JSON.stringify({ port: 3300, workspace: 'myapp', token: 'deadbeef'.repeat(8) }));
      const opts = makeOpts({
        configPath: cfg,
        clientFactory: () => ({
          setSourceDir: async () => {
            throw new Error('workspace myapp not found');
          },
        }),
      });
      const exit = await runInit(
        parseCommandLine(['init', '--source-dir=/abs/code', '--workspace=myapp']),
        opts,
      );
      expect(exit).toBe(1);
      expect((opts.stderr as StringStream).buffer).toContain('failed to set source_dir');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
