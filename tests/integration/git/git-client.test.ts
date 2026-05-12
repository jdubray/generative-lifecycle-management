import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRepo, type TempRepo } from './helpers.ts';

describe('GitClient', () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());

  test('init + commit + revParse round-trip', () => {
    repo = makeTempRepo();
    writeFileSync(join(repo.path, 'README.md'), '# hello\n', 'utf8');
    repo.git.add(['README.md']);
    const { hash } = repo.git.commit({ message: 'add readme' });
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    expect(repo.git.revParse('HEAD')).toBe(hash);
  });

  test('logGrep finds a commit by message substring', () => {
    repo = makeTempRepo();
    writeFileSync(join(repo.path, 'a.txt'), 'a', 'utf8');
    repo.git.add(['a.txt']);
    repo.git.commit({ message: 'ECN: archived todos\n\nSCR: SCR-2090\n' });
    const found = repo.git.logGrep('SCR-2090');
    expect(found.length).toBe(1);
    expect(found[0]?.body).toContain('SCR: SCR-2090');
  });

  test('showFiles lists the paths changed by a commit', () => {
    repo = makeTempRepo();
    writeFileSync(join(repo.path, 'b.txt'), 'b', 'utf8');
    repo.git.add(['b.txt']);
    const { hash } = repo.git.commit({ message: 'second' });
    expect(repo.git.showFiles(hash)).toContain('b.txt');
  });

  test('GitError carries stderr from the underlying git call', () => {
    repo = makeTempRepo();
    try {
      repo.git.run(['rev-parse', 'this-ref-does-not-exist']);
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as Error;
      expect(err.name).toBe('GitError');
      expect(err.message).toContain('this-ref-does-not-exist');
    }
  });

  test('describe returns nearest annotated tag', () => {
    repo = makeTempRepo();
    writeFileSync(join(repo.path, 'x.txt'), 'x', 'utf8');
    repo.git.add(['x.txt']);
    repo.git.commit({ message: 'tagged commit' });
    repo.git.tag('v1.0', { message: 'release 1.0' });
    // describe with --abbrev=0 returns the tag name verbatim
    expect(repo.git.describe({ abbrev: 0 })).toBe('v1.0');
  });

  test('describe throws GitError when no tag reachable', () => {
    repo = makeTempRepo();
    writeFileSync(join(repo.path, 'y.txt'), 'y', 'utf8');
    repo.git.add(['y.txt']);
    repo.git.commit({ message: 'no tag yet' });
    expect(() => repo.git.describe()).toThrow();
  });

  test('tagVerify returns false for unsigned annotated tag', () => {
    repo = makeTempRepo();
    writeFileSync(join(repo.path, 'z.txt'), 'z', 'utf8');
    repo.git.add(['z.txt']);
    repo.git.commit({ message: 'for tag' });
    repo.git.tag('unsigned', { message: 'unsigned annotated tag' });
    // No GPG key in test env — verification always fails → false
    expect(repo.git.tagVerify('unsigned')).toBe(false);
  });

  test('tag() throws when signed:true but no message', () => {
    repo = makeTempRepo();
    writeFileSync(join(repo.path, 'w.txt'), 'w', 'utf8');
    repo.git.add(['w.txt']);
    repo.git.commit({ message: 'for signed tag guard' });
    expect(() => repo.git.tag('S.0', { signed: true })).toThrow(/require a message/);
  });
});
