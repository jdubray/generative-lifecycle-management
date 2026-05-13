import { describe, expect, test } from 'bun:test';
import {
  buildVibeSystemPrompt,
  buildVibeUserPrompt,
  stripCodeFences,
} from '../../src/lib/prompts.ts';

describe('buildVibeSystemPrompt', () => {
  test('embeds the authoring skill verbatim', () => {
    const prompt = buildVibeSystemPrompt({
      authoringSkill: '# Skill: Sekkei Authoring\n... section content ...',
    });
    expect(prompt).toContain('# Skill: Sekkei Authoring');
    expect(prompt).toContain('AUTHORING SKILL');
    expect(prompt).toContain('HARD CONSTRAINTS');
  });

  test('includes the schema section only when schemaJson is non-empty', () => {
    const without = buildVibeSystemPrompt({ authoringSkill: 'skill' });
    expect(without).not.toContain('SEKKEI JSON SCHEMA');

    const withSchema = buildVibeSystemPrompt({
      authoringSkill: 'skill',
      schemaJson: '{"type":"object"}',
    });
    expect(withSchema).toContain('SEKKEI JSON SCHEMA');
    expect(withSchema).toContain('"type":"object"');
  });

  test('always includes the no-fences hard constraint', () => {
    const prompt = buildVibeSystemPrompt({ authoringSkill: 'x' });
    expect(prompt).toContain('Output ONLY YAML');
    expect(prompt).toContain('No prose, no markdown fences');
  });
});

describe('buildVibeUserPrompt', () => {
  test('renders namespace, stack, and description in the expected positions', () => {
    const prompt = buildVibeUserPrompt({
      namespace: 'acme:web.shop',
      stack: 'Bun + Hono',
      description: 'A multi-tenant store with catalog and cart.',
    });
    expect(prompt).toContain('Namespace prefix: acme:web.shop');
    expect(prompt).toContain('Stack: Bun + Hono');
    expect(prompt).toContain('multi-tenant store');
    expect(prompt).toContain('multi-document YAML');
  });
});

describe('stripCodeFences', () => {
  test('returns input unchanged when no outer fence is present', () => {
    expect(stripCodeFences('id: foo\nstratum: system\n')).toBe('id: foo\nstratum: system\n');
  });

  test('strips ```yaml … ``` outer fence', () => {
    const wrapped = '```yaml\nid: foo\nstratum: system\n```\n';
    expect(stripCodeFences(wrapped)).toBe('id: foo\nstratum: system');
  });

  test('strips plain ``` … ``` outer fence', () => {
    const wrapped = '```\nid: foo\n```';
    expect(stripCodeFences(wrapped)).toBe('id: foo');
  });

  test('tolerates leading/trailing whitespace', () => {
    const wrapped = '\n\n```yml\nid: foo\n```  \n';
    expect(stripCodeFences(wrapped)).toBe('id: foo');
  });

  test('leaves inner fences alone when wrapper is absent', () => {
    const text = 'preamble\n```code in body```\nrest';
    expect(stripCodeFences(text)).toBe(text);
  });
});
