import { describe, expect, test } from 'bun:test';
import {
  buildDiffAwarePrompt,
  computeStructuredDiff,
  computeYamlDiff,
} from '../../../src/generation/spec-diff.ts';

// ---------------------------------------------------------------------------
// computeStructuredDiff
// ---------------------------------------------------------------------------

describe('computeStructuredDiff', () => {
  test('returns empty array when bodies are identical', () => {
    const body = { spec_kind: 'prompt', content: 'do the thing' };
    expect(computeStructuredDiff(body, { ...body })).toEqual([]);
  });

  test('detects a changed field', () => {
    const prev = { spec_kind: 'prompt', content: 'old prose' };
    const next = { spec_kind: 'prompt', content: 'new prose' };
    const diffs = computeStructuredDiff(prev, next);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ path: 'content', op: 'change', before: 'old prose', after: 'new prose' });
  });

  test('detects an added field', () => {
    const prev = { spec_kind: 'prompt', content: 'x' };
    const next = { spec_kind: 'prompt', content: 'x', verifier: 'eslint' };
    const diffs = computeStructuredDiff(prev, next);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ path: 'verifier', op: 'add', after: 'eslint' });
  });

  test('detects a removed field', () => {
    const prev = { spec_kind: 'prompt', content: 'x', verifier: 'eslint' };
    const next = { spec_kind: 'prompt', content: 'x' };
    const diffs = computeStructuredDiff(prev, next);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ path: 'verifier', op: 'remove', before: 'eslint' });
  });

  test('detects multiple simultaneous changes', () => {
    const prev = { spec_kind: 'prompt', content: 'old', outputs: ['a'] };
    const next = { spec_kind: 'prompt', content: 'new', verifier: 'jest' };
    const diffs = computeStructuredDiff(prev, next);
    const paths = diffs.map((d) => d.path).sort();
    expect(paths).toEqual(['content', 'outputs', 'verifier']);
  });

  test('compares array fields by JSON equality', () => {
    const prev = { outputs: ['a', 'b'] };
    const next = { outputs: ['a', 'c'] };
    const diffs = computeStructuredDiff(prev, next);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].op).toBe('change');
  });

  test('treats key-order differences in nested objects as equal', () => {
    // Two semantically identical objects that differ only in JSON key order must
    // NOT produce a spurious diff (canonicalize sorts keys recursively).
    const prev = { meta: { b: 2, a: 1 } };
    const next = { meta: { a: 1, b: 2 } }; // same content, different order
    expect(computeStructuredDiff(prev, next)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeYamlDiff
// ---------------------------------------------------------------------------

describe('computeYamlDiff', () => {
  test('returns empty string when bodies are identical', () => {
    const body = { spec_kind: 'prompt', content: 'same' };
    expect(computeYamlDiff(body, { ...body })).toBe('');
  });

  test('returns non-empty string when content changes', () => {
    const prev = { spec_kind: 'prompt', content: 'old' };
    const next = { spec_kind: 'prompt', content: 'new' };
    const diff = computeYamlDiff(prev, next);
    expect(diff.length).toBeGreaterThan(0);
    expect(diff).toContain('-');
    expect(diff).toContain('+');
  });

  test('includes --- and +++ headers', () => {
    const diff = computeYamlDiff({ a: 1 }, { a: 2 });
    expect(diff).toContain('---');
    expect(diff).toContain('+++');
  });
});

// ---------------------------------------------------------------------------
// buildDiffAwarePrompt
// ---------------------------------------------------------------------------

describe('buildDiffAwarePrompt', () => {
  const opts = {
    previousArtifact: 'function foo() {}',
    previousSpecYaml: 'spec_kind: prompt\ncontent: old',
    specDiffYaml: '--- a\n+++ b\n- content: old\n+ content: new',
    realizationDrift: '+  // operator comment',
    originalPrompt: 'Generate the module.',
  };

  test('includes all key sections', () => {
    const prompt = buildDiffAwarePrompt(opts);
    expect(prompt).toContain('previously generated');
    expect(prompt).toContain(opts.previousArtifact);
    expect(prompt).toContain('spec has been updated');
    // specDiffYaml lines appear indented in the prompt
    expect(prompt).toContain('--- a');
    expect(prompt).toContain('+++ b');
    expect(prompt).toContain('human modifications');
    expect(prompt).toContain(opts.realizationDrift);
    expect(prompt).toContain(opts.originalPrompt);
  });

  test('shows "(none)" when realizationDrift is empty', () => {
    const prompt = buildDiffAwarePrompt({ ...opts, realizationDrift: '' });
    expect(prompt).toContain('(none)');
  });

  test('ends with the original prompt', () => {
    const prompt = buildDiffAwarePrompt(opts);
    expect(prompt.trimEnd()).toEndWith(opts.originalPrompt);
  });
});
