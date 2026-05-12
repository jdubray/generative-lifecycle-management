import { spawnSync } from 'node:child_process';

/**
 * Thin typed wrapper around the `git` CLI. The only directory in the codebase
 * allowed to shell out to git lives in this module (and `git-notes.ts` /
 * `hook-installer.ts` which re-use this client).
 *
 * Every method runs git as a child process with `cwd = repoPath` and captures
 * stdout + stderr. Non-zero exit codes throw `GitError` with the underlying
 * stderr so route handlers can map it to a 5xx without losing the original
 * cause.
 *
 * The `env` field lets the caller force deterministic identities in tests
 * via `GIT_AUTHOR_NAME` / `GIT_COMMITTER_EMAIL` / etc.
 */

export class GitError extends Error {
  public readonly args: readonly string[];
  public readonly stderr: string;
  public readonly stdout: string;
  public readonly status: number | null;
  constructor(args: readonly string[], stderr: string, stdout: string, status: number | null) {
    super(`git ${args.join(' ')} failed (exit ${status ?? '?'}): ${stderr.trim() || stdout.trim()}`);
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
    this.stdout = stdout;
    this.status = status;
  }
}

export interface GitClientOptions {
  /** Absolute path to the git working tree. */
  repoPath: string;
  /** Extra environment variables (merged on top of process.env). */
  env?: Record<string, string>;
  /** Optional override for the git executable. */
  gitBin?: string;
}

export interface GitCommitOptions {
  message: string;
  allowEmpty?: boolean;
  authorName?: string;
  authorEmail?: string;
  /** When true, runs `git commit -S` (Class I SCRs per spec §9.5). */
  signed?: boolean;
}

export interface GitCommitInfo {
  hash: string;
  shortHash: string;
}

export interface GitLogEntry {
  hash: string;
  subject: string;
  body: string;
}

export interface GitCloneOptions {
  /** When true, passes `--no-checkout` to skip the working-tree population. */
  noCheckout?: boolean;
  /** Override for the git executable. */
  gitBin?: string;
  /** Extra environment variables for the cloned repo's GitClient. */
  env?: Record<string, string>;
}

export class GitClient {
  public readonly repoPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly customEnv: Record<string, string>;
  private readonly gitBin: string;

  /**
   * Clone `remote` into `targetDir`. The parent directory of `targetDir` must
   * already exist; `git clone` will create `targetDir` itself.
   */
  static clone(remote: string, targetDir: string, opts: GitCloneOptions = {}): GitClient {
    const gitBin = opts.gitBin ?? 'git';
    const args = ['clone'];
    if (opts.noCheckout) args.push('--no-checkout');
    args.push(remote, targetDir);
    const result = spawnSync(gitBin, args, { encoding: 'utf8', env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new GitError(args, result.stderr ?? '', result.stdout ?? '', result.status);
    }
    return new GitClient({ repoPath: targetDir, gitBin, env: opts.env });
  }

  constructor(opts: GitClientOptions) {
    this.repoPath = opts.repoPath;
    this.customEnv = opts.env ?? {};
    this.env = { ...process.env, ...this.customEnv };
    this.gitBin = opts.gitBin ?? 'git';
  }

  /** Run an arbitrary `git ...` invocation, returning trimmed stdout. */
  run(args: readonly string[], stdin?: string): string {
    const result = spawnSync(this.gitBin, args, {
      cwd: this.repoPath,
      env: this.env,
      input: stdin,
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new GitError(args, result.stderr ?? '', result.stdout ?? '', result.status);
    }
    return (result.stdout ?? '').replace(/\r\n/g, '\n');
  }

  /** Initialize a fresh repo at `repoPath` (must exist). */
  init(opts: { initialBranch?: string } = {}): void {
    const args = ['init'];
    if (opts.initialBranch) args.push('-b', opts.initialBranch);
    this.run(args);
  }

  /** Set a local repo config value (e.g., `user.email`). */
  config(key: string, value: string): void {
    this.run(['config', key, value]);
  }

  /** Stage paths (relative to repoPath). */
  add(paths: readonly string[]): void {
    if (paths.length === 0) return;
    this.run(['add', '--', ...paths]);
  }

  /**
   * Create a commit. Returns the commit's hash. The full message is passed
   * via stdin (`--file=-`) so we never have to quote-escape it for the shell.
   */
  commit(opts: GitCommitOptions): GitCommitInfo {
    const args = ['commit'];
    if (opts.allowEmpty) args.push('--allow-empty');
    if (opts.signed) args.push('-S');
    if (opts.authorName && opts.authorEmail) {
      args.push('--author', `${opts.authorName} <${opts.authorEmail}>`);
    }
    args.push('--file=-');
    const env: Record<string, string> = {};
    if (opts.authorName) {
      env.GIT_AUTHOR_NAME = opts.authorName;
      env.GIT_COMMITTER_NAME = opts.authorName;
    }
    if (opts.authorEmail) {
      env.GIT_AUTHOR_EMAIL = opts.authorEmail;
      env.GIT_COMMITTER_EMAIL = opts.authorEmail;
    }
    const prevEnv = this.env;
    Object.assign(this.env, env);
    try {
      this.run(args, opts.message);
    } finally {
      // Restore env so the override stays scoped to this call.
      Object.assign(this.env, prevEnv);
    }
    const hash = this.run(['rev-parse', 'HEAD']).trim();
    return { hash, shortHash: hash.slice(0, 12) };
  }

  /** Read the full message of a commit. */
  showMessage(ref: string): string {
    return this.run(['log', '-1', '--format=%B', ref]).replace(/\n+$/, '\n');
  }

  /** Search log messages with `git log --grep`. */
  logGrep(needle: string, limit = 50): GitLogEntry[] {
    const sep = '<<<glm-rec>>>';
    const fieldSep = '<<<glm-field>>>';
    const out = this.run([
      'log',
      '--grep',
      needle,
      `--format=${sep}%H${fieldSep}%s${fieldSep}%b`,
      `-n${limit}`,
    ]);
    return out
      .split(sep)
      .map((rec) => rec.trim())
      .filter((rec) => rec.length > 0)
      .map((rec) => {
        const [hash = '', subject = '', body = ''] = rec.split(fieldSep);
        return { hash, subject, body };
      });
  }

  /** List the files touched by a specific commit. */
  showFiles(ref: string): string[] {
    return this.run(['show', '--name-only', '--format=', ref])
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  /** Read the contents of a file at a specific ref. */
  showFile(ref: string, path: string): string {
    return this.run(['show', `${ref}:${path}`]);
  }

  /** Resolve a ref (branch, tag, sha) to a full hash. */
  revParse(ref: string): string {
    return this.run(['rev-parse', ref]).trim();
  }

  /** Create a branch at `start` (defaults to HEAD) and optionally check it out. */
  branch(name: string, opts: { start?: string; checkout?: boolean } = {}): void {
    if (opts.checkout) {
      const args = ['checkout', '-b', name];
      if (opts.start) args.push(opts.start);
      this.run(args);
    } else {
      const args = ['branch', name];
      if (opts.start) args.push(opts.start);
      this.run(args);
    }
  }

  /** Switch to an existing branch. */
  checkout(ref: string): void {
    this.run(['checkout', ref]);
  }

  /** Annotate a ref with a tag. Pass `signed: true` to create a GPG-signed tag. */
  tag(name: string, opts: { ref?: string; message?: string; signed?: boolean } = {}): void {
    if (opts.signed && !opts.message) {
      throw new Error(`tag '${name}': signed tags require a message (-m)`);
    }
    const args = ['tag'];
    if (opts.message) {
      if (opts.signed) {
        args.push('-s', '-a', '-m', opts.message);
      } else {
        args.push('-a', '-m', opts.message);
      }
    }
    args.push(name);
    if (opts.ref) args.push(opts.ref);
    this.run(args);
  }

  /**
   * Verify a signed annotated tag with `git tag -v`. Returns `true` when
   * GPG signature verification succeeds, `false` otherwise (unsigned,
   * lightweight, or bad signature).
   */
  tagVerify(name: string): boolean {
    try {
      this.run(['tag', '-v', name]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * `git describe [--tags] [--match <pattern>] [--abbrev=N]`.
   * Finds the nearest tag reachable from HEAD. Throws `GitError` when no
   * tag is reachable (e.g. fresh repo with no tags).
   */
  describe(opts: { tags?: boolean; match?: string; abbrev?: number } = {}): string {
    const args = ['describe'];
    if (opts.tags) args.push('--tags');
    if (opts.match) args.push('--match', opts.match);
    if (opts.abbrev !== undefined) args.push(`--abbrev=${opts.abbrev}`);
    return this.run(args).trim();
  }

  /**
   * `git tag --list [<pattern>]`. Returns all tag names matching the optional
   * glob pattern (same syntax as `git tag -l`). An empty result is returned
   * when no tags exist rather than throwing.
   */
  listTags(pattern?: string): string[] {
    const args = ['tag', '--list'];
    if (pattern) args.push(pattern);
    try {
      return this.run(args)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * `git pull --ff-only`. Returns the new HEAD sha on success.
   * Throws `GitError` when fast-forward is impossible (diverged remote).
   */
  pull(): string {
    this.run(['pull', '--ff-only']);
    return this.revParse('HEAD');
  }

  /**
   * List every file path that changed between two commits (equivalent to
   * `git diff --name-only <from>..<to>`). Only YAML files under `nodes/` are
   * meaningful to the sync service, but we return everything and let the
   * caller filter.
   */
  logChangedFiles(from: string, to: string): string[] {
    return this.run(['diff', '--name-only', `${from}..${to}`])
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  /** Returns the name of the currently checked-out branch (symbolic HEAD). */
  currentBranch(): string {
    return this.run(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  }

  /**
   * `git merge --ff-only <branch>`. Only fast-forward merges are accepted;
   * throws `GitError` on divergence so the caller can handle it explicitly.
   */
  merge(branch: string): void {
    this.run(['merge', '--ff-only', branch]);
  }

  /**
   * Delete a branch (`git branch -d <name>`). The safe delete (-d) refuses to
   * delete unmerged branches; use only after the branch has been merged.
   */
  deleteBranch(name: string): void {
    this.run(['branch', '-d', name]);
  }

  /** `git push <remote> <refspec>`. */
  push(remote: string, refspec: string): void {
    this.run(['push', remote, refspec]);
  }

  /** Returns true when a local branch with this exact name exists. */
  branchExists(name: string): boolean {
    return this.run(['branch', '--list', name]).trim().length > 0;
  }

  /**
   * `git worktree add <path> [-b <branch>] [<branch>]`.
   *
   * When `opts.newBranch` is true, passes `-b <branch>` to create a fresh
   * branch at HEAD; otherwise checks out an existing branch by name.
   *
   * Returns a new `GitClient` scoped to the worktree directory, with the same
   * identity env vars as the parent so commits carry the correct authorship.
   */
  worktreeAdd(worktreePath: string, branch: string, opts: { newBranch?: boolean } = {}): GitClient {
    const args = ['worktree', 'add'];
    if (opts.newBranch) {
      args.push('-b', branch);
    }
    args.push(worktreePath);
    if (!opts.newBranch) {
      args.push(branch);
    }
    this.run(args);
    return new GitClient({ repoPath: worktreePath, env: this.customEnv, gitBin: this.gitBin });
  }

  /**
   * `git worktree remove <path> --force`.
   * `--force` is needed when the worktree has uncommitted changes that we
   * cleaned up manually — shouldn't happen in normal flow but is safe here.
   */
  worktreeRemove(worktreePath: string): void {
    this.run(['worktree', 'remove', '--force', worktreePath]);
  }

  /** `git worktree prune` — remove stale worktree registrations. */
  worktreePrune(): void {
    this.run(['worktree', 'prune']);
  }

  /**
   * `git diff <from> <to> [-- <path>]`. Returns the unified diff text; an
   * empty string when the range is identical.
   *
   * `git diff` exits 1 when differences exist and 0 when they don't. We
   * treat exit 1 as a non-error and return `stdout` so callers always get a
   * string back.
   */
  diff(from: string, to: string, path?: string): string {
    const args = ['diff', from, to];
    if (path) args.push('--', path);
    try {
      return this.run(args);
    } catch (err) {
      if (err instanceof GitError && err.status === 1) {
        return err.stdout;
      }
      throw err;
    }
  }

  /**
   * `git hash-object <filePath>`. Returns git's SHA-1 blob hash of the file
   * content as a 40-character hex string. Useful for correlating with git's
   * internal object store; callers that need SHA-256 should compute it in
   * Node via `createHash('sha256')`.
   */
  hashObject(filePath: string): string {
    return this.run(['hash-object', filePath]).trim();
  }

  /** `git status --porcelain` parsed into entries. */
  statusPorcelain(): Array<{ status: string; path: string }> {
    return this.run(['status', '--porcelain'])
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => ({ status: l.slice(0, 2), path: l.slice(3) }));
  }
}
