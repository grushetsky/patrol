import type { Pool } from "pg";
import { rungDueAt, utcDate } from "@patrol/domain";

/**
 * The re-check ladder (docs/design/scan-scheduling.md "The re-check
 * ladder"; ADR 0022): rungs fall due 3, 7, and 14 days after the scan
 * that anchors the ladder, then every 14 days for as long as any
 * violation from the pair is open. The ladder is keyed by (title group,
 * engine) because a scan targets exactly that pair, and a re-check
 * reissues the whole query plan of the scan that found the violations.
 *
 * The two decisions that depend on violations are pluggable predicates,
 * the same shape as the catalogue's merge guards: `shouldStart` answers
 * whether a completed scan produced the pair's first confirmed violation
 * (slice 5 wires the query), and `shouldContinue` answers whether any
 * violation from the pair is still open. Until slice 5 the defaults see
 * no violations — nothing can be open — so ladders stop after rung three
 * and no scan starts one; the wiring around the predicates is complete
 * and tested with injected ones.
 */

/** The decisions about violations the ladder defers to its caller. */
export interface LadderPredicates {
  /** Whether the scan that just completed starts the pair's ladder. */
  shouldStart(input: {
    titleGroupId: string;
    engine: "google" | "bing" | "yandex";
    scanId: string;
  }): Promise<boolean>;
  /** Whether any violation from the pair is still open. */
  shouldContinue(input: {
    titleGroupId: string;
    engine: "google" | "bing" | "yandex";
  }): Promise<boolean>;
}

/** The defaults until slice 5's violation lifecycle lands. */
export const noViolationsPredicates: LadderPredicates = {
  async shouldStart() {
    return false;
  },
  async shouldContinue() {
    return false;
  },
};

/** One ladder row. */
export interface LadderRow {
  id: string;
  titleGroupId: string;
  engine: "google" | "bing" | "yandex";
  rung: number;
  nextDueAt: Date;
  active: boolean;
  anchoredScanId: string;
}

/** The pair's ladder, or null when none stands. */
export async function readLadder(
  pool: Pool,
  input: { titleGroupId: string; engine: "google" | "bing" | "yandex" },
): Promise<LadderRow | null> {
  const result = await pool.query<{
    id: string;
    title_group_id: string;
    engine: string;
    rung: number;
    next_due_at: Date;
    active: boolean;
    anchored_scan_id: string;
  }>(
    "select id, title_group_id, engine, rung, next_due_at, active, anchored_scan_id from recheck_schedules where title_group_id = $1 and engine = $2",
    [input.titleGroupId, input.engine],
  );
  if (result.rows.length === 0) {
    return null;
  }
  const row = result.rows[0];
  return {
    id: row.id,
    titleGroupId: row.title_group_id,
    engine: row.engine as LadderRow["engine"],
    rung: Number(row.rung),
    nextDueAt: new Date(row.next_due_at),
    active: row.active,
    anchoredScanId: row.anchored_scan_id,
  };
}

/** The anchor scan's completion time, the date rungs measure from. */
async function anchorCompletedAt(
  pool: Pool,
  anchoredScanId: string,
  now: () => Date,
): Promise<Date> {
  const result = await pool.query<{ finished_at: Date | null; created_at: Date }>(
    "select finished_at, created_at from scans where id = $1",
    [anchoredScanId],
  );
  const row = result.rows[0];
  return new Date(row?.finished_at ?? row?.created_at ?? now());
}

/**
 * What a completed scan does to the pair's ladder:
 *
 * - A manual scan or manual re-check RESETS a standing ladder to rung one,
 *   anchored at the manual run — the intent of a manual check is "look
 *   again soon", and a ladder that ignored it would schedule the next look
 *   up to eleven days later.
 * - Any other scan whose completion served a rung that was due ADVANCES
 *   the ladder: rung two at +7, rung three at +14, then +14 per rung while
 *   `shouldContinue` holds. When it does not — no violation from the pair
 *   is open, whatever the rung — the ladder stops and the pair returns to
 *   its ordinary scan cadence.
 * - A scan that starts the pair's first ladder (`shouldStart`) creates it
 *   at rung one, due three days after the scan.
 */
export async function onScanCompleted(
  pool: Pool,
  now: () => Date,
  predicates: LadderPredicates,
  input: {
    scanId: string;
    titleGroupId: string;
    engine: "google" | "bing" | "yandex";
    trigger: "scheduled" | "manual" | "recheck" | "manual_recheck";
    finishedAt: Date;
    dueDate: string;
  },
): Promise<void> {
  const standing = await readLadder(pool, input);
  const pair = { titleGroupId: input.titleGroupId, engine: input.engine };

  if (standing === null) {
    if (input.trigger === "manual_recheck") {
      // An operator asked to re-check a pair under no ladder: starting one
      // anchored at the manual run is what the request means.
      await upsertLadder(pool, now, {
        ...pair,
        rung: 1,
        nextDueAt: rungDueAt(input.finishedAt, 1),
        anchoredScanId: input.scanId,
        active: true,
      });
      return;
    }
    if (await predicates.shouldStart({ ...pair, scanId: input.scanId })) {
      await upsertLadder(pool, now, {
        ...pair,
        rung: 1,
        nextDueAt: rungDueAt(input.finishedAt, 1),
        anchoredScanId: input.scanId,
        active: true,
      });
    }
    return;
  }

  if (input.trigger === "manual" || input.trigger === "manual_recheck") {
    await upsertLadder(pool, now, {
      ...pair,
      rung: 1,
      nextDueAt: rungDueAt(input.finishedAt, 1),
      anchoredScanId: input.scanId,
      active: true,
    });
    return;
  }

  if (!standing.active) {
    return;
  }
  // The completion served a rung only when the ladder was due on or
  // before the scan's own due date; otherwise the ordinary cadence ran and
  // the ladder keeps its place.
  if (utcDate(standing.nextDueAt) > input.dueDate) {
    return;
  }
  const nextRung = standing.rung + 1;
  const anchorAt = await anchorCompletedAt(pool, standing.anchoredScanId, now);
  // "When no violation from that pair is Open — every one is Removed or
  // Closed — the ladder stops, and the pair returns to its ordinary scan
  // cadence" (scan-scheduling.md "The re-check ladder", End). The rule
  // names no rung, so it is evaluated on every advance: a violation that
  // closed before even the rung-two re-check stops the ladder there rather
  // than observing a closed violation two more times.
  if (!(await predicates.shouldContinue(pair))) {
    await upsertLadder(pool, now, {
      ...pair,
      rung: standing.rung,
      nextDueAt: standing.nextDueAt,
      anchoredScanId: standing.anchoredScanId,
      active: false,
    });
    return;
  }
  await upsertLadder(pool, now, {
    ...pair,
    rung: nextRung,
    nextDueAt: rungDueAt(anchorAt, nextRung),
    anchoredScanId: standing.anchoredScanId,
    active: true,
  });
}

/** Writes a ladder row: insert or update on the pair's unique key. */
async function upsertLadder(
  pool: Pool,
  now: () => Date,
  row: {
    titleGroupId: string;
    engine: "google" | "bing" | "yandex";
    rung: number;
    nextDueAt: Date;
    active: boolean;
    anchoredScanId: string;
  },
): Promise<void> {
  await pool.query(
    `insert into recheck_schedules
       (title_group_id, engine, rung, next_due_at, active, anchored_scan_id, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (title_group_id, engine) do update
       set rung = excluded.rung,
           next_due_at = excluded.next_due_at,
           active = excluded.active,
           anchored_scan_id = excluded.anchored_scan_id,
           updated_at = excluded.updated_at`,
    [
      row.titleGroupId,
      row.engine,
      row.rung,
      row.nextDueAt.toISOString(),
      row.active,
      row.anchoredScanId,
      now().toISOString(),
    ],
  );
}

/**
 * Resets a pair's ladder at a manual request, anchored at the scan the
 * request found or created. The API calls this so an idempotent same-day
 * manual request — one that returned the day's standing scan and so will
 * never fire a completion — still means "look again soon". An ordinary
 * manual scan resets only a standing ladder; a manual re-check starts one
 * when none stands, exactly as the completion path does.
 */
export async function resetLadderForManualRequest(
  pool: Pool,
  now: () => Date,
  input: {
    titleGroupId: string;
    engine: "google" | "bing" | "yandex";
    trigger: "manual" | "manual_recheck";
    anchorScanId: string;
    anchorFinishedAt: Date | null;
  },
): Promise<void> {
  const standing = await readLadder(pool, input);
  if (standing === null && input.trigger === "manual") {
    return;
  }
  await upsertLadder(pool, now, {
    titleGroupId: input.titleGroupId,
    engine: input.engine,
    rung: 1,
    nextDueAt: rungDueAt(input.anchorFinishedAt ?? now(), 1),
    active: true,
    anchoredScanId: input.anchorScanId,
  });
}
