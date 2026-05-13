import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanCodebase, renderScanForPrompt } from '../../src/lib/codebase-scan.ts';

function makeRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'glm-scan-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function write(root: string, rel: string, content: string): void {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

describe('scanCodebase', () => {
  test('lists every non-ignored file and directory', () => {
    const { root, cleanup } = makeRepo();
    try {
      write(root, 'README.md', '# hello');
      write(root, 'package.json', '{}');
      write(root, 'src/index.ts', 'export {};');
      write(root, 'src/lib/foo.ts', 'export const foo = 1;');
      const scan = scanCodebase({ rootDir: root });
      expect(scan.tree).toContain('README.md');
      expect(scan.tree).toContain('package.json');
      expect(scan.tree).toContain('src/');
      expect(scan.tree).toContain('src/index.ts');
      expect(scan.tree).toContain('src/lib/');
      expect(scan.tree).toContain('src/lib/foo.ts');
    } finally {
      cleanup();
    }
  });

  test('skips node_modules, .git, dist by default', () => {
    const { root, cleanup } = makeRepo();
    try {
      write(root, 'src/a.ts', 'a');
      write(root, 'node_modules/x/index.js', 'x');
      write(root, '.git/config', '[core]');
      write(root, 'dist/bundle.js', 'b');
      const scan = scanCodebase({ rootDir: root });
      expect(scan.tree).toContain('src/a.ts');
      expect(scan.tree.some((p) => p.includes('node_modules'))).toBe(false);
      expect(scan.tree.some((p) => p.includes('.git'))).toBe(false);
      expect(scan.tree.some((p) => p.includes('dist'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('caps tree at maxTreeEntries and reports truncation', () => {
    const { root, cleanup } = makeRepo();
    try {
      for (let i = 0; i < 10; i++) write(root, `file-${i}.ts`, '');
      const scan = scanCodebase({ rootDir: root, maxTreeEntries: 5 });
      expect(scan.tree.length).toBe(5);
      expect(scan.treeTruncated).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('excerpts pick README, package.json, and entry points first', () => {
    const { root, cleanup } = makeRepo();
    try {
      write(root, 'README.md', '# project');
      write(root, 'package.json', '{}');
      write(root, 'src/index.ts', 'export {};');
      write(root, 'docs/notes.md', 'notes');
      write(root, 'src/utils/helpers.ts', 'export const x = 1;');
      const scan = scanCodebase({ rootDir: root });
      const paths = scan.excerpts.map((e) => e.path);
      expect(paths).toContain('README.md');
      expect(paths).toContain('package.json');
      expect(paths).toContain('src/index.ts');
      // Source files under src/ are also eligible
      expect(paths).toContain('src/utils/helpers.ts');
      // README + package.json should be ranked ahead of arbitrary source files
      expect(paths.indexOf('README.md')).toBeLessThan(paths.indexOf('src/utils/helpers.ts'));
      expect(paths.indexOf('package.json')).toBeLessThan(paths.indexOf('src/utils/helpers.ts'));
    } finally {
      cleanup();
    }
  });

  test('truncates excerpts longer than maxExcerptLines', () => {
    const { root, cleanup } = makeRepo();
    try {
      write(root, 'src/long.ts', Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'));
      const scan = scanCodebase({ rootDir: root, maxExcerptLines: 50 });
      const long = scan.excerpts.find((e) => e.path === 'src/long.ts');
      expect(long).toBeDefined();
      expect(long?.truncated).toBe(true);
      expect(long?.totalLines).toBe(500);
      expect(long?.content.split('\n').length).toBe(50);
    } finally {
      cleanup();
    }
  });

  test('caps excerpts at maxExcerptFiles', () => {
    const { root, cleanup } = makeRepo();
    try {
      for (let i = 0; i < 30; i++) write(root, `src/mod${i}.ts`, 'x');
      const scan = scanCodebase({ rootDir: root, maxExcerptFiles: 5 });
      expect(scan.excerpts.length).toBe(5);
    } finally {
      cleanup();
    }
  });

  test('renderScanForPrompt formats the tree with a root header', () => {
    const { root, cleanup } = makeRepo();
    try {
      write(root, 'a.ts', 'a');
      const scan = scanCodebase({ rootDir: root });
      const rendered = renderScanForPrompt(scan);
      expect(rendered.fileTree.startsWith(`# ${root}`)).toBe(true);
      expect(rendered.fileTree).toContain('a.ts');
      expect(rendered.excerpts.length).toBe(1);
    } finally {
      cleanup();
    }
  });

  test('extra ignoreDirs are honored', () => {
    const { root, cleanup } = makeRepo();
    try {
      write(root, 'src/a.ts', 'a');
      write(root, 'secret/key.txt', '...');
      const scan = scanCodebase({ rootDir: root, ignoreDirs: ['secret'] });
      expect(scan.tree).toContain('src/a.ts');
      expect(scan.tree.some((p) => p.includes('secret'))).toBe(false);
    } finally {
      cleanup();
    }
  });
});
