import { describe, expect, test } from 'bun:test';
import {
  buildVibeSystemPrompt,
  buildVibeUserPrompt,
  buildReverseEngineerSystemPrompt,
  buildReverseEngineerUserPrompt,
  buildRefineSystemPrompt,
  buildRefineUserPrompt,
  parseJsonPatchResponse,
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

  test('tells Claude it is in one-shot mode (no follow-up questions)', () => {
    const prompt = buildVibeSystemPrompt({ authoringSkill: 'x' });
    expect(prompt).toContain('OPERATING MODE: one-shot generation');
    expect(prompt).toContain('do not ask follow-up questions');
    // The skill's §1 elicitation steps must be explicitly waived.
    expect(prompt).toContain('§1 elicitation steps DO NOT APPLY');
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

describe('buildReverseEngineerSystemPrompt', () => {
  test('embeds the skill and includes the reverse-engineering rules', () => {
    const prompt = buildReverseEngineerSystemPrompt({
      authoringSkill: '# Skill: Sekkei Authoring\n... §10 ...',
    });
    expect(prompt).toContain('reverse-engineering an existing codebase');
    expect(prompt).toContain('§10.1 through §10.7');
    expect(prompt).toContain('Read FSM states VERBATIM');
    expect(prompt).toContain('override_kind: net_new');
    expect(prompt).toContain('# Skill: Sekkei Authoring');
    // Same one-shot framing as the UC-01 vibe prompt:
    expect(prompt).toContain('OPERATING MODE: one-shot generation');
    expect(prompt).toContain('§1 elicitation steps DO NOT APPLY');
  });

  test('appends the JSON schema when provided', () => {
    const without = buildReverseEngineerSystemPrompt({ authoringSkill: 'x' });
    expect(without).not.toContain('SEKKEI JSON SCHEMA');
    const withSchema = buildReverseEngineerSystemPrompt({
      authoringSkill: 'x',
      schemaJson: '{"type":"object"}',
    });
    expect(withSchema).toContain('SEKKEI JSON SCHEMA');
  });
});

describe('buildReverseEngineerUserPrompt', () => {
  test('renders namespace, rootDir, tree, and excerpt blocks', () => {
    const prompt = buildReverseEngineerUserPrompt({
      namespace: 'acme:legacy.app',
      rootDir: '/home/dev/legacy-app',
      fileTree: '# /home/dev/legacy-app\nREADME.md\nsrc/index.ts',
      excerpts: [
        { path: 'README.md', content: '# Legacy App', truncated: false, totalLines: 1 },
        { path: 'src/index.ts', content: 'export const main = () => {};', truncated: false, totalLines: 1 },
      ],
    });
    expect(prompt).toContain('Reverse-engineer a sekkei');
    expect(prompt).toContain('Namespace prefix: acme:legacy.app');
    expect(prompt).toContain('/home/dev/legacy-app');
    expect(prompt).toContain('CODEBASE STRUCTURE:');
    expect(prompt).toContain('=== README.md ===');
    expect(prompt).toContain('# Legacy App');
    expect(prompt).toContain('=== src/index.ts ===');
    expect(prompt).toContain('export const main');
  });

  test('marks truncated excerpts with line-range annotation', () => {
    const prompt = buildReverseEngineerUserPrompt({
      namespace: 'a:b',
      rootDir: '/tmp',
      fileTree: '# /tmp\nfile.ts',
      excerpts: [
        { path: 'file.ts', content: 'line1\nline2', truncated: true, totalLines: 999 },
      ],
    });
    expect(prompt).toContain('(truncated; first 2 of 999 lines)');
  });

  test('optional hint is included when provided', () => {
    const prompt = buildReverseEngineerUserPrompt({
      namespace: 'a:b',
      rootDir: '/tmp',
      fileTree: '# /tmp\n',
      excerpts: [],
      hint: 'Focus on the auth subsystem.',
    });
    expect(prompt).toContain('Author hint:');
    expect(prompt).toContain('Focus on the auth subsystem.');
  });
});

describe('buildRefineSystemPrompt', () => {
  test('frames the task as JSON-Patch and lists allowed ops', () => {
    const prompt = buildRefineSystemPrompt({ authoringSkill: '# skill stub' });
    expect(prompt).toContain('JSON-Patch operations');
    expect(prompt).toContain('SUPPORTED OPS: add, remove, replace, move');
    expect(prompt).toContain('# skill stub');
    expect(prompt).toContain('Output ONLY a JSON array');
    // Envelope fields are off-limits:
    expect(prompt).toContain('id, stratum, revision');
  });
});

describe('buildRefineUserPrompt', () => {
  test('embeds glmId, stratum, the node body, and instruction', () => {
    const prompt = buildRefineUserPrompt({
      glmId: 'acme:x.foo',
      stratum: 'component',
      nodeYaml: 'id: acme:x.foo\nbody:\n{ "behaviors": [] }',
      instruction: 'add a search behavior',
    });
    expect(prompt).toContain("Refine the body of node 'acme:x.foo'");
    expect(prompt).toContain('stratum: component');
    expect(prompt).toContain('Refinement instruction:');
    expect(prompt).toContain('add a search behavior');
    expect(prompt).toContain('Output ONLY a JSON array');
  });

  test('includes ancestor summary when provided', () => {
    const prompt = buildRefineUserPrompt({
      glmId: 'a:b',
      stratum: 'component',
      nodeYaml: 'body: {}',
      ancestorSummary: 'system: acme shop\ncapability: catalog',
      instruction: 'x',
    });
    expect(prompt).toContain('Ancestor context:');
    expect(prompt).toContain('system: acme shop');
  });
});

describe('parseJsonPatchResponse', () => {
  test('parses a bare JSON array', () => {
    const r = parseJsonPatchResponse('[{"op":"add","path":"/a","value":1}]');
    expect(r).toEqual([{ op: 'add', path: '/a', value: 1 }]);
  });

  test('unwraps {"patch": [...]}', () => {
    const r = parseJsonPatchResponse('{"patch": [{"op":"add","path":"/a","value":1}]}');
    expect(r).toEqual([{ op: 'add', path: '/a', value: 1 }]);
  });

  test('strips an outer ```json fence', () => {
    const r = parseJsonPatchResponse('```json\n[{"op":"remove","path":"/x"}]\n```');
    expect(r).toEqual([{ op: 'remove', path: '/x' }]);
  });

  test('throws on prose', () => {
    expect(() => parseJsonPatchResponse('here you go: prose')).toThrow();
  });

  test('throws on a non-array, non-{patch:[]} object', () => {
    expect(() => parseJsonPatchResponse('{"foo": 1}')).toThrow();
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
