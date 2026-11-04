import { setTimeout as sleepTimer } from "node:timers/promises";

export interface LimiterOptions {
  gapMs?: number;
  concurrency?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** One capture per host at a time, with a short same-host gap. */
export class HostLimiter {
  private readonly gapMs: number;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly lastStarted = new Map<string, number>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: LimiterOptions = {}) {
    this.gapMs = options.gapMs ?? 1_000;
    this.concurrency = options.concurrency ?? 4;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((milliseconds) => sleepTimer(milliseconds));
  }

  run<T>(host: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(host) ?? Promise.resolve();
    const current = previous.then(async () => {
      await this.acquire();
      try {
        const wait =
          (this.lastStarted.get(host) ?? 0) + this.gapMs - this.now();
        if (wait > 0) {
          await this.sleep(wait);
        }
        this.lastStarted.set(host, this.now());
        return await task();
      } finally {
        this.release();
      }
    });
    this.tails.set(
      host,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) {
      next();
    }
  }
}
