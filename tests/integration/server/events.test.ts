import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { WorkspaceEvent } from '../../../src/ws/event-bus.ts';
import { makeTestServer, type TestServer } from './helpers.ts';

describe('event bus integration', () => {
  let s: TestServer;
  beforeEach(() => {
    s = makeTestServer();
  });
  afterEach(() => s.db.close());

  test('creating a node publishes node.changed', async () => {
    const received: WorkspaceEvent[] = [];
    s.deps.events.subscribe('ws-1', (e) => received.push(e));

    await s.request('POST', '/api/v1/workspaces/ws-1/nodes', {
      body: {
        glmId: 'glm:component.x',
        stratum: 'component',
        title: 'X',
        body: { boundary: 'b', runtime: 'r' },
        revisionMajor: 'A',
        revisionIteration: 0,
        revisionStatus: 'in_work',
        overrideKind: 'net_new',
      },
    });

    expect(received.length).toBeGreaterThan(0);
    expect(received[0]?.type).toBe('node.changed');
  });

  test('SCR submission publishes scr.status_changed', async () => {
    const received: WorkspaceEvent[] = [];
    s.deps.events.subscribe('ws-1', (e) => received.push(e));

    await s.request('POST', '/api/v1/workspaces/ws-1/scrs', {
      body: { id: 'SCR-9', title: 't', scrClass: 'I', problem: 'p', diffYaml: [], targetNodes: [] },
    });
    await s.request('PUT', '/api/v1/workspaces/ws-1/scrs/SCR-9/status', { body: { event: 'submit' } });

    const types = received.map((e) => e.type);
    expect(types).toContain('scr.created');
    expect(types).toContain('scr.status_changed');
  });

  test('subscribers from a different workspace are not notified', async () => {
    const wsBReceived: WorkspaceEvent[] = [];
    s.deps.events.subscribe('ws-other', (e) => wsBReceived.push(e));

    await s.request('POST', '/api/v1/workspaces/ws-1/nodes', {
      body: {
        glmId: 'glm:component.x',
        stratum: 'component',
        title: 'X',
        body: { boundary: 'b', runtime: 'r' },
        revisionMajor: 'A',
        revisionIteration: 0,
        revisionStatus: 'in_work',
        overrideKind: 'net_new',
      },
    });
    expect(wsBReceived.length).toBe(0);
  });
});
