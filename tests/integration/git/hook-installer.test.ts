import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { hookInstalled, installHooks } from '../../../src/git/hook-installer.ts';
import { makeTempRepo, type TempRepo } from './helpers.ts';

describe('hook-installer', () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());

  test('installs both pre-commit and pre-receive', () => {
    repo = makeTempRepo();
    const paths = installHooks({ repoPath: repo.path });
    expect(paths.length).toBe(2);
    expect(hookInstalled(repo.path, 'pre-commit')).toBe(true);
    expect(hookInstalled(repo.path, 'pre-receive')).toBe(true);
  });

  test('written hook content matches the spec template', () => {
    repo = makeTempRepo();
    installHooks({ repoPath: repo.path, hooks: ['pre-receive'] });
    const content = readFileSync(`${repo.path}/.git/hooks/pre-receive`, 'utf8');
    expect(content).toContain('Affected:');
    expect(content).toContain('rev-list');
  });
});
