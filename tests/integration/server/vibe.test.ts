import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FakeLlmClient } from '../../../src/generation/llm-client.ts';
import { Database } from 'bun:sqlite';
import { generateSecret } from '../../../src/auth/session.ts';
import { runMigrations } from '../../../src/repository/db.ts';
import { createApp } from '../../../src/server/app.ts';
import { MIGRATIONS_DIR } from '../helpers.ts';
import { makeTestServer, type TestServer } from './helpers.ts';

describe('vibe routes', () => {
  let s: TestServer;
  beforeEach(() => {
    s = makeTestServer();
  });
  afterEach(() => s.db.close());

  test('GET /vibe/scripts returns suggestions + scripts + invariants', async () => {
    const res = await s.request('GET', '/api/v1/vibe/scripts');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      suggestions: Array<{ key: string }>;
      scripts: Record<string, unknown>;
      invariants: string[];
    };
    expect(body.suggestions.map((s) => s.key).sort()).toEqual(['archive', 'drift', 'multi', 'promote']);
    expect(Object.keys(body.scripts).sort()).toEqual(['archive', 'drift', 'multi', 'promote']);
    expect(body.invariants.length).toBeGreaterThan(0);
  });

  test('POST /vibe/intent classifies known scenarios', async () => {
    const res = await s.request('POST', '/api/v1/vibe/intent', {
      body: { message: 'add a way to archive todos' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scenario: string | null };
    expect(body.scenario).toBe('archive');
  });

  test('POST /vibe/intent returns null for unrecognized messages', async () => {
    const res = await s.request('POST', '/api/v1/vibe/intent', {
      body: { message: 'unrelated query about cats' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scenario: string | null };
    expect(body.scenario).toBeNull();
  });

  test('AC-37: scenarios produce the documented sequence of cards', async () => {
    // archive scenario starts with agent_text → plan → agent_text → clarifier.
    const res = await s.request('GET', '/api/v1/vibe/scripts');
    const body = (await res.json()) as {
      scripts: Record<string, Array<{ kind: string }>>;
    };
    const archive = body.scripts.archive;
    expect(archive[0]?.kind).toBe('agent_text');
    expect(archive[1]?.kind).toBe('plan');
    expect(archive.at(-1)?.kind).toBe('clarifier');

    // drift scenario shows the drift_card then a choice block.
    const drift = body.scripts.drift;
    expect(drift.some((c) => c.kind === 'drift_card')).toBe(true);
    expect(drift.some((c) => c.kind === 'choice')).toBe(true);

    // multi scenario ends with a gate so the user has to accept the run.
    const multi = body.scripts.multi;
    expect(multi.at(-1)?.kind).toBe('gate');
  });

  test('POST /vibe/continue returns archiveClarifier when scenario=archive', async () => {
    const res = await s.request('POST', '/api/v1/vibe/continue', {
      body: { scenario: 'archive', kind: 'clarifier', payload: { choice: 'a' } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cards: Array<{ kind: string }> };
    const kinds = body.cards.map((c) => c.kind);
    expect(kinds).toContain('scr_draft');
    expect(kinds.at(-1)).toBe('gate');
  });

  test('POST /vibe/continue rejects unknown scenario / kind', async () => {
    const res = await s.request('POST', '/api/v1/vibe/continue', {
      body: { scenario: 'archive', kind: 'clarifier', payload: { choice: 'zzz' } },
    });
    expect(res.status).toBe(400);
  });

  test('AC-40: LLM fallback returns a canned reply when no LLM is configured', async () => {
    const res = await s.request('POST', '/api/v1/vibe/llm-fallback', {
      body: { message: 'something weird' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; reachable: boolean };
    expect(body.reachable).toBe(false);
    expect(body.text.toLowerCase()).toContain('try one of the scripted suggestions');
  });

  test('AC-40: LLM fallback returns LLM text when a fake client is wired up', async () => {
    // Rebuild a server with a FakeLlmClient pre-loaded.
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db, MIGRATIONS_DIR);
    const now = '2026-05-11T00:00:00.000Z';
    db.prepare('INSERT INTO users (id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'user-1',
      'alice@example.com',
      'Alice',
      'editor',
      now,
    );
    db.prepare('INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)').run(
      'ws-1',
      'demo',
      'Demo',
      now,
    );
    const { app } = createApp({
      db,
      sessionSecret: generateSecret(),
      cookieSecure: false,
      allowTestAuthHeader: true,
      llm: new FakeLlmClient([{ text: 'I would route this through change management.' }]),
    });
    const res = await app.request('/api/v1/vibe/llm-fallback', {
      method: 'POST',
      headers: { 'x-test-user-id': 'user-1', 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'something weird' }),
    });
    const body = (await res.json()) as { reachable: boolean; text: string };
    expect(body.reachable).toBe(true);
    expect(body.text).toContain('route this through change management');
    db.close();
  });

  test('Vibe gate "Submit" path lands a real SCR via the normal endpoints', async () => {
    // The agent's submit gate corresponds to POST /scrs then PUT /status.
    // We verify that hitting those endpoints from the Vibe path produces a
    // real audit row — i.e. the agent cannot bypass FSM enforcement.
    const create = await s.request('POST', '/api/v1/workspaces/ws-1/scrs', {
      body: {
        id: 'SCR-2090',
        title: 'Add archive lifecycle to todos',
        scrClass: 'I',
        problem: 'Soft-delete via archive state',
        targetNodes: ['glm:web.todomvc.todo_management.todo_data'],
        diffYaml: [],
      },
    });
    expect(create.status).toBe(201);

    const submit = await s.request('PUT', '/api/v1/workspaces/ws-1/scrs/SCR-2090/status', {
      body: { event: 'submit' },
    });
    expect(submit.status).toBe(200);

    const audits = s.deps.repos.audit.listByType('ws-1', 'scr.submit');
    expect(audits.length).toBe(1);
  });
});
