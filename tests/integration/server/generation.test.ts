import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateSecret } from '../../../src/auth/session.ts';
import { HmacSigner, verifyDsseEnvelope } from '../../../src/generation/attestation.ts';
import { InMemoryGenerationCache } from '../../../src/generation/cache.ts';
import { FakeLlmClient } from '../../../src/generation/llm-client.ts';
import { runMigrations } from '../../../src/repository/db.ts';
import { createApp } from '../../../src/server/app.ts';
import { MIGRATIONS_DIR } from '../helpers.ts';

interface Server {
  app: ReturnType<typeof createApp>['app'];
  db: Database;
  signer: HmacSigner;
  request(method: string, path: string, body?: unknown): Promise<Response>;
}

function makeServer(): Server {
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

  const signer = new HmacSigner({ keyId: 'test-key', keyHex: 'a'.repeat(64) });
  const { app } = createApp({
    db,
    sessionSecret: generateSecret(),
    cookieSecure: false,
    allowTestAuthHeader: true,
    llm: new FakeLlmClient([
      { text: 'first artifact' },
      { text: 'second artifact' },
    ]),
    generationCache: new InMemoryGenerationCache(),
    attestationSigner: signer,
  });

  const request = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const headers: Record<string, string> = { 'x-test-user-id': 'user-1' };
    let bodyStr: string | undefined;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      bodyStr = JSON.stringify(body);
    }
    return app.request(path, { method, headers, body: bodyStr });
  };

  return { app, db, signer, request };
}

const SEKKEI = { rootId: 'glm:system.web', revision: 'A.0', lockDigest: 'sha256:lock' };
const GENERATOR = { llm: 'claude-sonnet-4-6', promptVersion: 'sha256:pv', toolChain: 'sha256:tc' };

describe('POST /generate', () => {
  let s: Server;
  beforeEach(() => {
    s = makeServer();
  });
  afterEach(() => s.db.close());

  test('cache miss → 201 with provenance + cache=miss', async () => {
    const res = await s.request('POST', '/api/v1/workspaces/ws-1/generate', {
      subjectFile: 'src/x.ts',
      prompt: 'emit',
      sekkei: SEKKEI,
      binding: {},
      closureHash: 'sha256:closure',
      generatorIdentity: GENERATOR,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { cache: string; provenance: { id: string } };
    expect(body.cache).toBe('miss');
    expect(body.provenance.id).toBeTruthy();
  });

  test('second call with identical inputs is a cache hit', async () => {
    const payload = {
      subjectFile: 'src/x.ts',
      prompt: 'emit',
      sekkei: SEKKEI,
      binding: {},
      closureHash: 'sha256:closure',
      generatorIdentity: GENERATOR,
    };
    const first = await s.request('POST', '/api/v1/workspaces/ws-1/generate', payload);
    const second = await s.request('POST', '/api/v1/workspaces/ws-1/generate', payload);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const b = (await second.json()) as { cache: string; provenance: { tokensIn: number; tokensOut: number } };
    expect(b.cache).toBe('hit');
    expect(b.provenance.tokensIn).toBe(0);
    expect(b.provenance.tokensOut).toBe(0);
  });

  test('missing required field returns 400', async () => {
    const res = await s.request('POST', '/api/v1/workspaces/ws-1/generate', {
      prompt: 'emit',
      sekkei: SEKKEI,
      binding: {},
      closureHash: 'sha256:c',
      generatorIdentity: GENERATOR,
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /provenance/:event_id', () => {
  let s: Server;
  beforeEach(() => {
    s = makeServer();
  });
  afterEach(() => s.db.close());

  test('returns the event + its attestation + rekor URL (AC-36)', async () => {
    const create = await s.request('POST', '/api/v1/workspaces/ws-1/generate', {
      subjectFile: 'src/x.ts',
      prompt: 'emit',
      sekkei: SEKKEI,
      binding: {},
      closureHash: 'sha256:c',
      generatorIdentity: GENERATOR,
    });
    const { provenance } = (await create.json()) as { provenance: { id: string } };

    const res = await s.request('GET', `/api/v1/workspaces/ws-1/provenance/${provenance.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      event: { cache: string };
      attestation: {
        statement: { _type: string };
        envelope: { signatures: Array<{ keyid: string }> };
        rekorUrl: string;
      };
    };
    expect(body.event.cache).toBe('miss');
    expect(body.attestation.statement._type).toBe('https://in-toto.io/Statement/v1');
    expect(body.attestation.rekorUrl.startsWith('https://rekor.sigstore.dev/index/')).toBe(true);
  });
});

describe('POST /provenance/export and /verify (AC-34, AC-35)', () => {
  let s: Server;
  beforeEach(() => {
    s = makeServer();
  });
  afterEach(() => s.db.close());

  test('export returns newline-delimited DSSE envelopes', async () => {
    await s.request('POST', '/api/v1/workspaces/ws-1/generate', {
      subjectFile: 'src/x.ts',
      prompt: 'a',
      sekkei: SEKKEI,
      binding: { v: 1 },
      closureHash: 'sha256:c1',
      generatorIdentity: GENERATOR,
    });
    await s.request('POST', '/api/v1/workspaces/ws-1/generate', {
      subjectFile: 'src/y.ts',
      prompt: 'b',
      sekkei: SEKKEI,
      binding: { v: 2 },
      closureHash: 'sha256:c2',
      generatorIdentity: GENERATOR,
    });

    const res = await s.request('POST', '/api/v1/workspaces/ws-1/provenance/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.in-toto+json');
    const text = await res.text();
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const env = JSON.parse(line) as { payloadType: string; signatures: unknown[] };
      expect(env.payloadType).toBe('application/vnd.in-toto+json');
      expect(env.signatures.length).toBe(1);
      // Server-side verification round-trip
      expect(verifyDsseEnvelope(JSON.parse(line), s.signer).passed).toBe(true);
    }
  });

  test('verify endpoint reports total/passed/failed', async () => {
    await s.request('POST', '/api/v1/workspaces/ws-1/generate', {
      subjectFile: 'src/x.ts',
      prompt: 'a',
      sekkei: SEKKEI,
      binding: {},
      closureHash: 'sha256:c',
      generatorIdentity: GENERATOR,
    });
    const res = await s.request('POST', '/api/v1/workspaces/ws-1/provenance/verify');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; passed: number; failed: number };
    expect(body.total).toBe(1);
    expect(body.passed).toBe(1);
    expect(body.failed).toBe(0);
  });
});
