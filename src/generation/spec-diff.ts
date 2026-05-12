import { stringify as stringifyYaml } from 'yaml';
import { canonicalize } from '../domain/content-hash.ts';

export type DiffOp = 'add' | 'remove' | 'change';

/** A single field-level change between two spec body snapshots. */
export interface SpecDiff {
  /** Top-level key name (spec bodies are shallow objects). */
  path: string;
  op: DiffOp;
  before?: unknown;
  after?: unknown;
}

/**
 * Return a flat, field-level diff between two spec body JSON objects.
 *
 * Only top-level keys are compared. For the `content` field (the prose spec)
 * the full old and new values are included so the caller can feed them to the
 * LLM verbatim; for other fields the JSON-serialised values are compared.
 */
export function computeStructuredDiff(
  prevBody: Record<string, unknown>,
  nextBody: Record<string, unknown>,
): SpecDiff[] {
  const diffs: SpecDiff[] = [];
  const allKeys = new Set([...Object.keys(prevBody), ...Object.keys(nextBody)]);

  for (const key of allKeys) {
    const hasPrev = key in prevBody;
    const hasNext = key in nextBody;
    if (!hasPrev) {
      diffs.push({ path: key, op: 'add', after: nextBody[key] });
    } else if (!hasNext) {
      diffs.push({ path: key, op: 'remove', before: prevBody[key] });
    } else {
      // Use canonicalize (sorts keys recursively) so two semantically identical
      // objects that differ only in key order are not reported as changed.
      const prevCanon = canonicalize(prevBody[key]);
      const nextCanon = canonicalize(nextBody[key]);
      if (prevCanon !== nextCanon) {
        diffs.push({ path: key, op: 'change', before: prevBody[key], after: nextBody[key] });
      }
    }
  }
  return diffs;
}

/**
 * Return a unified-diff-style string comparing YAML representations of two
 * spec body snapshots. Intended for inclusion in LLM prompts where a
 * human-readable "what changed" is more useful than structured JSON.
 */
export function computeYamlDiff(
  prevBody: Record<string, unknown>,
  nextBody: Record<string, unknown>,
): string {
  // Filter out trailing empty strings produced by the YAML serialiser's final '\n'.
  const prevLines = stringifyYaml(prevBody, { lineWidth: 120 }).split('\n').filter(Boolean);
  const nextLines = stringifyYaml(nextBody, { lineWidth: 120 }).split('\n').filter(Boolean);
  return unifiedDiff(prevLines, nextLines, '--- spec (previous)', '+++ spec (updated)');
}

/**
 * Build the diff-aware prompt (§4.4.2).
 *
 * Prepends context about the prior artifact and the spec delta to the original
 * prompt so the LLM can produce a targeted update rather than a blank-slate
 * generation.
 */
export function buildDiffAwarePrompt(opts: {
  previousArtifact: string;
  previousSpecYaml: string;
  specDiffYaml: string;
  realizationDrift: string;
  originalPrompt: string;
}): string {
  return [
    'You previously generated the following artifact from this spec:',
    indent(opts.previousSpecYaml),
    '',
    'Previous artifact:',
    indent(opts.previousArtifact),
    '',
    'The spec has been updated. Here is the diff:',
    indent(opts.specDiffYaml),
    '',
    'The current realization has these human modifications since your last generation:',
    indent(opts.realizationDrift || '(none)'),
    '',
    'Generate the new code by applying the spec_diff and preserving the realization_drift',
    "where it doesn't conflict. If a conflict exists, prefer the spec_diff and call it out",
    'in your response.',
    '',
    opts.originalPrompt,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((l) => (l.length > 0 ? prefix + l : l))
    .join('\n');
}

/**
 * Produce a minimal unified diff between two arrays of lines using LCS.
 * Output is prefixed with `--- a` / `+++ b` headers.
 */
function unifiedDiff(a: string[], b: string[], aHeader = '--- a', bHeader = '+++ b'): string {
  if (a.join('\n') === b.join('\n')) return '';

  // Compute LCS table (O(m*n) — spec bodies are small so this is fine).
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Trace back through the LCS table to collect edit operations.
  const ops: Array<{ op: ' ' | '-' | '+'; line: string }> = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ op: ' ', line: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ op: '+', line: b[j - 1] });
      j--;
    } else {
      ops.push({ op: '-', line: a[i - 1] });
      i--;
    }
  }
  ops.reverse();

  const lines = [aHeader, bHeader];
  for (const { op, line } of ops) {
    lines.push(`${op} ${line}`);
  }
  return lines.join('\n');
}
