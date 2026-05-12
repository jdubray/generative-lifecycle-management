import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitNotesClient } from '../../../src/git/git-notes.ts';
import { makeTempRepo, type TempRepo } from './helpers.ts';

describe('GitNotesClient', () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());

  test('add/show/remove round-trip on refs/notes/generation', () => {
    repo = makeTempRepo();
    writeFileSync(join(repo.path, 'a.txt'), 'a', 'utf8');
    repo.git.add(['a.txt']);
    const { hash } = repo.git.commit({ message: 'commit a' });

    const notes = new GitNotesClient(repo.git);
    notes.add(hash, 'in-toto-statement-bytes');
    expect(notes.show(hash)?.trim()).toBe('in-toto-statement-bytes');

    expect(notes.remove(hash)).toBe(true);
    expect(notes.show(hash)).toBeNull();
  });
});
