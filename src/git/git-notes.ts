import type { GitClient } from './git-client.ts';

/**
 * `git notes` wrapper, scoped to a single namespace ref. Spec §9.6 attaches
 * in-toto attestations to sekkei commits via `refs/notes/generation`; this
 * client makes that operation a one-liner.
 *
 * Notes are payload-bearing UTF-8 blobs; binary data should be base64-encoded
 * by the caller.
 */
export class GitNotesClient {
  private readonly git: GitClient;
  public readonly ref: string;

  constructor(git: GitClient, ref = 'refs/notes/generation') {
    this.git = git;
    this.ref = ref;
  }

  /** Attach `content` as a note on `commit`. Replaces any existing note. */
  add(commit: string, content: string): void {
    this.git.run(['notes', `--ref=${this.ref}`, 'add', '-f', '--file=-', commit], content);
  }

  /** Read the note attached to `commit`. Returns null when missing. */
  show(commit: string): string | null {
    try {
      return this.git.run(['notes', `--ref=${this.ref}`, 'show', commit]);
    } catch {
      return null;
    }
  }

  /** Remove the note from `commit`. Returns true if a note was removed. */
  remove(commit: string): boolean {
    try {
      this.git.run(['notes', `--ref=${this.ref}`, 'remove', commit]);
      return true;
    } catch {
      return false;
    }
  }

  /** List `(commit, note_object)` tuples in this namespace. */
  list(): Array<{ commit: string; noteObject: string }> {
    const out = this.git.run(['notes', `--ref=${this.ref}`, 'list']);
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [noteObject = '', commit = ''] = line.split(/\s+/);
        return { commit, noteObject };
      });
  }
}
