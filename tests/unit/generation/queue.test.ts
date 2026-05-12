import { describe, expect, test } from 'bun:test';
import { GenerationQueue } from '../../../src/generation/queue.ts';

describe('GenerationQueue', () => {
  test('runs jobs in FIFO order at concurrency=1', async () => {
    const seen: number[] = [];
    const q = new GenerationQueue<number, number>(
      async (job) => {
        seen.push(job.payload);
        return job.payload * 2;
      },
      { concurrency: 1 },
    );
    const r1 = q.enqueue(1);
    const r2 = q.enqueue(2);
    const r3 = q.enqueue(3);
    const [a, b, c] = await Promise.all([r1, r2, r3]);
    expect([a.result, b.result, c.result]).toEqual([2, 4, 6]);
    expect(seen).toEqual([1, 2, 3]);
  });

  test('respects the concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    const q = new GenerationQueue<number, number>(
      async (job) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return job.payload;
      },
      { concurrency: 2 },
    );
    await Promise.all(Array.from({ length: 6 }, (_, i) => q.enqueue(i)));
    expect(peak).toBe(2);
  });

  test('captures errors into the result instead of throwing', async () => {
    const q = new GenerationQueue<number, number>(async () => {
      throw new Error('boom');
    });
    const r = await q.enqueue(1);
    expect(r.result).toBeNull();
    expect(r.error?.message).toBe('boom');
  });

  test('settle waits until the queue is fully drained', async () => {
    const q = new GenerationQueue<number, number>(async (job) => {
      await new Promise((r) => setTimeout(r, 1));
      return job.payload;
    });
    for (let i = 0; i < 4; i++) q.enqueue(i);
    await q.settle();
    expect(q.size()).toBe(0);
    expect(q.inFlight()).toBe(0);
  });
});
