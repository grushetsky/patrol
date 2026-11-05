import { beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { EvidenceStore } from "@patrol/evidence";
import { enqueueCapture, readCapture, readEvidence } from "@patrol/evidence";
import { runCapture } from "../../src/capture/runner.js";
import type { PageObservation } from "../../src/capture/browser.js";
import { controlledClock, testPool } from "./helpers.js";
import {
  MemoryStore,
  baseObservation,
  capturedObservation,
  failedObservation,
  noopDispatch,
  runnerDeps,
} from "./capture-helpers.js";

/**
 * Seam 6, the retry matrix over the real record: `dead` never retries —
 * the page is recorded as dead at that time; `blocked` and `error` retry
 * up to three attempts with backoff inside 24 hours, each attempt its own
 * evidence row, scheduled through the injected scheduler; the exhausted
 * attempt is terminal, and a page that recovers on a later attempt lands
 * captured. A fetch that throws mid-attempt marks the capture failed
 * rather than stranding it, and a wake-up ahead of its scheduled attempt
 * stands down. A fake fetcher drives the outcomes without a browser; the
 * schedule is asserted, never waited through.
 */

let pool: Pool;

beforeAll(async () => {
  pool = testPool();
});

const SCHEDULE = [111_000, 222_000];
type Clock = ReturnType<typeof controlledClock>;
type ObservationFor = (attempt: number) => PageObservation;

async function runOne(
  clock: Clock,
  captureId: string,
  observationFor: ObservationFor,
  store: EvidenceStore = new MemoryStore(),
) {
  const fetches: string[] = [];
  const deps = runnerDeps(
    pool,
    clock,
    store,
    async (target) => {
      fetches.push(target);
      return observationFor(fetches.length);
    },
    { retryDelaysMs: SCHEDULE },
  );
  await runCapture(deps, captureId, () => {});
  return { fetches, scheduled: deps.scheduled, capture: await readCapture(pool, captureId) };
}

async function enqueue(clock: Clock, url: string): Promise<string> {
  const enqueued = await enqueueCapture(
    { pool, now: clock.now, dispatch: noopDispatch },
    { url, reason: "detection" },
  );
  if (enqueued.status !== "queued") {
    throw new Error(`enqueue did not queue: ${JSON.stringify(enqueued)}`);
  }
  return enqueued.captureId;
}

const outcomeOf = async (evidenceId: string) =>
  (await readEvidence(pool, evidenceId))!.evidence.outcome;

describe("the capture retry matrix (seam 6)", () => {
  it("never retries a dead capture", async () => {
    const clock = controlledClock("2026-05-01T10:00:00.000Z");
    const url = "https://dead.example.test/watch";
    const captureId = await enqueue(clock, url);
    const { fetches, scheduled, capture } = await runOne(clock, captureId, () =>
      failedObservation(url, { outcome: "dead", failureReason: "http_404" }),
    );
    expect(fetches).toHaveLength(1);
    expect(scheduled).toEqual([]);
    expect(capture?.state).toBe("done");
    expect(capture?.attemptCount).toBe(1);
    await expect(outcomeOf(capture!.evidenceId!)).resolves.toBe("dead");
  });

  it("never retries a captured capture", async () => {
    const clock = controlledClock("2026-05-01T10:00:00.000Z");
    const url = "https://live.example.test/watch";
    const captureId = await enqueue(clock, url);
    const { fetches, scheduled, capture } = await runOne(clock, captureId, () =>
      capturedObservation(url),
    );
    expect(fetches).toHaveLength(1);
    expect(scheduled).toEqual([]);
    expect(capture?.state).toBe("done");
    await expect(outcomeOf(capture!.evidenceId!)).resolves.toBe("captured");
  });

  it("retries a blocked capture up to three attempts with backoff", async () => {
    const clock = controlledClock("2026-05-01T10:00:00.000Z");
    const url = "https://walled.example.test/watch";
    const blocked = (): PageObservation => ({
      ...baseObservation(url),
      failure: null,
      finalUrl: url,
      httpStatus: 403,
      headers: { "content-type": "text/html" },
      rawBody: new TextEncoder().encode("<html><body>forbidden</body></html>"),
      pageHost: "walled.example.test",
    });

    const captureId = await enqueue(clock, url);
    const first = await runOne(clock, captureId, blocked);
    expect(first.fetches).toHaveLength(1);
    expect(first.scheduled).toEqual([{ captureId, delayMs: SCHEDULE[0] }]);
    expect(first.capture?.state).toBe("pending");
    expect(first.capture?.nextAttemptAt).toEqual(new Date(clock.now().getTime() + SCHEDULE[0]));

    clock.advance(SCHEDULE[0]);
    const second = await runOne(clock, captureId, blocked);
    expect(second.fetches).toHaveLength(1);
    expect(second.scheduled).toEqual([{ captureId, delayMs: SCHEDULE[1] }]);

    clock.advance(SCHEDULE[1]);
    const third = await runOne(clock, captureId, blocked);
    expect(third.scheduled).toEqual([]);
    const capture = await readCapture(pool, captureId);
    expect(capture?.state).toBe("done");
    expect(capture?.attemptCount).toBe(3);

    // Every attempt is a row: three refusals, not one unexplained absence.
    const rows = await pool.query(
      "select attempt_number, outcome, failure_reason from evidence where capture_id = $1 order by attempt_number",
      [captureId],
    );
    expect(rows.rows).toEqual([
      { attempt_number: 1, outcome: "blocked", failure_reason: "http_403" },
      { attempt_number: 2, outcome: "blocked", failure_reason: "http_403" },
      { attempt_number: 3, outcome: "blocked", failure_reason: "http_403" },
    ]);
  });

  it("retries an error capture on the same schedule", async () => {
    const clock = controlledClock("2026-05-01T10:00:00.000Z");
    const url = "https://slow.example.test/watch";
    const failing = () => failedObservation(url, { outcome: "error", failureReason: "timeout_navigation" });
    const captureId = await enqueue(clock, url);
    const first = await runOne(clock, captureId, failing);
    expect(first.scheduled).toEqual([{ captureId, delayMs: SCHEDULE[0] }]);
    clock.advance(SCHEDULE[0]);
    const second = await runOne(clock, captureId, failing);
    expect(second.scheduled).toEqual([{ captureId, delayMs: SCHEDULE[1] }]);
  });

  it("stops retrying when the page recovers on a later attempt", async () => {
    const clock = controlledClock("2026-05-01T10:00:00.000Z");
    const url = "https://flaky.example.test/watch";
    const captureId = await enqueue(clock, url);
    await runOne(clock, captureId, () =>
      failedObservation(url, { outcome: "error", failureReason: "tls_failure" }),
    );
    clock.advance(SCHEDULE[0]);
    const second = await runOne(clock, captureId, () => capturedObservation(url));
    expect(second.scheduled).toEqual([]);
    const capture = await readCapture(pool, captureId);
    expect(capture?.state).toBe("done");
    await expect(outcomeOf(capture!.evidenceId!)).resolves.toBe("captured");
  });

  it("marks the capture failed when the fetch itself throws mid-attempt", async () => {
    const clock = controlledClock("2026-05-01T10:00:00.000Z");
    const url = "https://crashed.example.test/watch";
    const captureId = await enqueue(clock, url);
    const deps = runnerDeps(pool, clock, new MemoryStore(), async () => {
      throw new Error("the browser died under the fetch");
    });
    await runCapture(deps, captureId, () => {});
    // Not stranded in running: the queue has no retry of its own, so the
    // row is failed for ops instead of waiting for a wake-up that cannot
    // come.
    const capture = await readCapture(pool, captureId);
    expect(capture?.state).toBe("failed");
    expect(capture?.finishedAt).not.toBeNull();
    expect(capture?.evidenceId).toBeNull();
    expect(deps.scheduled).toEqual([]);
    const rows = await pool.query("select * from evidence where capture_id = $1", [
      captureId,
    ]);
    expect(rows.rows).toHaveLength(0);
  });

  it("stands down a wake-up that arrives ahead of the scheduled attempt", async () => {
    const clock = controlledClock("2026-05-01T10:00:00.000Z");
    const url = "https://paced.example.test/watch";
    const blocked = (): PageObservation => ({
      ...baseObservation(url),
      finalUrl: url,
      httpStatus: 429,
      headers: { "content-type": "text/html" },
      rawBody: new TextEncoder().encode("<html><body>slow down</body></html>"),
      pageHost: "paced.example.test",
    });
    const captureId = await enqueue(clock, url);
    const first = await runOne(clock, captureId, blocked);
    expect(first.scheduled).toEqual([{ captureId, delayMs: SCHEDULE[0] }]);

    // A duplicate wake-up (the sweeper's re-dispatch racing the schedule)
    // arrives before the backoff has elapsed: it must not pull the retry
    // forward, so nothing is fetched and the schedule stands.
    clock.advance(1_000);
    const early = await runOne(clock, captureId, blocked);
    expect(early.fetches).toEqual([]);
    expect(early.scheduled).toEqual([]);
    const midBackoff = await readCapture(pool, captureId);
    expect(midBackoff?.state).toBe("pending");
    expect(midBackoff?.attemptCount).toBe(1);
    expect(midBackoff?.nextAttemptAt).toEqual(
      new Date(new Date("2026-05-01T10:00:00.000Z").getTime() + SCHEDULE[0]),
    );

    // Once due, the wake-up runs the second attempt.
    clock.advance(SCHEDULE[0] - 1_000);
    const onTime = await runOne(clock, captureId, blocked);
    expect(onTime.fetches).toHaveLength(1);
    expect(onTime.scheduled).toEqual([{ captureId, delayMs: SCHEDULE[1] }]);
  });
});
