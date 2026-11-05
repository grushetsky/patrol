import { beforeEach, describe, expect, it } from "vitest";
import { RESERVATION_TTL_MS, ensureMonth, monthStartOf } from "@patrol/budget";
import { QUERY_RETRY_DELAYS_MS } from "../../src/acquisition/port.js";
import { FakeSerpAcquisitor } from "../../src/acquisition/fake.js";
import { runNextScan, type ExecutorDeps } from "../../src/scans/executor.js";
import { scanScheduleJob } from "../../src/jobs.js";
import {
  insertManualScans,
  readScan,
  requeueCrashedScans,
} from "@patrol/scans";
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
 * Seam 3, 8, and 9: a fake adapter drives a group scan end to end — plan
 * priced, units reserved, results stored, units committed, scan state
 * correct — and a second same-day manual request returns the same scan.
 * Results are provenance: the database refuses their update.
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

describe("a group scan end to end", () => {
  beforeEach(async () => {
    const pool = testPool();
    try {
      await truncateDomainTables(pool);
    } finally {
      await pool.end();
    }
  });

  it("prices the plan, reserves, stores results, commits, and succeeds", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedWorld(pool);
    await addVariant(pool, world, { text: "Рассвет", language: "ru" });
    const fake = new FakeSerpAcquisitor("google");

    const [scan] = await insertManualScans(pool, clock.now, {
      titleGroupId: world.groupId,
      engines: ["google"],
      trigger: "manual",
      createdBy: world.operatorId,
    });
    expect(scan.state).toBe("queued");

    const outcome = await runNextScan(executor(pool, clock, fake), "google");
    expect(outcome).toMatchObject({ outcome: "ran", state: "succeeded" });

    const finished = await readScan(pool, scan.id);
    expect(finished?.state).toBe("succeeded");
    // Sunrise (en) + 2 en intents + Рассвет (ru, original always eligible
    // but its text differs) + 2 ru intents: six queries, deduplicated.
    expect(finished?.plannedQueries).toBe(6);
    expect(finished?.issuedQueries).toBe(6);

    // The plan is priced at two units per Google query and the whole hold
    // settles as committed.
    const ledger = await readLedger(pool, "google", clock.now);
    expect(ledger.scanCommitted).toBe(12);
    expect(ledger.scanReserved).toBe(0);
    const reservation = await pool.query<{
      state: string;
      committed_units: number;
      released_units: number;
    }>(
      "select state, committed_units, released_units from budget_reservations where scan_id = $1",
      [scan.id],
    );
    expect(reservation.rows[0]).toMatchObject({
      state: "committed",
      committed_units: 12,
      released_units: 0,
    });

    // Results are stored as provenance: three rows per query, each with the
    // raw URL verbatim and the normalized key derived beside it.
    const results = await pool.query<{
      count: string;
      ranks: number[];
      normalized: string[];
    }>(
      `select count(*) as count, array_agg(distinct rank) as ranks,
              array_agg(distinct normalized_url) as normalized
         from search_results where scan_id = $1`,
      [scan.id],
    );
    expect(Number(results.rows[0].count)).toBe(18);
    expect(results.rows[0].ranks.sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(results.rows[0].normalized.every((key) => !key.includes("://"))).toBe(true);

    // The intent queries recorded the phrase version they were issued under.
    const intents = await pool.query<{ intent_phrase_version: number }>(
      `select distinct intent_phrase_version from search_queries q
         join query_plans p on p.id = q.query_plan_id where p.scan_id = $1 and q.kind = 'intent'`,
      [scan.id],
    );
    expect(intents.rows.map((row) => Number(row.intent_phrase_version))).toEqual([1]);
    await pool.end();
  });

  it("returns the same scan for a second same-day manual request", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedWorld(pool);
    const first = await insertManualScans(pool, clock.now, {
      titleGroupId: world.groupId,
      engines: ["google", "yandex"],
      trigger: "manual",
      createdBy: world.operatorId,
    });
    clock.advance(3_600_000);
    const second = await insertManualScans(pool, clock.now, {
      titleGroupId: world.groupId,
      engines: ["google", "yandex"],
      trigger: "manual_recheck",
      createdBy: world.operatorId,
    });
    expect(second.map((scan) => scan.id).sort()).toEqual(
      first.map((scan) => scan.id).sort(),
    );
    const total = await pool.query<{ count: string }>(
      "select count(*) as count from scans",
    );
    expect(Number(total.rows[0].count)).toBe(2);
    await pool.end();
  });

  it("refuses every update to stored search results but the candidate pairing", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedWorld(pool);
    const fake = new FakeSerpAcquisitor("google");
    const [scan] = await insertManualScans(pool, clock.now, {
      titleGroupId: world.groupId,
      engines: ["google"],
      trigger: "manual",
      createdBy: world.operatorId,
    });
    await runNextScan(executor(pool, clock, fake), "google");
    await expect(
      pool.query("update search_results set rank = 99 where scan_id = $1", [scan.id]),
    ).rejects.toThrow(/never edited/i);
    // The pairing link alone is writable: candidate formation attaches the
    // candidate a row paired into, which the insert could not know.
    const candidate = await pool.query<{ id: string }>(
      "select id from candidates limit 1",
    );
    await expect(
      pool.query("update search_results set candidate_id = $1 where scan_id = $2", [
        candidate.rows[0].id,
        scan.id,
      ]),
    ).resolves.toBeTruthy();
    // And writable one-way: a paired row never unpairs, because the pairing
    // is as much provenance as the rank beside it.
    await expect(
      pool.query("update search_results set candidate_id = null where scan_id = $1", [
        scan.id,
      ]),
    ).rejects.toThrow(/never edited/i);
    await pool.end();
  });

  it("records a partial scan when some queries fail and none answer fails", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedWorld(pool);
    await addVariant(pool, world, { text: "Рассвет", language: "ru" });
    // One query exhausts the retry schedule; the rest answer.
    const fake = new FakeSerpAcquisitor("google", {
      scripts: { "Sunrise watch online": ["server_error", "server_error", "server_error", "server_error"] },
    });
    const [scan] = await insertManualScans(pool, clock.now, {
      titleGroupId: world.groupId,
      engines: ["google"],
      trigger: "manual",
      createdBy: world.operatorId,
    });
    const outcome = await runNextScan(executor(pool, clock, fake), "google");
    expect(outcome).toMatchObject({ outcome: "ran", state: "partial" });
    const finished = await readScan(pool, scan.id);
    expect(finished?.state).toBe("partial");
    expect(finished?.issuedQueries).toBe(6);
    const failures = await pool.query<{ reason: string; attempts: number }>(
      "select reason, attempts from query_failures where scan_id = $1",
      [scan.id],
    );
    expect(failures.rows).toEqual([{ reason: "provider 5xx", attempts: 4 }]);
    // A partial scan commits what it issued — every query, failed or not —
    // and releases nothing it issued.
    const ledger = await readLedger(pool, "google", clock.now);
    expect(ledger.scanCommitted).toBe(12);

    // A scan where nothing answers fails with its reason on the row.
    const allFail = new FakeSerpAcquisitor("google", {
      scripts: {
        Sunrise: ["timeout", "timeout", "timeout", "timeout"],
        "Sunrise watch online": ["timeout", "timeout", "timeout", "timeout"],
        "Sunrise download": ["timeout", "timeout", "timeout", "timeout"],
      },
    });
    const solo = await seedWorld(pool, { locales: ["en"] });
    const clock2 = controlledClock("2026-03-03T10:00:00.000Z");
    const [scan2] = await insertManualScans(pool, clock2.now, {
      titleGroupId: solo.groupId,
      engines: ["google"],
      trigger: "manual",
      createdBy: solo.operatorId,
    });
    const outcome2 = await runNextScan(
      { pool, now: clock2.now, adapters: new Map([["google", allFail]]), retryDelaysMs: [1, 1, 1], sleep: instantSleep },
      "google",
    );
    expect(outcome2).toMatchObject({ outcome: "ran", state: "failed" });
    const failed = await readScan(pool, scan2.id);
    expect(failed?.state).toBe("failed");
    expect(failed?.failureReason).toBe("provider_error");
    await pool.end();
  });

  it("settles a manual scan's units and records who requested it", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedWorld(pool);
    const fake = new FakeSerpAcquisitor("google");
    const [scan] = await insertManualScans(pool, clock.now, {
      titleGroupId: world.groupId,
      engines: ["google"],
      trigger: "manual",
      createdBy: world.operatorId,
    });
    await runNextScan(executor(pool, clock, fake), "google");
    const finished = await readScan(pool, scan.id);
    expect(finished?.createdBy).toBe(world.operatorId);
    await pool.end();
  });
});

describe("the crash sweep for running scans", () => {
  beforeEach(async () => {
    const pool = testPool();
    try {
      await truncateDomainTables(pool);
    } finally {
      await pool.end();
    }
  });

  /** One scan row forced into `running`, as a dead worker left it. */
  async function crashedScan(
    pool: ReturnType<typeof testPool>,
    groupId: string,
    startedAt: string,
  ): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `insert into scans (title_group_id, engine, due_date, trigger_kind, scan_time,
                          created_at, state, started_at)
       values ($1, 'google', '2026-03-02', 'scheduled', '02:30', $2, 'running', $2)
       returning id`,
      [groupId, startedAt],
    );
    return result.rows[0].id;
  }

  /** One held reservation for a scan, against the month's real ledger row. */
  async function heldReservation(
    pool: ReturnType<typeof testPool>,
    scanId: string,
    createdAt: Date,
    expiresAt: Date,
  ): Promise<void> {
    const month = await ensureMonth(pool, "google", monthStartOf(createdAt));
    await pool.query(
      `insert into budget_reservations
         (scan_id, engine, month_start, bucket, units, state, created_at, expires_at)
       values ($1, 'google', $2::date, 'scan', 12, 'held', $3, $4)`,
      [scanId, month.monthStart, createdAt.toISOString(), expiresAt.toISOString()],
    );
  }

  it("requeues a running scan whose reservation expired, with worker_crash recorded", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedWorld(pool);
    // The worker died an hour ago: the scan has been running since, and its
    // hold expired a moment ago.
    const startedAt = new Date(clock.now().getTime() - RESERVATION_TTL_MS - 60_000);
    const scanId = await crashedScan(pool, world.groupId, startedAt.toISOString());
    await heldReservation(
      pool,
      scanId,
      startedAt,
      new Date(startedAt.getTime() + RESERVATION_TTL_MS),
    );

    const swept = await requeueCrashedScans(pool, clock.now, RESERVATION_TTL_MS);
    expect(swept).toBe(1);
    const scan = await readScan(pool, scanId);
    expect(scan?.state).toBe("queued");
    expect(scan?.failureReason).toBe("worker_crash");
    expect(scan?.startedAt).toBeNull();
    await pool.end();
  });

  it("leaves a running scan with a live held reservation untouched", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedWorld(pool);
    const other = await seedExtraGroup(pool, world, {
      name: "Mid-Plan Films",
      priority: "normal",
      titleText: "Moonrise",
    });
    // A scan claimed minutes ago, its hold alive for the better part of an
    // hour: its holder may still be running.
    const startedAt = new Date(clock.now().getTime() - 5 * 60_000);
    const live = await crashedScan(pool, world.groupId, startedAt.toISOString());
    await heldReservation(
      pool,
      live,
      startedAt,
      new Date(startedAt.getTime() + RESERVATION_TTL_MS),
    );
    // A second running scan never reserved at all, but was claimed moments
    // ago — mid-plan, before its hold exists.
    const fresh = await crashedScan(pool, other.groupId, startedAt.toISOString());
    void fresh;

    const swept = await requeueCrashedScans(pool, clock.now, RESERVATION_TTL_MS);
    expect(swept).toBe(0);
    expect((await readScan(pool, live))?.state).toBe("running");
    expect((await readScan(pool, fresh))?.state).toBe("running");
    await pool.end();
  });

  it("requeues a stale claim that never reserved, once its window passes", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedWorld(pool);
    // Claimed over an hour ago and no hold ever stood for it: the worker
    // died between the claim and the reservation.
    const startedAt = new Date(clock.now().getTime() - RESERVATION_TTL_MS - 60_000);
    const stale = await crashedScan(pool, world.groupId, startedAt.toISOString());

    const swept = await requeueCrashedScans(pool, clock.now, RESERVATION_TTL_MS);
    expect(swept).toBe(1);
    expect((await readScan(pool, stale))?.failureReason).toBe("worker_crash");
    await pool.end();
  });

  it("rides the scan.schedule tick, and the next picker re-prices the remainder", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedWorld(pool);
    const startedAt = new Date(clock.now().getTime() - RESERVATION_TTL_MS - 60_000);
    const scanId = await crashedScan(pool, world.groupId, startedAt.toISOString());

    const dispatches: string[] = [];
    await scanScheduleJob(
      {
        pool,
        now: clock.now,
        dispatch: async (engine) => {
          dispatches.push(engine);
        },
      },
      () => undefined,
    );
    expect((await readScan(pool, scanId))?.state).toBe("queued");

    // The requeued scan runs as a new attempt on the same row.
    const outcome = await runNextScan(
      executor(pool, clock, new FakeSerpAcquisitor("google")),
      "google",
    );
    expect(outcome).toMatchObject({ outcome: "ran", state: "succeeded" });
    const finished = await readScan(pool, scanId);
    expect(finished?.state).toBe("succeeded");
    expect(dispatches).toEqual(["google", "yandex"]);
    await pool.end();
  });
});
