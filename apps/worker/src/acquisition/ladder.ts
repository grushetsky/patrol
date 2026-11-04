import { v7 as uuidv7 } from "uuid";
import type { Queryable } from "../db.js";

export interface LadderUpdate {
  titleGroupId: string;
  engine: string;
  trigger: string;
  scanId: string;
  finishedAt: Date;
}

/** Start, advance, or stop the re-check ladder after a scan finishes. */
export async function updateLadderAfterScan(
  db: Queryable,
  input: LadderUpdate,
): Promise<void> {
  const hasOpen = (
    await db.query(
      "SELECT id FROM violation WHERE title_group_id = $1 AND engine = $2 AND state = 'open' LIMIT 1",
      [input.titleGroupId, input.engine],
    )
  ).rows.length > 0;
  const existing = (
    await db.query(
      "SELECT * FROM recheck_schedule WHERE title_group_id = $1 AND engine = $2",
      [input.titleGroupId, input.engine],
    )
  ).rows[0];
  const manual = input.trigger === "manual" || input.trigger === "manual_recheck";

  if (manual) {
    if (!hasOpen) {
      if (existing?.active) {
        await stop(db, input);
      }
      return;
    }
    await writeLadder(db, {
      titleGroupId: input.titleGroupId,
      engine: input.engine,
      rung: 1,
      startedAt: input.finishedAt,
      nextDueAt: addDays(input.finishedAt, 3),
      scanId: input.scanId,
      now: input.finishedAt,
      existing: existing !== undefined,
    });
    return;
  }

  if (input.trigger === "recheck") {
    if (!existing) {
      if (hasOpen) {
        await writeLadder(db, {
          titleGroupId: input.titleGroupId,
          engine: input.engine,
          rung: 1,
          startedAt: input.finishedAt,
          nextDueAt: addDays(input.finishedAt, 3),
          scanId: input.scanId,
          now: input.finishedAt,
          existing: false,
        });
      }
      return;
    }
    if (!hasOpen) {
      await stop(db, input);
      return;
    }
    const rung = Number(existing.rung);
    const startedAt = new Date(String(existing.started_at));
    const nextDueAt =
      rung === 1
        ? addDays(startedAt, 7)
        : rung === 2
          ? addDays(startedAt, 14)
          : addDays(new Date(String(existing.next_due_at)), 14);
    await writeLadder(db, {
      titleGroupId: input.titleGroupId,
      engine: input.engine,
      rung: rung + 1,
      startedAt,
      nextDueAt,
      scanId: String(existing.started_by_scan_id ?? input.scanId),
      now: input.finishedAt,
      existing: true,
    });
    return;
  }

  if (!hasOpen && existing?.active) {
    await stop(db, input);
    return;
  }
  if (hasOpen && (!existing || !existing.active)) {
    await writeLadder(db, {
      titleGroupId: input.titleGroupId,
      engine: input.engine,
      rung: 1,
      startedAt: input.finishedAt,
      nextDueAt: addDays(input.finishedAt, 3),
      scanId: input.scanId,
      now: input.finishedAt,
      existing: existing !== undefined,
    });
  }
}

async function stop(db: Queryable, input: LadderUpdate): Promise<void> {
  await db.query(
    "UPDATE recheck_schedule SET active = false, updated_at = $3 WHERE title_group_id = $1 AND engine = $2",
    [input.titleGroupId, input.engine, input.finishedAt],
  );
}

async function writeLadder(
  db: Queryable,
  input: {
    titleGroupId: string;
    engine: string;
    rung: number;
    startedAt: Date;
    nextDueAt: Date;
    scanId: string;
    now: Date;
    existing: boolean;
  },
): Promise<void> {
  if (input.existing) {
    await db.query(
      `UPDATE recheck_schedule
          SET rung = $3, started_at = $4, next_due_at = $5, active = true,
              started_by_scan_id = $6, updated_at = $7
        WHERE title_group_id = $1 AND engine = $2`,
      [
        input.titleGroupId,
        input.engine,
        input.rung,
        input.startedAt,
        input.nextDueAt,
        input.scanId,
        input.now,
      ],
    );
    return;
  }
  await db.query(
    `INSERT INTO recheck_schedule
      (id, title_group_id, engine, rung, started_at, next_due_at, active,
       started_by_scan_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8)`,
    [
      uuidv7(),
      input.titleGroupId,
      input.engine,
      input.rung,
      input.startedAt,
      input.nextDueAt,
      input.scanId,
      input.now,
    ],
  );
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
