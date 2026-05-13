import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { CliError } from './errors.ts';

/**
 * UC-02 generation helpers — assemble the system + user prompts the CLI
 * feeds to claude, parse the multi-file response, and resolve safe output
 * paths under the workspace's `source_dir`.
 *
 * These mirror the server-side helpers in `src/generation/component-spec.ts`
 * — duplicated rather than cross-package imported per the CLI/server
 * package-separation contract (the wire protocol is the only shared
 * surface).
 */

export class GenerateError extends CliError {
  constructor(message: string, exitCode = 70) {
    super(message, exitCode);
    this.name = 'GenerateError';
  }
}

/**
 * Hard constraints appended to Claude's system prompt. Defines the
 * multi-file delimiter format the parser expects. Identical to the
 * server-side constant.
 */
export const HARD_CONSTRAINTS = `HARD CONSTRAINTS:
- Output ONLY file content. No prose explanation, no markdown fences.
- Begin every file with a header line: \`=== FILE: <path-from-outputs> ===\`
- Emit the files in the order listed in OUTPUTS below.
- Do NOT emit files not listed in OUTPUTS.
- Do NOT use absolute paths or '..' segments in file headers.
- After the last file, stop. Do not append commentary.`;

export interface PromptInput {
  promptTemplate: string;
  contextBundleText: string;
  outputs: Array<{ path: string; description?: string }>;
}

export function buildSystemPrompt(input: PromptInput): string {
  const tpl = input.promptTemplate.trim();
  const outputBlock = input.outputs
    .map((o) => `  - path: ${o.path}\n    description: ${o.description ?? ''}`)
    .join('\n');
  return [
    tpl,
    '',
    'CONTEXT BUNDLE:',
    input.contextBundleText,
    '',
    'OUTPUTS to produce:',
    outputBlock,
    '',
    HARD_CONSTRAINTS,
  ].join('\n');
}

export interface UserPromptInput {
  glmId: string;
  title: string;
  outputs: Array<{ path: string; description?: string }>;
}

export function buildUserPrompt(input: UserPromptInput): string {
  return [
    `Generate the implementation of component '${input.glmId}' (${input.title}).`,
    `Produce exactly ${input.outputs.length} file${input.outputs.length === 1 ? '' : 's'}:`,
    ...input.outputs.map((o) => `  - ${o.path}`),
    '',
    'Each file must start with `=== FILE: <path> ===` on its own line.',
  ].join('\n');
}

export interface ParsedFile {
  path: string;
  content: string;
}

const FILE_HEADER_RE = /^===\s*FILE:\s*(.+?)\s*===\s*$/;

/**
 * Parse claude's multi-file response. Each file is prefixed by
 * `=== FILE: <path> ===\n`. Throws `GenerateError` when no markers
 * are emitted or when an emitted path is not in the expected set.
 */
export function parseMultiFileResponse(stdout: string, expectedPaths: string[]): ParsedFile[] {
  const lines = stdout.split(/\r?\n/);
  const files: ParsedFile[] = [];
  let current: { path: string; lines: string[] } | null = null;

  for (const line of lines) {
    const m = line.match(FILE_HEADER_RE);
    if (m) {
      if (current) files.push({ path: current.path, content: current.lines.join('\n') });
      current = { path: (m[1] ?? '').trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) files.push({ path: current.path, content: current.lines.join('\n') });

  if (files.length === 0) {
    throw new GenerateError(
      'Claude response contained no `=== FILE: <path> ===` markers. ' +
        'Did the model emit prose instead of the multi-file format?',
    );
  }

  const expectedSet = new Set(expectedPaths.map(normalize));
  for (const f of files) {
    if (!expectedSet.has(normalize(f.path))) {
      throw new GenerateError(
        `Claude emitted unexpected file path '${f.path}'. ` +
          `Expected one of: ${[...expectedSet].join(', ')}`,
      );
    }
  }

  return files.map((f) => ({
    path: f.path,
    content: f.content.endsWith('\n') ? f.content : `${f.content}\n`,
  }));
}

/**
 * Resolve a Claude-emitted relative path against `baseDir`, rejecting
 * absolute paths, `..` segments, and any resolved target outside the
 * base. Used to prevent path-traversal attacks via a hostile sekkei.
 */
export function resolveSafePath(baseDir: string, candidate: string): string {
  if (isAbsolute(candidate)) {
    throw new GenerateError(`output path '${candidate}' must be relative`);
  }
  if (candidate.includes('..')) {
    throw new GenerateError(`output path '${candidate}' must not contain '..'`);
  }
  const baseAbs = resolve(baseDir);
  const target = resolve(baseAbs, candidate);
  if (target !== baseAbs && !target.startsWith(baseAbs + sep)) {
    throw new GenerateError(`output path '${candidate}' escapes source_dir`);
  }
  return target;
}
