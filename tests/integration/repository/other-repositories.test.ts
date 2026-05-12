import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { AuditRepository } from '../../../src/repository/audit-repository.ts';
import { ChangeLogRepository } from '../../../src/repository/change-log-repository.ts';
import { DriftRepository } from '../../../src/repository/drift-repository.ts';
import { NodeRepository } from '../../../src/repository/node-repository.ts';
import { ProvenanceRepository } from '../../../src/repository/provenance-repository.ts';
import { ScrRepository } from '../../../src/repository/scr-repository.ts';
import { VariantRepository } from '../../../src/repository/variant-repository.ts';
import { openTestDb, seedUser, seedWorkspace } from '../helpers.ts';

function bootstrap(db: Database) {
  seedUser(db);
  seedWorkspace(db);
  new NodeRepository(db).insert({
    id: 'node-1',
    workspaceId: 'ws-1',
    glmId: 'glm:component.web',
    stratum: 'component',
    title: 'Web Component',
    body: { boundary: 'browser DOM', runtime: 'es2022' },
    revisionMajor: 'A',
    revisionIteration: 0,
    revisionStatus: 'in_work',
    overrideKind: 'net_new',
    authoredBy: 'alice@example.com',
  });
}

describe('ChangeLogRepository', () => {
  let db: Database;
  beforeEach(() => {
    db = openTestDb();
    bootstrap(db);
  });
  afterEach(() => db.close());

  test('append then listLatest returns inserted entry', () => {
    const repo = new ChangeLogRepository(db);
    const entry = repo.append({
      workspaceId: 'ws-1',
      nodeId: 'node-1',
      userId: 'user-1',
      op: 'create',
      afterContentHash: 'sha256:abc',
    });
    expect(entry.id).toBeGreaterThan(0);
    const latest = repo.listLatest('ws-1', 10);
    expect(latest[0]?.id).toBe(entry.id);
    expect(latest[0]?.op).toBe('create');
  });

  test('listSince returns only entries after a cursor', async () => {
    const repo = new ChangeLogRepository(db);
    const t1 = '2026-01-01T00:00:00.000Z';
    const t2 = '2026-01-02T00:00:00.000Z';
    repo.append({ workspaceId: 'ws-1', nodeId: null, userId: 'user-1', op: 'create', ts: t1 });
    repo.append({ workspaceId: 'ws-1', nodeId: null, userId: 'user-1', op: 'update', ts: t2 });
    const after = repo.listSince('ws-1', t1);
    expect(after.length).toBe(1);
    expect(after[0]?.ts).toBe(t2);
  });
});

describe('AuditRepository', () => {
  let db: Database;
  beforeEach(() => {
    db = openTestDb();
    bootstrap(db);
  });
  afterEach(() => db.close());

  test('append then list returns payload JSON intact', () => {
    const repo = new AuditRepository(db);
    repo.append({
      id: 'aud-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      eventType: 'scr.approved',
      payload: { scrId: 'SCR-1', nested: { ok: true } },
    });
    const events = repo.list('ws-1');
    expect(events.length).toBe(1);
    expect(events[0]?.payload).toEqual({ scrId: 'SCR-1', nested: { ok: true } });
  });

  test('listByType filters by event_type', () => {
    const repo = new AuditRepository(db);
    repo.append({
      id: 'a-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      eventType: 'scr.created',
      payload: {},
    });
    repo.append({
      id: 'a-2',
      workspaceId: 'ws-1',
      userId: 'user-1',
      eventType: 'scr.approved',
      payload: {},
    });
    expect(repo.listByType('ws-1', 'scr.approved').length).toBe(1);
  });
});

describe('ScrRepository', () => {
  let db: Database;
  beforeEach(() => {
    db = openTestDb();
    bootstrap(db);
  });
  afterEach(() => db.close());

  test('insert + findById round-trips diff_yaml/target_nodes/impact', () => {
    const repo = new ScrRepository(db);
    repo.insert({
      id: 'SCR-1',
      workspaceId: 'ws-1',
      title: 'Allow guest checkout',
      scrClass: 'I',
      status: 'Draft',
      proposer: 'alice@example.com',
      problem: 'Customers abandon at signup',
      diffYaml: [{ line: '+   guest: true', kind: 'add' }],
      targetNodes: ['glm:capability.checkout'],
      impact: { variantsAffected: 2, tokensEst: 5000, cacheMissCount: 1 },
    });
    const scr = repo.findById('SCR-1');
    expect(scr?.diffYaml[0]?.kind).toBe('add');
    expect(scr?.targetNodes).toEqual(['glm:capability.checkout']);
    expect(scr?.impact?.variantsAffected).toBe(2);
  });

  test('setStatus persists status and return_reason', () => {
    const repo = new ScrRepository(db);
    repo.insert({
      id: 'SCR-2',
      workspaceId: 'ws-1',
      title: 't',
      scrClass: 'II',
      status: 'Draft',
      proposer: 'alice@example.com',
      problem: 'p',
      diffYaml: [],
      targetNodes: [],
    });
    repo.setStatus('SCR-2', 'Returned', 'needs more detail');
    const scr = repo.findById('SCR-2');
    expect(scr?.status).toBe('Returned');
    expect(scr?.returnReason).toBe('needs more detail');
  });

  test('approvals upsert merges by (scr_id, who)', () => {
    const repo = new ScrRepository(db);
    repo.insert({
      id: 'SCR-3',
      workspaceId: 'ws-1',
      title: 't',
      scrClass: 'I',
      status: 'Under Review',
      proposer: 'alice@example.com',
      problem: 'p',
      diffYaml: [],
      targetNodes: [],
    });
    repo.upsertApproval({ scrId: 'SCR-3', who: 'bob@example.com', decision: 'pending' });
    repo.upsertApproval({
      scrId: 'SCR-3',
      who: 'bob@example.com',
      decision: 'approve',
      decidedAt: '2026-05-11T10:00:00.000Z',
    });
    const all = repo.listApprovals('SCR-3');
    expect(all.length).toBe(1);
    expect(all[0]?.decision).toBe('approve');
  });
});

describe('VariantRepository', () => {
  let db: Database;
  beforeEach(() => {
    db = openTestDb();
    bootstrap(db);
  });
  afterEach(() => db.close());

  test('rollout upsert replaces existing pair', () => {
    const repo = new VariantRepository(db);
    repo.insertVariant({
      id: 'v-1',
      workspaceId: 'ws-1',
      label: 'web/todomvc/team',
      channel: 'stable',
      pinPolicyDefault: 'pin-on-release',
    });
    repo.upsertRollout({
      variantId: 'v-1',
      nodeId: 'node-1',
      availableRev: 'A.0',
      state: 'Available-on-Channel',
    });
    repo.upsertRollout({
      variantId: 'v-1',
      nodeId: 'node-1',
      availableRev: 'A.1',
      pinRev: 'A.1',
      state: 'Pinned-by-Variant',
    });
    const rollouts = repo.listRollout('v-1');
    expect(rollouts.length).toBe(1);
    expect(rollouts[0]?.state).toBe('Pinned-by-Variant');
    expect(rollouts[0]?.pinRev).toBe('A.1');
  });

  test('deleting a variant cascades to its rollout rows', () => {
    const repo = new VariantRepository(db);
    repo.insertVariant({
      id: 'v-2',
      workspaceId: 'ws-1',
      label: 'edge',
      channel: 'canary',
      pinPolicyDefault: 'track-latest',
    });
    repo.upsertRollout({
      variantId: 'v-2',
      nodeId: 'node-1',
      state: 'Available-on-Channel',
    });
    db.prepare('DELETE FROM variants WHERE id = ?').run('v-2');
    expect(repo.listRollout('v-2').length).toBe(0);
  });
});

describe('DriftRepository', () => {
  let db: Database;
  beforeEach(() => {
    db = openTestDb();
    bootstrap(db);
  });
  afterEach(() => db.close());

  test('upsert + listByStatus + listByNode', () => {
    const repo = new DriftRepository(db);
    repo.upsert({
      id: 'd-1',
      workspaceId: 'ws-1',
      nodeId: 'node-1',
      file: 'src/index.ts',
      status: 'Hash-Drifted',
      kind: 'hash',
      desiredHash: 'sha256:aaa',
      observedHash: 'sha256:bbb',
      policy: 'alert',
    });
    expect(repo.listByStatus('ws-1', 'Hash-Drifted').length).toBe(1);
    expect(repo.listByNode('node-1').length).toBe(1);

    repo.upsert({
      id: 'd-1',
      workspaceId: 'ws-1',
      nodeId: 'node-1',
      file: 'src/index.ts',
      status: 'Synced',
      kind: 'none',
      policy: 'alert',
    });
    expect(repo.listByStatus('ws-1', 'Hash-Drifted').length).toBe(0);
    expect(repo.listByStatus('ws-1', 'Synced').length).toBe(1);
  });
});

describe('ProvenanceRepository', () => {
  let db: Database;
  beforeEach(() => {
    db = openTestDb();
    bootstrap(db);
  });
  afterEach(() => db.close());

  test('insert + listBySubject preserves booleans and counters', () => {
    const repo = new ProvenanceRepository(db);
    const e = repo.insert({
      id: 'prov-1',
      workspaceId: 'ws-1',
      subjectFile: 'src/index.ts',
      subjectDigest: 'sha256:abc',
      sekkeiRoot: 'glm:system.web',
      sekkeiRev: 'A.0',
      sekkeiLock: 'sha256:lock',
      bindingHash: 'sha256:bind',
      generatorLlm: 'claude-sonnet-4-6',
      generatorPromptVersion: 'sha256:prompt',
      tokensIn: 1200,
      tokensOut: 800,
      durationMs: 1500,
      cache: 'miss',
      signed: true,
    });
    expect(e.signed).toBe(true);
    const fetched = repo.findById('prov-1');
    expect(fetched?.signed).toBe(true);
    expect(fetched?.tokensIn).toBe(1200);
    const list = repo.listBySubject('ws-1', 'src/index.ts');
    expect(list.length).toBe(1);
  });

  test('cache hits with zero token counts are valid', () => {
    const repo = new ProvenanceRepository(db);
    repo.insert({
      id: 'prov-2',
      workspaceId: 'ws-1',
      subjectFile: 'src/x.ts',
      subjectDigest: 'sha256:abc',
      sekkeiRoot: 'glm:system.web',
      sekkeiRev: 'A.0',
      sekkeiLock: 'sha256:lock',
      bindingHash: 'sha256:bind',
      generatorLlm: 'claude-sonnet-4-6',
      generatorPromptVersion: 'sha256:prompt',
      cache: 'hit',
      signed: false,
    });
    const fetched = repo.findById('prov-2');
    expect(fetched?.tokensIn).toBe(0);
    expect(fetched?.tokensOut).toBe(0);
    expect(fetched?.cache).toBe('hit');
  });
});
