import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Install local git hooks into a target repo (spec §9.7).
 *
 *   - pre-commit  — runs the sekkei verifier and refuses null-byte YAML
 *   - pre-receive — enforces ECN block + verifier on server pushes
 *
 * Hooks are written into `<repoPath>/.git/hooks/`. The pre-receive hook is
 * meaningful only on a bare repo, but writing it is harmless on a working
 * tree (just ignored). On non-POSIX filesystems `chmod 0o755` is a no-op.
 */

export const PRE_COMMIT_HOOK = `#!/bin/sh
# Installed by glm hook-installer; spec §9.7
set -e
if [ -x "./verify_sekkei.py" ]; then
  python3 ./verify_sekkei.py
fi
if [ -f "./specification/validate.py" ]; then
  python3 ./specification/validate.py . --show 5 || exit 1
fi
# Refuse null bytes in staged YAML
if git diff --cached --name-only -z | xargs -0 grep -l $'\\x00' 2>/dev/null; then
  echo "Null bytes detected in staged YAML"
  exit 1
fi
`;

export const PRE_RECEIVE_HOOK = `#!/bin/sh
# Installed by glm hook-installer; spec §9.7
# Enforced rules (Git Step 8):
#   1. No direct push to refs/heads/main  (release-only; use next + tags)
#   2. No force-push on any branch
#   3. Release tags ([A-Z].*) must be annotated; GPG-signed when
#      GLM_REQUIRE_SIGNED_TAGS=1
#   4. Commits on next / main must start with "ECN:" or "Merge "
#   5. variants/* branches must contain sekkei.lock at root
#   6. Every commit touching nodes/ carries an Affected: block
#   7. Optional 6-gate verifier (GLM_DB_PATH + GLM_WORKSPACE)
set -e
while read oldrev newrev refname; do
  # Ref deletions carry no commits to validate.
  if [ "$newrev" = "0000000000000000000000000000000000000000" ]; then
    continue
  fi

  # Rule 1: No direct push to main.
  if [ "$refname" = "refs/heads/main" ]; then
    echo "ERR: main is release-only; use next and release tags" >&2
    exit 1
  fi

  # Rule 2: No force-push (non-fast-forward update of an existing branch).
  case "$refname" in
    refs/heads/*)
      if [ "$oldrev" != "0000000000000000000000000000000000000000" ]; then
        if ! git merge-base --is-ancestor "$oldrev" "$newrev" 2>/dev/null; then
          echo "ERR: force-push not permitted on $refname" >&2
          exit 1
        fi
      fi
      ;;
  esac

  # Rule 3: Release tags must be annotated (and GPG-signed when required).
  case "$refname" in
    refs/tags/[A-Z].*)
      tagname="\${refname#refs/tags/}"
      tagtype=\$(git cat-file -t "$newrev" 2>/dev/null || echo "unknown")
      if [ "$tagtype" != "tag" ]; then
        echo "ERR: $tagname must be an annotated tag (got $tagtype)" >&2
        exit 1
      fi
      if [ "\${GLM_REQUIRE_SIGNED_TAGS:-0}" = "1" ]; then
        if ! git tag -v "$tagname" >/dev/null 2>&1; then
          echo "ERR: $tagname must be a signed tag (set GLM_REQUIRE_SIGNED_TAGS=0 to waive)" >&2
          exit 1
        fi
      fi
      ;;
  esac

  # Branch-only rules (4, 5, 6).
  case "$refname" in
    refs/heads/*)
      range="$oldrev..$newrev"
      if [ "$oldrev" = "0000000000000000000000000000000000000000" ]; then
        range="$newrev"
      fi

      # Rule 4: ECN format on next and main.
      case "$refname" in
        refs/heads/next|refs/heads/main)
          commits=\$(git rev-list "$range" 2>/dev/null) || true
          for commit in \$commits; do
            msg=\$(git show -s --format=%s "$commit")
            if ! echo "$msg" | grep -qE "^(ECN:|Merge )"; then
              echo "ERR: commit $commit does not start with 'ECN:' or 'Merge'" >&2
              exit 1
            fi
          done
          ;;
      esac

      # Rule 5: variants/* must carry sekkei.lock.
      case "$refname" in
        refs/heads/variants/*)
          if ! git show "$newrev:sekkei.lock" >/dev/null 2>&1; then
            echo "ERR: variants/* branch must contain sekkei.lock at root" >&2
            exit 1
          fi
          ;;
      esac

      # Rule 6: commits touching nodes/ must have an Affected: block.
      commits=\$(git rev-list "$range" 2>/dev/null) || true
      for commit in \$commits; do
        if git show --name-only --format= "$commit" | grep -q '^nodes/'; then
          if ! git show -s --format=%B "$commit" | grep -q '^Affected:'; then
            echo "ERR: commit $commit touches nodes/ but lacks an Affected: block" >&2
            exit 1
          fi
        fi
      done
      ;;
  esac
done

# Rule 7: Run the verifier when the deploy points us at a workspace + DB.
if [ -n "\${GLM_DB_PATH:-}" ] && [ -n "\${GLM_WORKSPACE:-}" ] && command -v bun >/dev/null 2>&1; then
  if ! bun run scripts/verify.ts --workspace="\${GLM_WORKSPACE}" --db="\${GLM_DB_PATH}"; then
    echo "ERR: 6-gate verifier failed; see audit_events.verifier.run" >&2
    exit 1
  fi
fi
`;

export interface HookInstallOptions {
  /** Working tree (or bare) repo path. */
  repoPath: string;
  /** Override which hooks to write. Defaults to both. */
  hooks?: Array<'pre-commit' | 'pre-receive'>;
}

/** Write the hook scripts and make them executable. Returns the paths written. */
export function installHooks(opts: HookInstallOptions): string[] {
  // Bare repos (e.g. `git init --bare`) have hooks/ at their root; non-bare
  // repos have hooks/ inside .git/.
  const gitDotDir = join(opts.repoPath, '.git');
  const hooksDir = existsSync(gitDotDir) ? join(gitDotDir, 'hooks') : join(opts.repoPath, 'hooks');
  mkdirSync(hooksDir, { recursive: true });

  const which = opts.hooks ?? ['pre-commit', 'pre-receive'];
  const written: string[] = [];
  for (const name of which) {
    const path = join(hooksDir, name);
    writeFileSync(path, name === 'pre-commit' ? PRE_COMMIT_HOOK : PRE_RECEIVE_HOOK, {
      encoding: 'utf8',
      mode: 0o755,
    });
    try {
      chmodSync(path, 0o755);
    } catch {
      // ignore on filesystems that don't support chmod (windows fat32, etc.)
    }
    written.push(path);
  }
  return written;
}

/** True if a hook file exists in the target repo. */
export function hookInstalled(repoPath: string, hook: 'pre-commit' | 'pre-receive'): boolean {
  const gitDotDir = join(repoPath, '.git');
  const hooksDir = existsSync(gitDotDir) ? join(gitDotDir, 'hooks') : join(repoPath, 'hooks');
  return existsSync(join(hooksDir, hook));
}
