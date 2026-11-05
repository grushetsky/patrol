import { beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { enqueueCapture, readCapture } from "@patrol/evidence";
import { captureSweepJob } from "../../src/jobs.js";
import { runCapture } from "../../src/capture/runner.js";
import { controlledClock, testPool } from "./helpers.js";
import {
  MemoryStore,
  capturedObservation,
  failedObservation,
  noopDispatch,
  runnerDeps,
} from "./capture-helpers.js";

/**
 * The capture sweeper (the `capture.sweep` cron): the backstop for rows a
 * dead process would strand, because the capture queue carries no retry
 * of its own. A pending capture whose next attempt has come due gets its
 * wake-up re-sent — a crash between the record and the schedule loses the
 * original — a running attempt older than the stale threshold is a dead
 * worker's row and goes back to pending for the next dispatch, and
 * everything else (a pending retry not yet due, a live running attempt, a
 * finished capture) is left exactly where it stands.
 */

let pool: Pool;

beforeAll(async () => {
  pool = testPool();
});

const SCHEDULE = [111_000, 222_000];
const CLOCK = "2026-05-01T10:00:00.000Z";
type Clock = ReturnType<typeof controlledClock>;

/** The sweeper with a recording dispatch. */
function sweepFor(clock: Clock, staleRunningMs = 10 * 60_000): {
  dispatched: string[];
  run: () => Promise<void>;
} {
  const dispatched: string[] = [];
  return {
    dispatched,
    run: () =>
      captureSweepJob(
        {
          pool,
          now: clock.now,
          dispatch: async (captureId) => {
            dispatched.push(captureId);
          },
          staleRunningMs,
        },
        () => {},
      ),
  };
}

async function enqueue(clock: Clock, url: string): Promise<string> {
  const enqueued = await enqueueCapture(
    { pool, now: clock.now, dispatch: noopDispatch },
    { url, reason: "detection" },
  );
  if (enqueued.status !== "queued") {
    throw new Error(`unexpected enqueue status ${enqueued.status}`);
  }
  return enqueued.captureId;
}

describe("the capture sweeper (capture.sweep)", () => {
  it("re-dispatches a pending capture whose next attempt came due", async () => {
    const clock = controlledClock(CLOCK);
    const url = "https://due.example.test/watch";
    const captureId = await enqueue(clock, url);
    // One blocked attempt leaves the row pending with its retry scheduled
    // — and the wake-up treated as lost, as if the runner died between
    // the record and the schedule.
    await runCapture(
      runnerDeps(
        pool,
        clock,
        new MemoryStore(),
        async () => failedObservation(url, { outcome: "blocked", failureReason: "http_403" }),
        { retryDelaysMs: SCHEDULE },
      ),
      captureId,
      () => {},
    );

    // Not due yet: the sweep leaves it alone.
    const early = sweepFor(clock);
    await early.run();
    expect(early.dispatched).toEqual([]);

    clock.advance(SCHEDULE[0]);
    const sweep = sweepFor(clock);
    await sweep.run();
    expect(sweep.dispatched).toEqual([captureId]);
    const capture = await readCapture(pool, captureId);
    expect(capture?.state).toBe("pending");
    expect(capture?.nextAttemptAt).toEqual(new Date(clock.now().getTime()));
  });

  it("reaps a stale running capture back to pending and dispatches it", async () => {
    const clock = controlledClock(CLOCK);
    const url = "https://reaped.example.test/watch";
    const captureId = await enqueue(clock, url);
    // A worker claimed the row and died mid-attempt: running, its attempt
    // a stale threshold old, no record, no wake-up ever coming.
    await pool.query(
      `update captures
         set state = 'running', attempt_count = 1, last_attempt_at = $2, next_attempt_at = null
       where id = $1`,
      [captureId, new Date(clock.now().getTime() - 11 * 60_000)],
    );

    const sweep = sweepFor(clock);
    await sweep.run();
    expect(sweep.dispatched).toEqual([captureId]);
    const capture = await readCapture(pool, captureId);
    expect(capture?.state).toBe("pending");
    // The spent attempt stands; the next one is due immediately.
    expect(capture?.attemptCount).toBe(1);
    expect(capture?.nextAttemptAt).toEqual(clock.now());
    expect(capture?.evidenceId).toBeNull();
  });

  it("leaves a live running attempt and a finished capture alone", async () => {
    const clock = controlledClock(CLOCK);
    const liveUrl = "https://live-running.example.test/watch";
    const liveId = await enqueue(clock, liveUrl);
    await pool.query(
      `update captures
         set state = 'running', attempt_count = 1, last_attempt_at = $2
       where id = $1`,
      [liveId, clock.now()],
    );

    const doneUrl = "https://finished.example.test/watch";
    const doneId = await enqueue(clock, doneUrl);
    await runCapture(
      runnerDeps(pool, clock, new MemoryStore(), async () => capturedObservation(doneUrl)),
      doneId,
      () => {},
    );

    const sweep = sweepFor(clock);
    await sweep.run();
    // Neither row is swept: a live attempt is not stale and a finished
    // capture is not pending. (An earlier test's unclaimed due retry may
    // legitimately be re-dispatched here, so the ids are the assertion.)
    expect(sweep.dispatched).not.toContain(liveId);
    expect(sweep.dispatched).not.toContain(doneId);
    const liveRow = await readCapture(pool, liveId);
    expect(liveRow?.state).toBe("running");
    expect(liveRow?.nextAttemptAt).toBeNull();
    const doneRow = await readCapture(pool, doneId);
    expect(doneRow?.state).toBe("done");
  });
});
