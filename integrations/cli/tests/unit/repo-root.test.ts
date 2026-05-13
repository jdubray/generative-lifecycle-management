import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRepoRoot, loadSkillFiles } from '../../src/lib/repo-root.ts';

function makeFakeRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'glm-repo-test-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'sekkei-authoring.md'), '# Skill: Sekkei Authoring\nbody');
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('findRepoRoot', () => {
  test('returns GLM_REPO_ROOT when set in env', () => {
    const found = findRepoRoot({ env: { GLM_REPO_ROOT: '/tmp/fake-glm' } });
    // resolve() is OS-dependent but should at minimum end with fake-glm.
    expect(found.toLowerCase().endsWith('fake-glm')).toBe(true);
  });

  test('walks up from a nested start path to find docs/sekkei-authoring.md', () => {
    const { root, cleanup } = makeFakeRepo();
    try {
      const nested = join(root, 'integrations', 'cli', 'src', 'lib');
      mkdirSync(nested, { recursive: true });
      const found = findRepoRoot({ start: nested, env: {} });
      expect(found).toBe(root);
    } finally {
      cleanup();
    }
  });

  test('throws when no marker is found walking up', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'glm-no-root-'));
    try {
      expect(() =>
        findRepoRoot({ start: tmp, env: {}, fileExists: () => false }),
      ).toThrow(/could not locate GLM repo root/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('loadSkillFiles', () => {
  test('loads docs/sekkei-authoring.md; schema is optional', () => {
    const { root, cleanup } = makeFakeRepo();
    try {
      const skill = loadSkillFiles(root);
      expect(skill.authoringSkill).toContain('# Skill: Sekkei Authoring');
      expect(skill.schemaJson).toBeUndefined(); // not written in the fake repo
    } finally {
      cleanup();
    }
  });

  test('returns schema content when specification/sekkei.schema.json exists', () => {
    const { root, cleanup } = makeFakeRepo();
    try {
      mkdirSync(join(root, 'specification'), { recursive: true });
      writeFileSync(join(root, 'specification', 'sekkei.schema.json'), '{"type":"object"}');
      const skill = loadSkillFiles(root);
      expect(skill.schemaJson).toBe('{"type":"object"}');
    } finally {
      cleanup();
    }
  });

  test('uses injected readFile (no real fs reads)', () => {
    const reads: string[] = [];
    const fakeReader = (p: string) => {
      reads.push(p);
      if (p.endsWith('sekkei-authoring.md')) return 'INJECTED-SKILL';
      throw new Error('not found');
    };
    const skill = loadSkillFiles('/fake/root', fakeReader);
    expect(skill.authoringSkill).toBe('INJECTED-SKILL');
    expect(skill.schemaJson).toBeUndefined();
    expect(reads.length).toBeGreaterThan(0);
  });
});
