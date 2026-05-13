import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Locate the GLM repo root so vibe-design can load `docs/sekkei-authoring.md`
 * and `specification/sekkei.schema.json` at runtime.
 *
 * Precedence:
 *   1. `GLM_REPO_ROOT` env var (operator override).
 *   2. Walk up from `start` until a directory containing one of MARKERS exists.
 *
 * `start` defaults to the CLI binary's own directory. We `realpath` it first
 * so a `bun link`-ed symlink resolves back to the source tree.
 */

const MARKERS = ['docs/sekkei-authoring.md'];

export interface FindRepoRootOptions {
  start?: string;
  env?: Record<string, string | undefined>;
  fileExists?: (path: string) => boolean;
}

export function findRepoRoot(opts: FindRepoRootOptions = {}): string {
  const env = opts.env ?? process.env;
  if (env.GLM_REPO_ROOT && env.GLM_REPO_ROOT.trim().length > 0) {
    return resolve(env.GLM_REPO_ROOT);
  }

  const fileExists = opts.fileExists ?? existsSync;
  const startRaw = opts.start ?? defaultStartPath();
  let current: string;
  try {
    current = realpathSync(startRaw);
  } catch {
    current = resolve(startRaw);
  }

  while (true) {
    for (const marker of MARKERS) {
      if (fileExists(join(current, marker))) return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `could not locate GLM repo root walking up from ${startRaw}. ` +
          `Set GLM_REPO_ROOT to point at your glm checkout.`,
      );
    }
    current = parent;
  }
}

export interface SkillFiles {
  authoringSkill: string;
  schemaJson: string | undefined;
}

export function loadSkillFiles(
  repoRoot: string,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): SkillFiles {
  const authoringSkill = readFile(join(repoRoot, 'docs', 'sekkei-authoring.md'));
  let schemaJson: string | undefined;
  try {
    schemaJson = readFile(join(repoRoot, 'specification', 'sekkei.schema.json'));
  } catch {
    schemaJson = undefined;
  }
  return { authoringSkill, schemaJson };
}

function defaultStartPath(): string {
  // import.meta.dir is `<repo>/integrations/cli/src/lib` when the CLI runs
  // from source. After `bun link`, it resolves through the symlink.
  return import.meta.dir;
}
