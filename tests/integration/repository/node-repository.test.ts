import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ContentHashMismatchError, contentHash } from '../../../src/domain/content-hash.ts';
import { NodeRepository, type NodeInput } from '../../../src/repository/node-repository.ts';
import { openTestDb, seedUser, seedWorkspace } from '../helpers.ts';

function sampleComponent(id = 'node-1', glmId = 'glm:component.web'): NodeInput {
  return {
    id,
    workspaceId: 'ws-1',
    glmId,
    stratum: 'component',
    title: 'Web Component',
    description: 'Browser-side rendering surface',
    body: { boundary: 'browser DOM', runtime: 'es2022' },
    revisionMajor: 'A',
    revisionIteration: 0,
    revisionStatus: 'in_work',
    overrideKind: 'net_new',
    authoredBy: 'alice@example.com',
  };
}

describe('NodeRepository', () => {
  let db: Database;
  let repo: NodeRepository;

  beforeEach(() => {
    db = openTestDb();
    seedUser(db);
    seedWorkspace(db);
    repo = new NodeRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test('insert + findById round-trip preserves content_hash', () => {
    const inserted = repo.insert(sampleComponent());
    expect(inserted.contentHash).toBe(contentHash(inserted.body));

    const fetched = repo.findById('node-1');
    expect(fetched).not.toBeNull();
    expect(fetched?.node.contentHash).toBe(inserted.contentHash);
    expect(fetched?.node.body).toEqual(inserted.body);
  });

  test('content_hash is canonical: key order does not affect the hash', () => {
    repo.insert(sampleComponent());
    const got = repo.findById('node-1');
    const expected = contentHash({ runtime: 'es2022', boundary: 'browser DOM' });
    expect(got?.node.contentHash).toBe(expected);
  });

  test('findByGlmId resolves a node by (workspace_id, glm_id)', () => {
    repo.insert(sampleComponent('node-1', 'glm:component.web'));
    const fetched = repo.findByGlmId('ws-1', 'glm:component.web');
    expect(fetched?.node.id).toBe('node-1');
  });

  test('listByWorkspaceStratum filters correctly', () => {
    repo.insert(sampleComponent('n-c', 'glm:component.web'));
    repo.insert({
      ...sampleComponent('n-cap', 'glm:capability.checkout'),
      stratum: 'capability',
      title: 'Checkout',
      body: { user_value: 'allow customers to pay' },
    });
    const components = repo.listByWorkspaceStratum('ws-1', 'component');
    const caps = repo.listByWorkspaceStratum('ws-1', 'capability');
    expect(components.length).toBe(1);
    expect(components[0]?.node.id).toBe('n-c');
    expect(caps.length).toBe(1);
    expect(caps[0]?.node.id).toBe('n-cap');
  });

  test('update replaces the body and bumps the hash and updated_at', () => {
    const original = repo.insert(sampleComponent());
    const updated = repo.update({
      ...sampleComponent(),
      body: { boundary: 'browser DOM', runtime: 'es2024' },
    });
    expect(updated.contentHash).not.toBe(original.contentHash);
    expect(updated.updatedAt >= original.updatedAt).toBe(true);

    const fetched = repo.findById('node-1');
    expect(fetched?.node.contentHash).toBe(updated.contentHash);
  });

  test('parameters / constraints / relationships round-trip', () => {
    repo.insert({
      ...sampleComponent('n-2', 'glm:component.api'),
      parameters: [
        {
          name: 'maxItems',
          type: 'integer',
          options: null,
          minValue: 1,
          maxValue: 100,
          defaultValue: 10,
          bindingScope: 'workspace',
          ord: 0,
        },
      ],
      constraints: [
        {
          ord: 0,
          kind: 'invariant',
          expression: 'maxItems > 0',
          severity: 'error',
        },
      ],
      relationships: [
        {
          ord: 0,
          kind: 'composes-of',
          targetGlmId: 'glm:capability.checkout',
          attributes: { weight: 1 },
        },
      ],
    });
    const fetched = repo.findById('n-2');
    expect(fetched?.parameters.length).toBe(1);
    expect(fetched?.parameters[0]?.defaultValue).toBe(10);
    expect(fetched?.constraints[0]?.expression).toBe('maxItems > 0');
    expect(fetched?.relationships[0]?.attributes).toEqual({ weight: 1 });
  });

  test('UNIQUE (workspace_id, glm_id) is enforced', () => {
    repo.insert(sampleComponent());
    expect(() =>
      repo.insert({ ...sampleComponent('node-other', 'glm:component.web') }),
    ).toThrow();
  });

  test('FK to workspaces is enforced', () => {
    expect(() =>
      repo.insert({ ...sampleComponent(), workspaceId: 'ws-does-not-exist' }),
    ).toThrow();
  });

  test('content_hash mismatch on read raises ContentHashMismatchError', () => {
    repo.insert(sampleComponent());
    // Tamper with the body directly via SQL, bypassing the repository.
    db.prepare('UPDATE nodes SET body_json = ? WHERE id = ?').run(
      '{"boundary":"hacked","runtime":"es2022"}',
      'node-1',
    );
    expect(() => repo.findById('node-1')).toThrow(ContentHashMismatchError);
  });

  test('delete removes the node and cascades to children', () => {
    repo.insert({
      ...sampleComponent(),
      parameters: [
        {
          name: 'p',
          type: 'string',
          options: null,
          minValue: null,
          maxValue: null,
          defaultValue: 'x',
          bindingScope: 'workspace',
          ord: 0,
        },
      ],
    });
    expect(repo.delete('node-1')).toBe(true);
    expect(repo.findById('node-1')).toBeNull();
    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM node_parameters WHERE node_id = ?')
      .get('node-1') as { n: number };
    expect(remaining.n).toBe(0);
  });

  test('node_relationships cascade-deletes on parent delete', () => {
    repo.insert({
      ...sampleComponent('n-3', 'glm:component.x'),
      relationships: [
        {
          ord: 0,
          kind: 'depends-on',
          targetGlmId: 'glm:component.y',
          attributes: null,
        },
      ],
    });
    repo.delete('n-3');
    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM node_relationships WHERE source_node_id = ?')
      .get('n-3') as { n: number };
    expect(remaining.n).toBe(0);
  });
});
