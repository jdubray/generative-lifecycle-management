import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitClient } from '../../../src/git/git-client.ts';

export interface TempRepo {
  path: string;
  git: GitClient;
  cleanup(): void;
}

/**
 * Spin up a fresh git repo in a tmp dir with deterministic identity. The
 * `cleanup()` callback removes the directory; tests should call it from
 * `afterEach`.
 */
export function makeTempRepo(opts: { initialBranch?: string } = {}): TempRepo {
  const path = mkdtempSync(join(tmpdir(), 'glm-git-'));
  const git = new GitClient({
    repoPath: path,
    env: {
      GIT_AUTHOR_NAME: 'glm test',
      GIT_AUTHOR_EMAIL: 'test@glm.local',
      GIT_COMMITTER_NAME: 'glm test',
      GIT_COMMITTER_EMAIL: 'test@glm.local',
    },
  });
  git.init({ initialBranch: opts.initialBranch ?? 'main' });
  // Local identity so test envs without global git config still work.
  git.config('user.name', 'glm test');
  git.config('user.email', 'test@glm.local');
  // Suppress GPG signing in case the user's machine config requires it.
  git.config('commit.gpgsign', 'false');
  git.config('tag.gpgsign', 'false');

  // Seed an initial commit so HEAD exists and branches can be created.
  git.commit({ message: 'seed', allowEmpty: true });

  return {
    path,
    git,
    cleanup() {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}
