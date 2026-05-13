import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Scan a codebase directory for `glm vibe --from-dir` (UC-04 reverse-engineer).
 *
 * Two outputs:
 *
 *   1. `tree` — every non-ignored relative path under `rootDir`, sorted, with
 *      a hard cap on entry count so very large repos don't blow up the prompt.
 *
 *   2. `excerpts` — up to N "key" files with up to L lines of content each.
 *      Files are selected in priority order (README, manifests, entry points,
 *      then any source under src/) so the LLM sees the highest-signal files
 *      first when it has to triage many candidates.
 *
 * Ignore semantics are intentionally simple — a hard-coded directory blocklist
 * (node_modules, .git, dist, etc.) rather than full `.gitignore` parsing. The
 * blocklist covers the common cases for v0.1; users with unusual layouts can
 * post-edit the generated sekkei.
 */

export interface ScanCodebaseOptions {
  rootDir: string;
  maxTreeEntries?: number;
  maxExcerptFiles?: number;
  maxExcerptLines?: number;
  /** Extra dir names to skip in addition to the default blocklist. */
  ignoreDirs?: Iterable<string>;
  /** Inject a custom directory reader (tests). */
  readDir?: (path: string) => string[];
  /** Inject a stat function (tests). */
  stat?: (path: string) => { isDirectory: boolean; isFile: boolean };
  /** Inject a file reader (tests). */
  readFile?: (path: string) => string;
}

export interface CodebaseScan {
  rootDir: string;
  /** Posix-style relative paths, directories suffixed with `/`. */
  tree: string[];
  /** Whether `tree` was capped by `maxTreeEntries`. */
  treeTruncated: boolean;
  excerpts: ExcerptFile[];
}

export interface ExcerptFile {
  path: string;
  content: string;
  /** True if the file was longer than `maxExcerptLines`. */
  truncated: boolean;
  /** Total line count of the original file. */
  totalLines: number;
}

const DEFAULT_IGNORE_DIRS = new Set<string>([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.pytest_cache',
  '.tox',
  'coverage',
  '.nyc_output',
  '.vscode',
  '.idea',
  '.cache',
  '.parcel-cache',
  '.svelte-kit',
]);

const PRIORITY_PATTERNS: Array<{ depth: number | 'any'; matcher: (name: string) => boolean }> = [
  // 1. Manifests + READMEs at the repo root.
  { depth: 0, matcher: (n) => /^readme(\.md|\.txt|\.rst)?$/i.test(n) },
  { depth: 0, matcher: (n) => n === 'package.json' },
  { depth: 0, matcher: (n) => n === 'pyproject.toml' || n === 'setup.py' },
  { depth: 0, matcher: (n) => n === 'Cargo.toml' },
  { depth: 0, matcher: (n) => n === 'go.mod' },
  { depth: 0, matcher: (n) => n === 'Gemfile' },
  { depth: 0, matcher: (n) => n === 'composer.json' },
  // 2. Build configs at the repo root.
  { depth: 0, matcher: (n) => /^tsconfig.*\.json$/.test(n) || /^jsconfig.*\.json$/.test(n) },
  { depth: 0, matcher: (n) => n === 'biome.json' || n === '.eslintrc.json' || n === 'eslint.config.js' },
  // 3. Likely entry points.
  { depth: 'any', matcher: (n) => /^(main|index|app|server)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/.test(n) },
  // 4. Anything under src/ (any depth).
  { depth: 'any', matcher: (n) => /\.(ts|tsx|js|jsx|py|go|rs|rb|java|kt)$/.test(n) },
];

export function scanCodebase(opts: ScanCodebaseOptions): CodebaseScan {
  const maxTree = opts.maxTreeEntries ?? 500;
  const maxFiles = opts.maxExcerptFiles ?? 20;
  const maxLines = opts.maxExcerptLines ?? 200;
  const readDir = opts.readDir ?? ((p) => readdirSync(p));
  const stat = opts.stat ?? defaultStat;
  const readFile = opts.readFile ?? ((p) => readFileSync(p, 'utf8'));

  const ignore = new Set<string>(DEFAULT_IGNORE_DIRS);
  for (const extra of opts.ignoreDirs ?? []) ignore.add(extra);

  const allEntries = walk(opts.rootDir, ignore, readDir, stat);

  const tree = allEntries.slice(0, maxTree).map((e) => (e.isDir ? `${e.relPath}/` : e.relPath));
  const treeTruncated = allEntries.length > maxTree;

  const fileEntries = allEntries.filter((e) => !e.isDir);
  const ranked = rankByPriority(fileEntries);
  const excerpts: ExcerptFile[] = [];
  for (const entry of ranked) {
    if (excerpts.length >= maxFiles) break;
    let raw: string;
    try {
      raw = readFile(join(opts.rootDir, ...entry.relPath.split('/')));
    } catch {
      continue;
    }
    const lines = raw.split(/\r?\n/);
    const truncated = lines.length > maxLines;
    excerpts.push({
      path: entry.relPath,
      content: truncated ? lines.slice(0, maxLines).join('\n') : raw,
      truncated,
      totalLines: lines.length,
    });
  }

  return { rootDir: opts.rootDir, tree, treeTruncated, excerpts };
}

// ---------------------------------------------------------------------- walk

interface Entry {
  relPath: string; // posix-style, relative to rootDir
  isDir: boolean;
  depth: number;
  name: string;
}

function walk(
  rootDir: string,
  ignore: Set<string>,
  readDir: (p: string) => string[],
  stat: (p: string) => { isDirectory: boolean; isFile: boolean },
): Entry[] {
  const out: Entry[] = [];
  const stack: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: rootDir, rel: '', depth: 0 },
  ];
  while (stack.length > 0) {
    const top = stack.pop();
    if (!top) break;
    let names: string[];
    try {
      names = readDir(top.abs);
    } catch {
      continue;
    }
    names.sort();
    for (const name of names) {
      if (ignore.has(name)) continue;
      const childAbs = join(top.abs, name);
      const childRel = top.rel ? `${top.rel}/${name}` : name;
      let info;
      try {
        info = stat(childAbs);
      } catch {
        continue;
      }
      if (info.isDirectory) {
        out.push({ relPath: childRel, isDir: true, depth: top.depth + 1, name });
        stack.push({ abs: childAbs, rel: childRel, depth: top.depth + 1 });
      } else if (info.isFile) {
        out.push({ relPath: childRel, isDir: false, depth: top.depth + 1, name });
      }
    }
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

function rankByPriority(entries: Entry[]): Entry[] {
  const scored = entries.map((e) => ({ e, score: priorityScore(e) }));
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.e.relPath.localeCompare(b.e.relPath);
  });
  return scored.filter((s) => s.score !== Infinity).map((s) => s.e);
}

function priorityScore(entry: Entry): number {
  for (let i = 0; i < PRIORITY_PATTERNS.length; i++) {
    const pat = PRIORITY_PATTERNS[i];
    if (!pat) continue;
    if (pat.depth === 'any' || pat.depth === entry.depth - 1) {
      if (pat.matcher(entry.name)) return i;
    }
  }
  return Infinity;
}

function defaultStat(path: string): { isDirectory: boolean; isFile: boolean } {
  const st = statSync(path);
  return { isDirectory: st.isDirectory(), isFile: st.isFile() };
}

// ---------------------------------------------------------------------- render

/** Format a scan as text for embedding in the reverse-engineer user prompt. */
export function renderScanForPrompt(scan: CodebaseScan): { fileTree: string; excerpts: ExcerptFile[] } {
  const treeLines: string[] = [`# ${scan.rootDir}`];
  for (const path of scan.tree) treeLines.push(path);
  if (scan.treeTruncated) {
    treeLines.push(`# ... tree truncated at ${scan.tree.length} entries`);
  }
  return { fileTree: treeLines.join('\n'), excerpts: scan.excerpts };
}
