import { beforeEach, describe, expect, it } from "vitest";
import { queuedScanOrder } from "@patrol/scans";
import {
  controlledClock,
  seedExtraGroup,
  seedWorld,
  testPool,
  truncateDomainTables,
} from "./helpers.js";

/**
 * Seam 6: the engine queue's dequeue order over seeded queue states —
 * manual work by request order, then re-checks, then scheduled work by
 * priority and least-recently-scanned
 * (docs/design/scan-scheduling.md "Order of work"). A pair holds at most
 * one scan a day, so the historical scans that set each group's
 * last-scan time sit on earlier days.
 */

describe("the engine queue's dequeue order", () => {
  beforeEach(async () => {
    const pool = testPool();
    try {
      await truncateDomainTables(pool);
    } finally {
      await pool.end();
    }
  });

  it("orders manual, recheck, and scheduled work as the design fixes it", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const main = await seedWorld(pool, { locales: ["en"], priority: "normal" });
    const group = async (name: string, priority: "high" | "normal" | "low") =>
      (
        await seedExtraGroup(pool, main, {
          name, priority, titleText: `${name} Film`,
        })
      ).groupId;
    const manualFirst = await group("Manual First", "low");
    const manualSecond = await group("Manual Second", "high");
    const recheck = await group("Recheck", "low");
    const high = await group("High", "high");
    const lowStale = await group("Low Stale", "low");
    const lowFresh = await group("Low Fresh", "low");

    const base = clock.now().getTime();
    const at = (minutes: number): string =>
      new Date(base + minutes * 60_000).toISOString();

    // One queued scan for today, per pair.
    const queueToday = async (groupId: string, trigger: string, minutes: number) => {
      await pool.query(
        `insert into scans (title_group_id, engine, due_date, trigger_kind, scan_time, created_at)
         values ($1, 'google', '2026-03-02', $2, '02:30', $3)`,
        [groupId, trigger, at(minutes)],
      );
    };
    // One finished scan on an earlier day, which sets last-scan time.
    const finishedEarlier = async (groupId: string, iso: string) => {
      await pool.query(
        `insert into scans (title_group_id, engine, due_date, trigger_kind, scan_time, created_at,
                            state, started_at, finished_at)
         values ($1, 'google', $2::date, 'scheduled', '02:30', $2, 'succeeded', $3, $3)`,
        [groupId, iso.slice(0, 10), iso],
      );
    };

    await finishedEarlier(lowStale, "2026-02-01T03:00:00.000Z");
    await finishedEarlier(lowFresh, "2026-03-01T23:00:00.000Z");

    await queueToday(lowStale, "scheduled", 0);
    await queueToday(lowFresh, "scheduled", 1);
    await queueToday(high, "scheduled", 2);
    await queueToday(main.groupId, "scheduled", 3);
    await queueToday(recheck, "recheck", 4);
    await queueToday(manualFirst, "manual", 5);
    await queueToday(manualSecond, "manual", 6);
    // A scan for another engine never enters this queue.
    await pool.query(
      `insert into scans (title_group_id, engine, due_date, trigger_kind, scan_time, created_at)
       values ($1, 'yandex', '2026-03-02', 'manual', '02:30', $2)`,
      [main.groupId, at(1)],
    );

    const order = await queuedScanOrder(pool, "google");
    const groups = await Promise.all(
      order.map(async (entry) => {
        const row = await pool.query<{ title_group_id: string }>(
          "select title_group_id from scans where id = $1",
          [entry.scanId],
        );
        return row.rows[0].title_group_id;
      }),
    );
    expect(groups).toEqual([
      manualFirst, // manual, request order first (minute 5)
      manualSecond, // manual, requested second (minute 6)
      recheck, // recheck, after manual work and before scheduled
      high, // scheduled, high priority
      main.groupId, // scheduled, normal priority
      lowStale, // scheduled low, scanned a month ago
      lowFresh, // scheduled low, scanned last night
    ]);
    await pool.end();
  });
});
