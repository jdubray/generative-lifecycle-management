import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash } from '../../../src/domain/content-hash.ts';
import {
  nodeFilePath,
  parseNode,
  readNodeFile,
  safeGlmId,
  serializeNode,
  writeNodeFile,
  YamlStoreError,
} from '../../../src/git/yaml-store.ts';
import type { SekkeiNode } from '../../../src/types.ts';

function sampleNode(): SekkeiNode {
  const body = { boundary: 'browser DOM', runtime: 'es2022' };
  return {
    id: 'node-1',
    workspaceId: 'ws-1',
    glmId: 'glm:component.web',
    stratum: 'component',
    title: 'Web Component',
    description: 'browser side',
    body,
    contentHash: contentHash(body),
    revisionMajor: 'A',
    revisionIteration: 0,
    revisionStatus: 'in_work',
    overrideKind: 'net_new',
    derivesFromNodeId: null,
    systemRole: null,
    specKind: null,
    authoredBy: 'alice@example.com',
    authoredAt: '2026-05-11T00:00:00.000Z',
    updatedAt: '2026-05-11T00:00:00.000Z',
    generatorIdentity: null,
  };
}

describe('safeGlmId', () => {
  test('replaces colons with double underscore', () => {
    expect(safeGlmId('glm:component.web')).toBe('glm__component.web');
  });
});

describe('nodeFilePath', () => {
  test('lives under nodes/<stratum>/<safe>.yaml', () => {
    const p = nodeFilePath('/repo', 'component', 'glm:component.web');
    expect(p).toContain(join('nodes', 'component', 'glm__component.web.yaml'));
  });
});

describe('serializeNode + parseNode', () => {
  test('round-trips body and preserves the content_hash', () => {
    const node = sampleNode();
    const text = serializeNode(node);
    const parsed = parseNode(text);
    expect(parsed.id).toBe('glm:component.web');
    expect(parsed.content_hash).toBe(node.contentHash);
    expect(parsed.body).toEqual(node.body);
  });

  test('throws when content_hash on the node disagrees with the body', () => {
    const node = { ...sampleNode(), contentHash: 'sha256:wrong' };
    expect(() => serializeNode(node)).toThrow(YamlStoreError);
  });

  test('parseNode rejects a file whose body and hash disagree', () => {
    const text = `# x
id: glm:component.web
stratum: component
title: x
description: ''
revision:
  major: A
  iteration: 0
  status: in_work
override_kind: net_new
derives_from: null
system_role: null
spec_kind: null
authored_by: a@b
authored_at: 2026-05-11T00:00:00.000Z
body:
  boundary: changed
  runtime: es2022
content_hash: sha256:wrong
`;
    expect(() => parseNode(text)).toThrow(YamlStoreError);
  });
});

describe('writeNodeFile + readNodeFile', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('writes to the canonical path and reads back', () => {
    dir = mkdtempSync(join(tmpdir(), 'glm-yaml-'));
    const node = sampleNode();
    const path = writeNodeFile(dir, node);
    expect(path).toContain(join('nodes', 'component', 'glm__component.web.yaml'));
    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).toContain('id: glm:component.web');

    const read = readNodeFile(dir, 'component', 'glm:component.web');
    expect(read?.title).toBe('Web Component');
  });

  test('readNodeFile returns null for a missing file', () => {
    dir = mkdtempSync(join(tmpdir(), 'glm-yaml-'));
    expect(readNodeFile(dir, 'component', 'glm:absent')).toBeNull();
  });
});
