/**
 * The capture politeness limiter (docs/design/evidence-capture.md
 * "Per-host politeness"): at most one capture per host at a time, a short
 * spacing between captures of the same host, and no more than a handful of
 * concurrent captures overall, so a thousand URLs on one platform do not
 * become a flood. The clock and sleep are injected, so tests assert the
 * ordering, the parallelism, and the spacing without waiting for them.
 */

export interface CaptureLimiterOptions {
  /** Allowed concurrent captures overall — "a handful". */
  overallConcurrency: number;
  /** The quiet gap between two captures of the same host. */
  sameHostSpacingMs: number;
  /** The epoch-milliseconds clock the spacing measures with. */
  now: () => number;
  /** The sleep the spacing waits through. */
  sleep: (ms: number) => Promise<void>;
}

/** One host's serialization point. */
interface HostSlot {
  tail: Promise<unknown>;
  lastFinishedAt: number | null;
}

export class CaptureLimiter {
  private readonly hosts = new Map<string, HostSlot>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly options: CaptureLimiterOptions) {}

  /**
   * Runs one capture's work under both limits: the overall semaphore first
   * (a slot must open before anything starts), then the per-host chain (a
   * host is never fetched twice at once, and a capture that just finished
   * on the host is followed by the spacing before the next begins).
   */
  async run<T>(host: string, work: () => Promise<T>): Promise<T> {
    await this.takeOverall();
    try {
      return await this.enqueueHost(host, work);
    } finally {
      this.releaseOverall();
    }
  }

  private takeOverall(): Promise<void> {
    if (this.active < this.options.overallConcurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private releaseOverall(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
    }
  }

  private enqueueHost<T>(host: string, work: () => Promise<T>): Promise<T> {
    const slot = this.hosts.get(host) ?? { tail: Promise.resolve(), lastFinishedAt: null };
    this.hosts.set(host, slot);
    // Chain onto the host's tail: this capture's work starts only when the
    // previous one finished, and after the spacing that finished capture
    // imposed — serialized per host by construction, whatever the overall
    // semaphore would have allowed.
    const chained = slot.tail.then(async () => {
      const gap =
        slot.lastFinishedAt === null
          ? 0
          : slot.lastFinishedAt + this.options.sameHostSpacingMs - this.options.now();
      if (gap > 0) {
        await this.options.sleep(gap);
      }
      return work();
    });
    const settled = chained.finally(() => {
      slot.lastFinishedAt = this.options.now();
    });
    // The tail never rejects later waiters, even when the work failed.
    slot.tail = settled.catch(() => undefined);
    return settled;
  }
}
