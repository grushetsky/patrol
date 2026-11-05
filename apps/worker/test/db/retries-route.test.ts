import { beforeEach, describe, expect, it } from "vitest";
import { insertManualScans, readScan } from "@patrol/scans";
import { QUERY_RETRY_DELAYS_MS } from "../../src/acquisition/port.js";
import { FakeSerpAcquisitor } from "../../src/acquisition/fake.js";
import { runNextScan, type ExecutorDeps } from "../../src/scans/executor.js";
import { scanScheduleJob } from "../../src/jobs.js";
import { disableRoute, probeRoutes, readRouteState } from "../../src/scans/route-state.js";
import {
  controlledClock,
  readLedger,
  seedExtraGroup,
  seedWorld,
  testPool,
  truncateDomainTables,
} from "./helpers.js";

/**
 * Seam 5: provider 5xx and 429 retry at one, five, and fifteen minutes
 * with the sequence recorded; an authentication failure disables the
 * engine, the scan fails with route_unavailable, and the hourly probe
 * re-enables the route when it recovers.
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

describe("query retries and the route", () => {
  beforeEach(async () => {
    const pool = testPool();
    try {
      await truncateDomainTables(pool);
    } finally {
      await pool.end();
    }
  });

  it("records the 1/5/15-minute schedule on the failed query", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedWorld(pool, { locales: ["en"] });
    // A 429 that never clears for one query; the others answer.
    const fake = new FakeSerpAcquisitor("google", {
      scripts: {
        "Sunrise watch online": ["rate_limited", "rate_limited", "rate_limited", "rate_limited"],
      },
    });
    const [scan] = await insertManualScans(pool, clock.now, {
      titleGroupId: world.groupId,
      engines: ["google"],
      trigger: "manual",
      createdBy: world.operatorId,
    });
    await runNextScan(executor(pool, clock, fake), "google");
    const failure = await pool.query<{
      reason: string;
      attempts: number;
      attempt_log: Array<{ outcome: string; waitedMs?: number }>;
    }>(
      "select reason, attempts, attempt_log from query_failures where scan_id = $1",
      [scan.id],
    );
    expect(failure.rows).toHaveLength(1);
    expect(failure.rows[0].attempts).toBe(4);
    expect(failure.rows[0].attempt_log.map((entry) => entry.waitedMs)).toEqual([
      60_000,
      300_000,
      900_000,
      undefined,
    ]);
    await pool.end();
  });

  it("disables the engine on an authentication failure and fails the scan", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedWorld(pool, { locales: ["en"] });
    const fake = new FakeSerpAcquisitor("google", {
      scripts: { Sunrise: ["authentication"] },
    });
    const [scan] = await insertManualScans(pool, clock.now, {
      titleGroupId: world.groupId,
      engines: ["google"],
      trigger: "manual",
      createdBy: world.operatorId,
    });
    const outcome = await runNextScan(executor(pool, clock, fake), "google");
    expect(outcome).toEqual({ outcome: "route_unavailable" });

    const failed = await readScan(pool, scan.id);
    expect(failed?.state).toBe("failed");
    expect(failed?.failureReason).toBe("route_unavailable");
    expect(failed?.issuedQueries).toBe(0);

    const route = await readRouteState(pool, "google");
    expect(route.disabled).toBe(true);
    expect(route.disabledReason).toBe("authentication");

    // Nothing was issued, so the reservation released everything.
    const ledger = await readLedger(pool, "google", clock.now);
    expect(ledger.scanCommitted).toBe(0);
    expect(ledger.scanReserved).toBe(0);
    const reservation = await pool.query<{ state: string; released_units: number }>(
      "select state, released_units from budget_reservations where scan_id = $1",
      [scan.id],
    );
    expect(reservation.rows[0]).toMatchObject({ state: "released", released_units: 6 });

    // The schedule marks the day's rows queued with route_unavailable while
    // the route is down, and the picker skips the engine. The failed scan
    // already spent this group's day, so a second group shows the marking.
    const other = await seedExtraGroup(pool, world, {
      name: "Waiting Films",
      priority: "normal",
      titleText: "Moonrise",
    });
    void other;
    clock.advance(15 * 60_000);
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
    const waiting = await pool.query<{ failure_reason: string | null }>(
      `select failure_reason from scans where engine = 'google' and state = 'queued'`,
    );
    expect(waiting.rows.length).toBe(1);
    expect(waiting.rows[0].failure_reason).toBe("route_unavailable");
    // Only the healthy engine's queue is woken.
    expect(dispatches).toEqual(["yandex"]);
    await pool.end();
  });

  it("re-enables the route when the probe sees a balance again", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    // Start empty-handed so the probe's recovery is observable.
    const fake = new FakeSerpAcquisitor("google", { balanceMinor: 0 });
    await pool.query(
      `insert into route_state (engine, disabled, disabled_reason, disabled_at, probe_next_at)
       values ('google', true, 'empty_balance', $1, $1)`,
      [clock.now().toISOString()],
    );
    const empty = await probeRoutes(pool, clock.now, new Map([["google", fake]]));
    expect(empty.reenabled).toEqual([]);
    expect((await readRouteState(pool, "google")).disabled).toBe(true);

    // The provider is topped up: the probe re-enables the route and wakes
    // the queue.
    const topped = new FakeSerpAcquisitor("google", { balanceMinor: 5_000 });
    const dispatches: string[] = [];
    const recovered = await probeRoutes(pool, clock.now, new Map([["google", topped]]));
    expect(recovered.reenabled).toEqual(["google"]);
    expect((await readRouteState(pool, "google")).disabled).toBe(false);
    void dispatches;
    await pool.end();
  });

  it("re-enables a route whose provider exposes no balance, on liveness alone", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    // Yandex's shape: probeBalance can only answer "unavailable", yet the
    // route itself works. Before the liveness probe this combination left
    // the route disabled forever.
    const yandexLike = new FakeSerpAcquisitor("yandex", {
      balanceUnavailable: "yandex cloud exposes no prepaid balance endpoint",
      routeProbe: { outcome: "up" },
    });
    await pool.query(
      `insert into route_state (engine, disabled, disabled_reason, disabled_at, probe_next_at)
       values ('yandex', true, 'authentication', $1, $1)`,
      [clock.now().toISOString()],
    );
    expect(await yandexLike.probeBalance()).toMatchObject({ outcome: "unavailable" });

    const recovered = await probeRoutes(pool, clock.now, new Map([["yandex", yandexLike]]));
    expect(recovered.reenabled).toEqual(["yandex"]);
    expect((await readRouteState(pool, "yandex")).disabled).toBe(false);

    // An auth-down answer keeps the route disabled: recovery is observed,
    // never assumed.
    await disableRoute(pool, clock.now, "yandex", "authentication");
    const refused = new FakeSerpAcquisitor("yandex", {
      balanceUnavailable: "yandex cloud exposes no prepaid balance endpoint",
      routeProbe: { outcome: "auth_down" },
    });
    const still = await probeRoutes(pool, clock.now, new Map([["yandex", refused]]));
    expect(still.reenabled).toEqual([]);
    expect((await readRouteState(pool, "yandex")).disabled).toBe(true);
    await pool.end();
  });
});
