import { describe, expect, it } from "vitest";
import { CaptureLimiter } from "../src/capture/limiter.js";

/**
 * Seam 7: the politeness limiter. Two captures of the same host serialize
 * (the second's work starts only after the first finished, plus the
 * spacing), captures of different hosts run in parallel up to the overall
 * cap, and a third host waits for a slot instead of exceeding it. The
 * clock and the sleep are injected, so the assertions see order and
 * parallelism without waiting.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function testLimiter(options: { overallConcurrency: number; sameHostSpacingMs: number }) {
  const sleeps: number[] = [];
  const clock = { now: 0 };
  const limiter = new CaptureLimiter({
    overallConcurrency: options.overallConcurrency,
    sameHostSpacingMs: options.sameHostSpacingMs,
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
  });
  return { limiter, sleeps, clock };
}

describe("the capture limiter", () => {
  it("serializes two captures of the same host in start order", async () => {
    const { limiter, sleeps } = testLimiter({ overallConcurrency: 3, sameHostSpacingMs: 2_000 });
    const events: string[] = [];
    const first = deferred<void>();
    const secondStarted = deferred<void>();

    const one = limiter.run("example.test", async () => {
      events.push("one-start");
      await first.promise;
      events.push("one-end");
    });
    // Give the first capture's work a tick to actually start.
    await Promise.resolve();
    const two = limiter.run("example.test", async () => {
      events.push("two-start");
      secondStarted.resolve(undefined);
    });

    first.resolve(undefined);
    await Promise.all([one, two, secondStarted.promise]);

    expect(events).toEqual(["one-start", "one-end", "two-start"]);
    // The spacing ran between the same-host captures.
    expect(sleeps).toEqual([2_000]);
  });

  it("runs captures of different hosts in parallel up to the cap", async () => {
    const { limiter } = testLimiter({ overallConcurrency: 2, sameHostSpacingMs: 1_000 });
    const events: string[] = [];
    const release = deferred<void>();

    const jobs = ["a.example", "b.example", "c.example"].map((host) =>
      limiter.run(host, async () => {
        events.push(`${host}-start`);
        await release.promise;
        events.push(`${host}-end`);
      }),
    );
    // Let the scheduler run: exactly the cap's worth of captures started.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["a.example-start", "b.example-start"]);

    release.resolve(undefined);
    await Promise.all(jobs);
    expect(events.filter((event) => event.endsWith("-end"))).toHaveLength(3);
    // The third host ran once a slot opened.
    expect(events).toContain("c.example-start");
    expect(events.indexOf("c.example-start")).toBeGreaterThan(
      events.indexOf("a.example-end"),
    );
  });

  it("skips the spacing before a host's very first capture", async () => {
    const { limiter, sleeps } = testLimiter({ overallConcurrency: 1, sameHostSpacingMs: 5_000 });
    await limiter.run("fresh.example", async () => "done");
    expect(sleeps).toEqual([]);
  });
});
