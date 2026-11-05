import { beforeEach, describe, expect, it } from "vitest";
import { onScanCompleted, readLadder, resetLadderForManualRequest, type LadderPredicates } from "@patrol/scans";
import {
  controlledClock,
  seedExtraGroup,
  seedWorld,
  testPool,
  truncateDomainTables,
} from "./helpers.js";

/**
 * Seam 7: the re-check ladder — 3, 7, and 14 days after the anchoring
 * scan, then every 14 days while the open-violation predicate holds;
 * stop when it does not; a manual run resets to rung one at +3 days
 * (docs/design/scan-scheduling.md "The re-check ladder"). The violation
 * predicates are injected, exactly as slice 5 will wire the real queries.
 */

const alwaysStart: LadderPredicates = {
  async shouldStart() {
    return true;
  },
  async shouldContinue() {
    return true;
  },
};

const neverContinue: LadderPredicates = {
  async shouldStart() {
    return true;
  },
  async shouldContinue() {
    return false;
  },
};

/** Inserts one scan row and returns its id. */
async function insertScan(
  pool: ReturnType<typeof testPool>,
  input: {
    groupId: string;
    trigger: string;
    day: string;
    state?: string;
    finishedAt?: string;
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into scans (title_group_id, engine, due_date, trigger_kind, scan_time, created_at,
                        state, started_at, finished_at)
     values ($1, 'google', $2::date, $3, '02:30', $2, $4, $5, $5)
     returning id`,
    [
      input.groupId,
      input.day,
      input.trigger,
      input.state ?? "succeeded",
      input.finishedAt ?? `${input.day}T03:00:00.000Z`,
    ],
  );
  return result.rows[0].id;
}

describe("the re-check ladder", () => {
  beforeEach(async () => {
    const pool = testPool();
    try {
      await truncateDomainTables(pool);
    } finally {
      await pool.end();
    }
  });

  it("walks 3, 7, 14, then every 14 days while the predicate holds", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T03:00:00.000Z");
    const world = await seedWorld(pool, { locales: ["en"] });

    const anchor = await insertScan(pool, {
      groupId: world.groupId, trigger: "scheduled", day: "2026-03-01",
    });
    await onScanCompleted(pool, clock.now, alwaysStart, {
      scanId: anchor,
      titleGroupId: world.groupId,
      engine: "google",
      trigger: "scheduled",
      finishedAt: new Date("2026-03-01T03:00:00.000Z"),
      dueDate: "2026-03-01",
    });
    let ladder = await readLadder(pool, { titleGroupId: world.groupId, engine: "google" });
    expect(ladder).toMatchObject({
      rung: 1,
      active: true,
      anchoredScanId: anchor,
    });
    expect(ladder?.nextDueAt.toISOString()).toBe("2026-03-04T03:00:00.000Z");

    // The rung-one re-check runs on its due day: rung two falls at +7.
    const rung1 = await insertScan(pool, {
      groupId: world.groupId, trigger: "recheck", day: "2026-03-04",
    });
    await onScanCompleted(pool, clock.now, alwaysStart, {
      scanId: rung1,
      titleGroupId: world.groupId,
      engine: "google",
      trigger: "recheck",
      finishedAt: new Date("2026-03-04T03:00:00.000Z"),
      dueDate: "2026-03-04",
    });
    ladder = await readLadder(pool, { titleGroupId: world.groupId, engine: "google" });
    expect(ladder?.rung).toBe(2);
    expect(ladder?.nextDueAt.toISOString()).toBe("2026-03-08T03:00:00.000Z");

    const rung2 = await insertScan(pool, {
      groupId: world.groupId, trigger: "recheck", day: "2026-03-08",
    });
    await onScanCompleted(pool, clock.now, alwaysStart, {
      scanId: rung2,
      titleGroupId: world.groupId,
      engine: "google",
      trigger: "recheck",
      finishedAt: new Date("2026-03-08T03:00:00.000Z"),
      dueDate: "2026-03-08",
    });
    ladder = await readLadder(pool, { titleGroupId: world.groupId, engine: "google" });
    expect(ladder?.rung).toBe(3);
    expect(ladder?.nextDueAt.toISOString()).toBe("2026-03-15T03:00:00.000Z");

    const rung3 = await insertScan(pool, {
      groupId: world.groupId, trigger: "recheck", day: "2026-03-15",
    });
    await onScanCompleted(pool, clock.now, alwaysStart, {
      scanId: rung3,
      titleGroupId: world.groupId,
      engine: "google",
      trigger: "recheck",
      finishedAt: new Date("2026-03-15T03:00:00.000Z"),
      dueDate: "2026-03-15",
    });
    ladder = await readLadder(pool, { titleGroupId: world.groupId, engine: "google" });
    expect(ladder?.rung).toBe(4);
    expect(ladder?.nextDueAt.toISOString()).toBe("2026-03-29T03:00:00.000Z");
    await pool.end();
  });

  it("stops when no violation from the pair is open", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T03:00:00.000Z");
    const world = await seedWorld(pool, { locales: ["en"] });
    const anchor = await insertScan(pool, {
      groupId: world.groupId, trigger: "scheduled", day: "2026-03-01",
    });
    await onScanCompleted(pool, clock.now, alwaysStart, {
      scanId: anchor,
      titleGroupId: world.groupId,
      engine: "google",
      trigger: "scheduled",
      finishedAt: new Date("2026-03-01T03:00:00.000Z"),
      dueDate: "2026-03-01",
    });
    for (const [day, expectedRung] of [
      ["2026-03-04", 2],
      ["2026-03-08", 3],
    ] as const) {
      const scan = await insertScan(pool, {
        groupId: world.groupId, trigger: "recheck", day,
      });
      await onScanCompleted(pool, clock.now, alwaysStart, {
        scanId: scan,
        titleGroupId: world.groupId,
        engine: "google",
        trigger: "recheck",
        finishedAt: new Date(`${day}T03:00:00.000Z`),
        dueDate: day,
      });
    }
    // Rung three completes and no violation is open: the ladder stops.
    const rung3 = await insertScan(pool, {
      groupId: world.groupId, trigger: "recheck", day: "2026-03-15",
    });
    await onScanCompleted(pool, clock.now, neverContinue, {
      scanId: rung3,
      titleGroupId: world.groupId,
      engine: "google",
      trigger: "recheck",
      finishedAt: new Date("2026-03-15T03:00:00.000Z"),
      dueDate: "2026-03-15",
    });
    const ladder = await readLadder(pool, { titleGroupId: world.groupId, engine: "google" });
    expect(ladder?.active).toBe(false);
    expect(ladder?.rung).toBe(3);
    await pool.end();
  });

  it("stops at any rung when no violation is open, not only after rung three", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T03:00:00.000Z");
    const world = await seedWorld(pool, { locales: ["en"] });
    const anchor = await insertScan(pool, {
      groupId: world.groupId, trigger: "scheduled", day: "2026-03-01",
    });
    await onScanCompleted(pool, clock.now, alwaysStart, {
      scanId: anchor,
      titleGroupId: world.groupId,
      engine: "google",
      trigger: "scheduled",
      finishedAt: new Date("2026-03-01T03:00:00.000Z"),
      dueDate: "2026-03-01",
    });
    // The violation closed before even the rung-two re-check: "when no
    // violation from that pair is Open ... the ladder stops" names no
    // rung, so the pair returns to its ordinary cadence right here.
    const rung1 = await insertScan(pool, {
      groupId: world.groupId, trigger: "recheck", day: "2026-03-04",
    });
    await onScanCompleted(pool, clock.now, neverContinue, {
      scanId: rung1,
      titleGroupId: world.groupId,
      engine: "google",
      trigger: "recheck",
      finishedAt: new Date("2026-03-04T03:00:00.000Z"),
      dueDate: "2026-03-04",
    });
    const ladder = await readLadder(pool, { titleGroupId: world.groupId, engine: "google" });
    expect(ladder?.active).toBe(false);
    expect(ladder?.rung).toBe(1);
    await pool.end();
  });

  it("resets to rung one three days after a manual run", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-20T03:00:00.000Z");
    const world = await seedWorld(pool, { locales: ["en"] });
    const anchor = await insertScan(pool, {
      groupId: world.groupId, trigger: "scheduled", day: "2026-03-01",
    });
    await onScanCompleted(pool, clock.now, alwaysStart, {
      scanId: anchor,
      titleGroupId: world.groupId,
      engine: "google",
      trigger: "scheduled",
      finishedAt: new Date("2026-03-01T03:00:00.000Z"),
      dueDate: "2026-03-01",
    });
    // The ladder is deep into its rungs by now.
    for (const day of ["2026-03-04", "2026-03-08", "2026-03-15"]) {
      const scan = await insertScan(pool, {
        groupId: world.groupId, trigger: "recheck", day,
      });
      await onScanCompleted(pool, clock.now, alwaysStart, {
        scanId: scan,
        titleGroupId: world.groupId,
        engine: "google",
        trigger: "recheck",
        finishedAt: new Date(`${day}T03:00:00.000Z`),
        dueDate: day,
      });
    }

    // An operator's manual scan resets the ladder to rung one at +3 days.
    const manual = await insertScan(pool, {
      groupId: world.groupId, trigger: "manual", day: "2026-03-20",
    });
    await onScanCompleted(pool, clock.now, alwaysStart, {
      scanId: manual,
      titleGroupId: world.groupId,
      engine: "google",
      trigger: "manual",
      finishedAt: new Date("2026-03-20T03:00:00.000Z"),
      dueDate: "2026-03-20",
    });
    let ladder = await readLadder(pool, { titleGroupId: world.groupId, engine: "google" });
    expect(ladder).toMatchObject({ rung: 1, active: true, anchoredScanId: manual });
    expect(ladder?.nextDueAt.toISOString()).toBe("2026-03-23T03:00:00.000Z");

    // The API's idempotent path resets the same way, anchored at the
    // standing scan.
    await resetLadderForManualRequest(pool, clock.now, {
      titleGroupId: world.groupId,
      engine: "google",
      trigger: "manual_recheck",
      anchorScanId: manual,
      anchorFinishedAt: new Date("2026-03-20T03:00:00.000Z"),
    });
    ladder = await readLadder(pool, { titleGroupId: world.groupId, engine: "google" });
    expect(ladder?.rung).toBe(1);
    expect(ladder?.nextDueAt.toISOString()).toBe("2026-03-23T03:00:00.000Z");
    await pool.end();
  });

  it("starts no ladder while no violation can exist", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T03:00:00.000Z");
    const world = await seedWorld(pool, { locales: ["en"] });
    const other = await seedExtraGroup(pool, world, {
      name: "No Ladder", priority: "normal", titleText: "Quiet Film",
    });
    const scan = await insertScan(pool, {
      groupId: other.groupId, trigger: "scheduled", day: "2026-03-02",
    });
    // The shipped defaults: no violations exist, so nothing starts.
    const shippedDefaults: LadderPredicates = {
      async shouldStart() {
        return false;
      },
      async shouldContinue() {
        return false;
      },
    };
    await onScanCompleted(pool, clock.now, shippedDefaults, {
      scanId: scan,
      titleGroupId: other.groupId,
      engine: "google",
      trigger: "scheduled",
      finishedAt: new Date("2026-03-02T03:00:00.000Z"),
      dueDate: "2026-03-02",
    });
    const ladder = await readLadder(pool, { titleGroupId: other.groupId, engine: "google" });
    expect(ladder).toBeNull();
    await pool.end();
  });
});
