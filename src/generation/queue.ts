/**
 * In-process FIFO queue with a concurrency cap (plan §5 Phase 5).
 *
 * The pipeline is the consumer; the route handler is the producer. The
 * queue is intentionally minimal — no persistence, no priorities, no retry
 * logic. Restart-safe durability lives at the `provenance_events` row, not
 * here.
 */

export interface QueuedJob<T> {
  id: string;
  payload: T;
  enqueuedAt: string;
}

export type JobHandler<T, R> = (job: QueuedJob<T>) => Promise<R>;

export interface JobResult<R> {
  jobId: string;
  enqueuedAt: string;
  startedAt: string;
  finishedAt: string;
  result: R | null;
  error: Error | null;
}

export interface QueueOptions {
  concurrency?: number;
  /** Override `Date.now`/`new Date()` for deterministic tests. */
  clock?: () => Date;
}

export class GenerationQueue<T, R> {
  public readonly concurrency: number;
  private readonly clock: () => Date;
  private readonly handler: JobHandler<T, R>;
  private readonly pending: Array<{
    job: QueuedJob<T>;
    resolve: (r: JobResult<R>) => void;
  }> = [];
  private running = 0;
  private nextSeq = 0;

  constructor(handler: JobHandler<T, R>, opts: QueueOptions = {}) {
    this.handler = handler;
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.clock = opts.clock ?? (() => new Date());
  }

  enqueue(payload: T): Promise<JobResult<R>> {
    const id = `job-${++this.nextSeq}-${this.clock().getTime().toString(36)}`;
    const job: QueuedJob<T> = { id, payload, enqueuedAt: this.clock().toISOString() };
    return new Promise<JobResult<R>>((resolve) => {
      this.pending.push({ job, resolve });
      this.drain();
    });
  }

  /** Wait for the queue to fully drain. Useful in tests. */
  async settle(): Promise<void> {
    while (this.running > 0 || this.pending.length > 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  size(): number {
    return this.pending.length;
  }

  inFlight(): number {
    return this.running;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private drain(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift();
      if (!entry) break;
      this.running++;
      const startedAt = this.clock().toISOString();
      Promise.resolve()
        .then(() => this.handler(entry.job))
        .then(
          (result) => {
            entry.resolve({
              jobId: entry.job.id,
              enqueuedAt: entry.job.enqueuedAt,
              startedAt,
              finishedAt: this.clock().toISOString(),
              result,
              error: null,
            });
          },
          (err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err));
            entry.resolve({
              jobId: entry.job.id,
              enqueuedAt: entry.job.enqueuedAt,
              startedAt,
              finishedAt: this.clock().toISOString(),
              result: null,
              error,
            });
          },
        )
        .finally(() => {
          this.running--;
          this.drain();
        });
    }
  }
}
