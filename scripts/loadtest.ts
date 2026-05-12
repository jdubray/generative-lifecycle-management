#!/usr/bin/env bun
/**
 * Lightweight load test for the spec §8.2 scalability target.
 *
 *   bun run scripts/loadtest.ts \
 *     --url=http://localhost:3000 \
 *     --workspace=ws-1 --node=glm:component.web \
 *     --editors=50 --duration=30
 *
 * Each simulated editor:
 *   - logs in (or uses x-test-user-id when allowed) as a unique user
 *   - tries to acquire the lock on `--node`; loses → counts as soft-lock-busy
 *   - heartbeats every 10 s while held
 *   - releases after a random hold time (5–15 s)
 *
 * Prints a one-line JSON summary so CI can record p50/p95 latency + the lock
 * outcome distribution.
 */

interface Args {
  url: string;
  workspace: string;
  node: string;
  editors: number;
  durationSec: number;
  testHeader: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    url: 'http://localhost:3000',
    workspace: 'ws-1',
    node: '',
    editors: 50,
    durationSec: 30,
    testHeader: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--url=')) args.url = arg.slice('--url='.length);
    else if (arg.startsWith('--workspace=')) args.workspace = arg.slice('--workspace='.length);
    else if (arg.startsWith('--node=')) args.node = arg.slice('--node='.length);
    else if (arg.startsWith('--editors=')) args.editors = Number(arg.slice('--editors='.length));
    else if (arg.startsWith('--duration=')) args.durationSec = Number(arg.slice('--duration='.length));
    else if (arg === '--no-test-header') args.testHeader = false;
  }
  if (!args.node) {
    console.error('--node=<glm_id> is required');
    process.exit(2);
  }
  return args;
}

interface Metrics {
  acquired: number;
  busy: number;
  errors: number;
  latencyMs: number[];
}

async function simulateEditor(args: Args, userId: string, metrics: Metrics, deadline: number) {
  // Exponential backoff on consecutive failures so a 50-editor swarm against
  // a downed server doesn't keep slamming it at ~250 req/s.
  let consecutiveErrors = 0;
  const backoffMs = () =>
    Math.min(30_000, 200 * 2 ** consecutiveErrors) * (0.5 + Math.random() * 0.5);

  while (Date.now() < deadline) {
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(`${args.url}/api/v1/workspaces/${args.workspace}/nodes/${encodeURIComponent(args.node)}/lock`, {
        method: 'POST',
        headers: args.testHeader ? { 'x-test-user-id': userId } : {},
      });
    } catch {
      metrics.errors++;
      consecutiveErrors++;
      await sleep(backoffMs());
      continue;
    }
    metrics.latencyMs.push(performance.now() - t0);
    if (res.status === 423) {
      metrics.busy++;
      consecutiveErrors = 0;
      await sleep(200 + Math.random() * 400);
      continue;
    }
    if (!res.ok) {
      metrics.errors++;
      consecutiveErrors++;
      await sleep(backoffMs());
      continue;
    }
    consecutiveErrors = 0;
    metrics.acquired++;
    const holdMs = 5_000 + Math.random() * 10_000;
    let elapsed = 0;
    while (elapsed < holdMs && Date.now() < deadline) {
      await sleep(Math.min(10_000, holdMs - elapsed));
      elapsed += 10_000;
      // heartbeat
      await fetch(`${args.url}/api/v1/workspaces/${args.workspace}/nodes/${encodeURIComponent(args.node)}/lock/heartbeat`, {
        method: 'PUT',
        headers: args.testHeader ? { 'x-test-user-id': userId } : {},
      }).catch(() => {});
    }
    await fetch(`${args.url}/api/v1/workspaces/${args.workspace}/nodes/${encodeURIComponent(args.node)}/lock`, {
      method: 'DELETE',
      headers: args.testHeader ? { 'x-test-user-id': userId } : {},
    }).catch(() => {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv);
  const deadline = Date.now() + args.durationSec * 1000;
  const metrics: Metrics = { acquired: 0, busy: 0, errors: 0, latencyMs: [] };
  const editors = Array.from({ length: args.editors }, (_, i) => `editor-${i + 1}`);
  await Promise.all(editors.map((u) => simulateEditor(args, u, metrics, deadline)));

  const sorted = [...metrics.latencyMs].sort((a, b) => a - b);
  const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  console.log(
    JSON.stringify(
      {
        editors: args.editors,
        durationSec: args.durationSec,
        acquired: metrics.acquired,
        busy: metrics.busy,
        errors: metrics.errors,
        latencyMs: {
          p50: Math.round(p(0.5)),
          p95: Math.round(p(0.95)),
          p99: Math.round(p(0.99)),
        },
      },
      null,
      2,
    ),
  );
}

main();
