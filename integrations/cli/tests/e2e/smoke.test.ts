/**
 * Phase-1 smoke tests for the `glm` binary.
 *
 * These spawn the CLI as a subprocess and assert basic exit-code and stdout
 * behavior. No network access; no `claude` binary required.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', '..', 'src', 'bin', 'glm.ts');

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('bun', ['run', BIN, ...args], { encoding: 'utf8' });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

describe('glm CLI (phase 1)', () => {
  test('--version prints the version number and exits 0', () => {
    const r = runCli(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('--help prints the usage banner and exits 0', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('USAGE');
    expect(r.stdout).toContain('glm <command>');
    expect(r.stdout).toContain('vibe');
    expect(r.stdout).toContain('generate');
    expect(r.stdout).toContain('verify');
  });

  test('no args prints help and exits 0', () => {
    const r = runCli([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('USAGE');
  });

  test('unknown command exits 64 with a useful message on stderr', () => {
    const r = runCli(['nonsense']);
    expect(r.status).toBe(64);
    expect(r.stderr).toContain('Unknown command: nonsense');
    expect(r.stderr).toContain("glm --help");
  });

  test('not-yet-implemented commands exit 2 with a Phase reference', () => {
    const r = runCli(['vibe']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('not yet implemented');
    expect(r.stderr).toContain('Phase');
  });

  test('glm status against an unreachable port exits 69 (server unavailable)', () => {
    // Port 1 is universally unreachable; the CLI must surface ServerUnreachableError → exit 69.
    const r = runCli(['status', '--port=1']);
    expect(r.status).toBe(69);
    expect(r.stderr).toContain('GLM server not responding');
  });
});
