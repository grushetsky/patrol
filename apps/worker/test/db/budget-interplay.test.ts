import { beforeEach, describe, expect, it } from "vitest";
import { ensureMonth, monthStartOf } from "@patrol/budget";
import { insertManualScans, readScan } from "@patrol/scans";
import { QUERY_RETRY_DELAYS_MS } from "../../src/acquisition/port.js";
import { FakeSerpAcquisitor } from "../../src/acquisition/fake.js";
import { runNextScan, type ExecutorDeps } from "../../src/scans/executor.js";
import {
  addVariant,
  controlledClock,
  readLedger,
  seedExtraGroup,
  seedWorld,
  testPool,
  truncateDomainTables,
} from "./helpers.js";

/**
 * Seam 4: the budget interplay. A plan that does not fit its bucket stays
 * queued with `budget_exhausted` and is never truncated; a spent re-check
 * bucket queues re-checks without touching the scan share; and two
 * concurrent scans cannot both reserve the last of a bucket.
 */

const instantSleep = async () => {};

function executor(
  pool: ReturnType<typeof testPool>,
  clock: ReturnType<typeof controlledClock>,
  fake: FakeSerpAcquisitor,
): ExecutorDeps {
  return {
    pool,
    now: clock.now,
    adapters: new Map([["google", fake]]),
    retryDelaysMs: QUERY_RETRY_DELAYS_MS,
    sleep: instantSleep,
  };
}

/** A Google cap in minor units; $0.60 buys 1,000 billable units. */
async function setGoogleCap(pool: ReturnType<typeof testPool>, capMinor: number): Promise<void> {
  await pool.query(
    "update rights_holder set budget_google_monthly_cap_minor = $1",
    [capMinor],
  );
}

describe("preflight against the buckets", () => {
  beforeEach(async () => {
    const pool = testPool();
    try {
      await truncateDomainTables(pool);
    } finally {
      await pool.end();
    }
  });

  it("keeps an unfitting plan queued, untruncated, until the cap allows it", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedWorld(pool);
    await addVariant(pool, world, { text: "Рассвет", language: "ru" });
    // One cent of cap: allowance 16 units, scan share 11, plan price 12.
    await setGoogleCap(pool, 1);

    const [scan] = await insertManualScans(pool, clock.now, {
      titleGroupId: world.groupId,
      engines: ["google"],
      trigger: "manual",
      createdBy: world.operatorId,
    });
    const outcome = await runNextScan(
      executor(pool, clock, new FakeSerpAcquisitor("google")),
      "google",
    );
    expect(outcome).toEqual({ outcome: "budget_exhausted" });

    const queued = await readScan(pool, scan.id);
    expect(queued?.state).toBe("queued");
    expect(queued?.failureReason).toBe("budget_exhausted");
    // Never truncated: the plan stood at six queries and stays six.
    expect(queued?.plannedQueries).toBe(6);
    const results = await pool.query<{ count: string }>(
      "select count(*) as count from search_results",
    );
    expect(Number(results.rows[0].count)).toBe(0);
    const ledger = await readLedger(pool, "google", clock.now);
    expect(ledger.scanCommitted).toBe(0);

    // A raised cap lets the queued scan run — the same row, untruncated.
    await setGoogleCap(pool, 4_800);
    const rerun = await runNextScan(
      executor(pool, clock, new FakeSerpAcquisitor("google")),
      "google",
    );
    expect(rerun).toMatchObject({ outcome: "ran", state: "succeeded" });
    const finished = await readScan(pool, scan.id);
    expect(finished?.state).toBe("succeeded");
    expect(finished?.issuedQueries).toBe(6);
    await pool.end();
  });

  it("queues re-checks on a spent re-check share without touching the scan share", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedWorld(pool);
    // Default cap: 80,000 units, 70/30 — 56,000 scan and 24,000 re-check.
    const month = await ensureMonth(pool, "google", monthStartOf(clock.now()));
    // The re-check share reads as spent...
    await pool.query(
      "update quota_ledger set recheck_committed = $2 where id = $1",
      [month.id, 24_000],
    );

    // A ladder re-check (trigger 'recheck') draws on the re-check bucket
    // alone: with that share spent it queues rather than borrowing.
    const recheckScan = await pool.query<{ id: string }>(
      `insert into scans (title_group_id, engine, due_date, trigger_kind, scan_time, created_at)
       values ($1, 'google', '2026-03-02', 'recheck', '02:30', $2)
       returning id`,
      [world.groupId, clock.now().toISOString()],
    );
    const outcome = await runNextScan(
      executor(pool, clock, new FakeSerpAcquisitor("google")),
      "google",
    );
    expect(outcome).toEqual({ outcome: "budget_exhausted" });
    const queued = await readScan(pool, recheckScan.rows[0].id);
    expect(queued?.state).toBe("queued");
    expect(queued?.failureReason).toBe("budget_exhausted");

    // ...and the scan share is untouched: a scheduled scan of another group
    // still runs.
    const other = await seedExtraGroup(pool, world, {
      name: "Other Films",
      priority: "normal",
      titleText: "Moonrise",
    });
    await pool.query(
      `insert into scans (title_group_id, engine, due_date, trigger_kind, scan_time, created_at)
       values ($1, 'google', '2026-03-02', 'scheduled', '02:30', $2)`,
      [other.groupId, clock.now().toISOString()],
    );
    const scanOutcome = await runNextScan(
      executor(pool, clock, new FakeSerpAcquisitor("google")),
      "google",
    );
    expect(scanOutcome).toMatchObject({ outcome: "ran", state: "succeeded" });
    const ledger = await readLedger(pool, "google", clock.now);
    expect(ledger.recheckCommitted).toBe(24_000);
    expect(ledger.scanCommitted).toBe(6);
    await pool.end();
  });

  it("runs re-checks on a healthy re-check share while the scan share is spent", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedWorld(pool);
    // The scan share reads as spent; the re-check share is untouched.
    const month = await ensureMonth(pool, "google", monthStartOf(clock.now()));
    await pool.query(
      "update quota_ledger set scan_committed = $2 where id = $1",
      [month.id, 56_000],
    );

    // A due re-check still attempts and runs: re-checks draw their own
    // unborrowable share, and a spent scan share never queues them.
    const recheckScan = await pool.query<{ id: string }>(
      `insert into scans (title_group_id, engine, due_date, trigger_kind, scan_time, created_at)
       values ($1, 'google', '2026-03-02', 'recheck', '02:30', $2)
       returning id`,
      [world.groupId, clock.now().toISOString()],
    );
    const outcome = await runNextScan(
      executor(pool, clock, new FakeSerpAcquisitor("google")),
      "google",
    );
    expect(outcome).toMatchObject({ outcome: "ran", state: "succeeded" });
    const finished = await readScan(pool, recheckScan.rows[0].id);
    expect(finished?.state).toBe("succeeded");
    // The units came out of the re-check bucket alone: five deduplicated
    // queries at two units each.
    const ledger = await readLedger(pool, "google", clock.now);
    expect(ledger.recheckCommitted).toBe(10);
    expect(ledger.scanCommitted).toBe(56_000);
    await pool.end();
  });

  it("draws a manual re-check from the re-check share, not the scan share", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedWorld(pool);
    await addVariant(pool, world, { text: "Рассвет", language: "ru" });
    // Only six re-check units remain: a manual re-check of the seeded
    // six-query plan (12 units) does not fit and queues, without borrowing
    // the healthy scan share.
    const month = await ensureMonth(pool, "google", monthStartOf(clock.now()));
    await pool.query(
      "update quota_ledger set recheck_committed = $2 where id = $1",
      [month.id, 24_000 - 6],
    );
    const [recheck] = await insertManualScans(pool, clock.now, {
      titleGroupId: world.groupId,
      engines: ["google"],
      trigger: "manual_recheck",
      createdBy: world.operatorId,
    });
    const outcome = await runNextScan(
      executor(pool, clock, new FakeSerpAcquisitor("google")),
      "google",
    );
    expect(outcome).toEqual({ outcome: "budget_exhausted" });
    const queued = await readScan(pool, recheck.id);
    expect(queued?.state).toBe("queued");
    expect(queued?.failureReason).toBe("budget_exhausted");
    let ledger = await readLedger(pool, "google", clock.now);
    expect(ledger.scanCommitted).toBe(0);
    expect(ledger.scanReserved).toBe(0);

    // With the re-check share healthy again the queued manual re-check
    // runs, and its units land in the re-check bucket alone — the work
    // kind, not the manual trigger, decides the bucket.
    await pool.query(
      "update quota_ledger set recheck_committed = 0 where id = $1",
      [month.id],
    );
    const rerun = await runNextScan(
      executor(pool, clock, new FakeSerpAcquisitor("google")),
      "google",
    );
    expect(rerun).toMatchObject({ outcome: "ran", state: "succeeded" });
    ledger = await readLedger(pool, "google", clock.now);
    expect(ledger.recheckCommitted).toBe(12);
    expect(ledger.scanCommitted).toBe(0);
    await pool.end();
  });

  it("lets only one of two concurrent scans reserve the last of a bucket", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedWorld(pool, { locales: ["en"] });
    const other = await seedExtraGroup(pool, world, {
      name: "Rival Films",
      priority: "normal",
      titleText: "Moonrise",
    });
    // Default allowance 80,000: scan share 56,000. Pre-commit so exactly
    // one plan (six units for a three-query title) fits: 56,000 - 6 + ... —
    // leave exactly six units free.
    const month = await ensureMonth(pool, "google", monthStartOf(clock.now()));
    await pool.query(
      "update quota_ledger set scan_committed = $2 where id = $1",
      [month.id, 56_000 - 6],
    );

    for (const group of [world.groupId, other.groupId]) {
      await pool.query(
        `insert into scans (title_group_id, engine, due_date, trigger_kind, scan_time, created_at)
         values ($1, 'google', '2026-03-02', 'scheduled', '02:30', $2)`,
        [group, clock.now().toISOString()],
      );
    }

    const deps = executor(pool, clock, new FakeSerpAcquisitor("google"));
    const [first, second] = await Promise.all([
      runNextScan(deps, "google"),
      runNextScan(deps, "google"),
    ]);
    const outcomes = [first, second].sort((a, b) => a.outcome.localeCompare(b.outcome));
    // Exactly one ran; the other stayed queued on budget.
    expect(outcomes).toEqual([
      { outcome: "budget_exhausted" },
      expect.objectContaining({ outcome: "ran", state: "succeeded" }),
    ]);
    const ledger = await readLedger(pool, "google", clock.now);
    // The bucket's whole share is committed and nothing over it.
    expect(ledger.scanCommitted + ledger.scanReserved).toBe(56_000);
    await pool.end();
  });
});
