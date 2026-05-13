import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  runOneShot,
  ClaudeCliNotFoundError,
  ClaudeCliFailedError,
} from '../../src/lib/claude-cli.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures');

const MOCK_CLAUDE = ['bun', 'run', join(FIXTURES, 'mock-claude.ts')] as const;
const FAIL_CLAUDE = ['bun', 'run', join(FIXTURES, 'mock-claude-fail.ts')] as const;
const SLOW_CLAUDE = ['bun', 'run', join(FIXTURES, 'mock-claude-slow.ts')] as const;
const SAMPLE_PROMPT = join(FIXTURES, 'sample-system-prompt.txt');

describe('runOneShot', () => {
  test('spawns claude with --print and pipes stdin → stdout', async () => {
    const result = await runOneShot({
      claudeBin: MOCK_CLAUDE,
      userText: 'Hello from the wrapper',
    });
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.mock).toBe(true);
    expect(payload.print).toBe(true);
    expect(payload.userText).toBe('Hello from the wrapper');
  });

  test('passes --model when provided', async () => {
    const result = await runOneShot({
      claudeBin: MOCK_CLAUDE,
      model: 'claude-sonnet-4-6',
      userText: '',
    });
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.model).toBe('claude-sonnet-4-6');
  });

  test('omits --model when not provided (mock sees default "unknown")', async () => {
    const result = await runOneShot({
      claudeBin: MOCK_CLAUDE,
      userText: '',
    });
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.model).toBe('unknown');
  });

  test('passes --system-prompt-file and the child reads it', async () => {
    const result = await runOneShot({
      claudeBin: MOCK_CLAUDE,
      systemPromptFile: SAMPLE_PROMPT,
      userText: '',
    });
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.systemPromptLength).toBeGreaterThan(0);
    expect(payload.systemPromptHead).toContain('sekkei');
  });

  test('throws ClaudeCliNotFoundError when binary is missing', async () => {
    const bogus = `nonexistent-claude-${Date.now()}`;
    await expect(
      runOneShot({ claudeBin: bogus, userText: '' }),
    ).rejects.toBeInstanceOf(ClaudeCliNotFoundError);
  });

  test('ClaudeCliNotFoundError carries exit code 69 and a clear message', async () => {
    try {
      await runOneShot({ claudeBin: 'nonexistent-claude-xyz', userText: '' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ClaudeCliNotFoundError);
      const err = e as ClaudeCliNotFoundError;
      expect(err.exitCode).toBe(69);
      expect(err.message).toContain('claude CLI not found');
      expect(err.message).toContain('https://claude.ai/code');
    }
  });

  test('throws ClaudeCliFailedError when claude exits non-zero', async () => {
    try {
      await runOneShot({ claudeBin: FAIL_CLAUDE, userText: '' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ClaudeCliFailedError);
      const err = e as ClaudeCliFailedError;
      expect(err.exitCode).toBe(70);
      expect(err.exitStatus).toBe(2);
      expect(err.stderr).toContain('mock claude intentional failure');
    }
  });

  test('timeoutMs aborts a long-running child with ClaudeCliFailedError', async () => {
    try {
      await runOneShot({
        claudeBin: SLOW_CLAUDE,
        userText: '',
        timeoutMs: 200,
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ClaudeCliFailedError);
      const err = e as ClaudeCliFailedError;
      expect(err.message).toContain('timed out after 200ms');
    }
  }, 15_000);

  test('empty userText still produces a clean exit', async () => {
    const result = await runOneShot({ claudeBin: MOCK_CLAUDE, userText: '' });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.userText).toBe('');
  });

  test('large userText round-trips byte-exact', async () => {
    const big = 'lorem '.repeat(10_000); // ~60 KB
    const result = await runOneShot({ claudeBin: MOCK_CLAUDE, userText: big });
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.userText).toBe(big);
  });
});
