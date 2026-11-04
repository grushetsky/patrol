import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { controlledClock } from "../test-app.js";
import { testPool } from "./helpers.js";
import {
  commitReservation,
  ensureMonth,
  expireReservations,
  monthStartOf,
  releaseReservation,
  reserve,
  type ReserveResult,
} from "../../src/domain/budget/ledger.js";
import { rollOverMonth } from "../../src/domain/budget/rollover.js";

/**
 * Seams 1 through 6 and 8 of the budget core (slice 3a): the month row and
 * its allowance snapshot, the one-transaction reservation with the
 * concurrency proof, commit semantics including the partial scan and the
 * settlement across a month boundary, release and its refusals, the
 * one-hour expiry sweep, the monthly rollover, and the live-cap spend
 * authority — a lowered cap refuses without un-spending, a raised one
 * unblocks.
 *
 * Each scenario works on its own UTC month (the expiry sweep is global, so
 * every hold is settled before its test ends) and every hold the tests
 * leave standing is consistent with the counters they assert.
 */
describe("budget ledger", () => {
  const pool: Pool = testPool();
  const clock = controlledClock("2026-03-15T12:00:00.000Z");

  beforeAll(async () => {
    await pool.query(
      "insert into rights_holder (legal_name, country) values ('Ledger Test GmbH', 'DE')",
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Points the clock at a fresh month with a $0.60 Google cap, which
   * buys 1,000 units split 700/30 percent into 700 and 300, and opens the
   * engine's month row. */
  async function freshMonth(
    engine: "google" | "yandex",
    iso: string,
    googleCapMinor = 60,
  ): Promise<void> {
    clock.set(iso);
    await pool.query(
      "update rights_holder set budget_google_monthly_cap_minor = $1, budget_yandex_monthly_cap_minor = $2",
      [googleCapMinor, 25],
    );
    await ensureMonth(pool, engine, monthStartOf(clock.now()));
  }

  /** Reserves or throws — the setup variant of reserve for readable tests. */
  async function hold(input: Parameters<typeof reserve>[2]): Promise<string> {
    const result = await reserve(pool, clock.now, input);
    if (result.outcome !== "reserved") {
      throw new Error(`setup reserve failed: ${result.outcome}`);
    }
    return result.reservation.id;
  }

  async function ledgerRow(
    engine: string,
    monthStart: string,
  ): Promise<{
    allowance_units: number;
    scan_reserved: number;
    scan_committed: number;
    recheck_reserved: number;
    recheck_committed: number;
  }> {
    const result = await pool.query(
      "select allowance_units, scan_reserved, scan_committed, recheck_reserved, recheck_committed from quota_ledger where engine = $1 and month_start = $2",
      [engine, monthStart],
    );
    return result.rows[0];
  }

  async function reservationRow(id: string): Promise<{
    state: string;
    units: number;
    committed_units: number | null;
    released_units: number | null;
    month_start: string;
    expires_at: Date;
  }> {
    const result = await pool.query(
      "select state, units, committed_units, released_units, month_start::text as month_start, expires_at from budget_reservations where id = $1",
      [id],
    );
    return result.rows[0];
  }

  // -----------------------------------------------------------------
  // Seam 1: ensure-month.

  it("creates exactly one month row with the allowance the settings then bought", async () => {
    await freshMonth("yandex", "2026-03-15T08:00:00.000Z");
    // $0.25 buys 1,000 Yandex requests.
    expect(await ledgerRow("yandex", "2026-03-01")).toMatchObject({
      allowance_units: 1_000,
      scan_reserved: 0,
      scan_committed: 0,
      recheck_reserved: 0,
      recheck_committed: 0,
    });

    await ensureMonth(pool, "yandex", "2026-03-01");
    const count = await pool.query(
      "select count(*) as count from quota_ledger where engine = 'yandex' and month_start = '2026-03-01'",
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it("keeps the allowance snapshot when settings change mid-month", async () => {
    await pool.query(
      "update rights_holder set budget_yandex_monthly_cap_minor = 2500",
    );
    await ensureMonth(pool, "yandex", "2026-03-01");
    // The row was opened at $0.25; raising the cap to $25.00 does not
    // rewrite the month that already opened.
    expect((await ledgerRow("yandex", "2026-03-01")).allowance_units).toBe(1_000);
  });

  // -----------------------------------------------------------------
  // Seam 2: reservation.

  it("reserves units in one transaction and holds them for one hour", async () => {
    await freshMonth("google", "2026-04-10T06:00:00.000Z");
    const result = await reserve(pool, clock.now, {
      engine: "google",
      bucket: "scan",
      units: 120,
    });
    if (result.outcome !== "reserved") {
      throw new Error(`expected a reservation, got ${result.outcome}`);
    }
    expect(result.reservation).toMatchObject({
      engine: "google",
      monthStart: "2026-04-01",
      bucket: "scan",
      units: 120,
      state: "held",
    });
    expect(
      result.reservation.expiresAt.getTime() -
        result.reservation.createdAt.getTime(),
    ).toBe(3_600_000);
    expect(await ledgerRow("google", "2026-04-01")).toMatchObject({
      scan_reserved: 120,
      scan_committed: 0,
    });
    await commitReservation(pool, clock.now, result.reservation.id, 120);
  });

  it("refuses a plan that does not fit its bucket without spending", async () => {
    await freshMonth("google", "2026-05-10T06:00:00.000Z");
    const refused = await reserve(pool, clock.now, {
      engine: "google",
      bucket: "scan",
      units: 701,
    });
    expect(refused).toMatchObject({
      outcome: "budget_exhausted",
      engine: "google",
      bucket: "scan",
      shareUnits: 700,
      remainingUnits: 700,
    });
    expect(await ledgerRow("google", "2026-05-01")).toMatchObject({
      scan_reserved: 0,
      scan_committed: 0,
    });
    const reservations = await pool.query(
      "select count(*) as count from budget_reservations where engine = 'google' and month_start = '2026-05-01'",
    );
    expect(Number(reservations.rows[0].count)).toBe(0);

    // Bing is deferred: no route is bought, so nothing fits.
    const bing = await reserve(pool, clock.now, {
      engine: "bing",
      bucket: "scan",
      units: 1,
    });
    expect(bing.outcome).toBe("budget_exhausted");
  });

  it("lets exactly one of two concurrent reservations take the fitting units", async () => {
    await freshMonth("google", "2026-06-10T06:00:00.000Z");
    // Each 400-unit plan alone fits the 700 share; together they do not.
    // Two real parallel transactions on the test database compete for the
    // same row; the conditional update must let exactly one through.
    const [first, second] = await Promise.all([
      reserve(pool, clock.now, { engine: "google", bucket: "scan", units: 400 }),
      reserve(pool, clock.now, { engine: "google", bucket: "scan", units: 400 }),
    ]);
    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["budget_exhausted", "reserved"]);
    expect(await ledgerRow("google", "2026-06-01")).toMatchObject({
      scan_reserved: 400,
    });

    // The last-unit race: with 650 committed, two 30-unit holds compete
    // for the share's final fifty.
    const winner = [first, second].find(
      (result): result is Extract<ReserveResult, { outcome: "reserved" }> =>
        result.outcome === "reserved",
    );
    if (winner === undefined) {
      throw new Error("the race produced no winner");
    }
    await releaseReservation(pool, clock.now, winner.reservation.id);
    await pool.query(
      "update quota_ledger set scan_committed = 650 where engine = 'google' and month_start = '2026-06-01'",
    );
    const [third, fourth] = await Promise.all([
      reserve(pool, clock.now, { engine: "google", bucket: "scan", units: 30 }),
      reserve(pool, clock.now, { engine: "google", bucket: "scan", units: 30 }),
    ]);
    expect(
      [third.outcome, fourth.outcome].sort(),
    ).toEqual(["budget_exhausted", "reserved"]);
    const lastWinner = [third, fourth].find(
      (result): result is Extract<ReserveResult, { outcome: "reserved" }> =>
        result.outcome === "reserved",
    );
    if (lastWinner === undefined) {
      throw new Error("the last-unit race produced no winner");
    }
    await releaseReservation(pool, clock.now, lastWinner.reservation.id);
    await pool.query(
      "update quota_ledger set scan_committed = 0 where engine = 'google' and month_start = '2026-06-01'",
    );
  });

  it("keeps the re-check bucket separate and never borrowable", async () => {
    await freshMonth("google", "2026-07-10T06:00:00.000Z");
    // The scan share is spent to its last unit...
    const filled = await hold({
      engine: "google",
      bucket: "scan",
      units: 700,
    });

    // ...while the re-check bucket still funds re-checks.
    const recheck = await hold({
      engine: "google",
      bucket: "recheck",
      units: 300,
    });

    // The scan bucket stays blocked even though re-check funds remain:
    // the share is not borrowable.
    const blocked = await reserve(pool, clock.now, {
      engine: "google",
      bucket: "scan",
      units: 1,
    });
    expect(blocked.outcome).toBe("budget_exhausted");
    if (blocked.outcome === "budget_exhausted") {
      expect(blocked.shareUnits).toBe(700);
      expect(blocked.usedUnits).toBe(700);
    }
    await releaseReservation(pool, clock.now, filled);
    await releaseReservation(pool, clock.now, recheck);
  });

  // -----------------------------------------------------------------
  // Seam 3: commit.

  it("commits an exact reservation and moves the counters", async () => {
    await freshMonth("google", "2026-08-10T06:00:00.000Z");
    const held = await hold({ engine: "google", bucket: "scan", units: 10 });
    const committed = await commitReservation(pool, clock.now, held, 10);
    expect(committed).toMatchObject({
      state: "committed",
      committedUnits: 10,
      releasedUnits: 0,
    });
    expect(await ledgerRow("google", "2026-08-01")).toMatchObject({
      scan_reserved: 0,
      scan_committed: 10,
    });
  });

  it("commits what a partial scan issued and releases the rest", async () => {
    await freshMonth("google", "2026-09-10T06:00:00.000Z", 61);
    // $0.61 buys 1,016 units; the scan share is floor(1,016 * 0.7) = 711.
    const held = await hold({ engine: "google", bucket: "scan", units: 10 });
    const partial = await commitReservation(pool, clock.now, held, 7);
    expect(partial).toMatchObject({
      state: "committed",
      committedUnits: 7,
      releasedUnits: 3,
      settledAt: clock.now(),
    });
    expect(await ledgerRow("google", "2026-09-01")).toMatchObject({
      scan_reserved: 0,
      scan_committed: 7,
    });

    // A scan that issued nothing commits zero and releases everything.
    const empty = await hold({ engine: "google", bucket: "scan", units: 5 });
    const emptyCommit = await commitReservation(pool, clock.now, empty, 0);
    expect(emptyCommit).toMatchObject({
      state: "committed",
      committedUnits: 0,
      releasedUnits: 5,
    });
  });

  it("refuses to commit more units than were reserved", async () => {
    await freshMonth("google", "2026-10-10T06:00:00.000Z", 61);
    const held = await hold({ engine: "google", bucket: "recheck", units: 10 });
    await expect(
      commitReservation(pool, clock.now, held, 11),
    ).rejects.toMatchObject({ statusCode: 422, code: "unprocessable" });
    // The refusal leaves the hold exactly as it was.
    expect(await reservationRow(held)).toMatchObject({
      state: "held",
      units: 10,
    });
    expect(await ledgerRow("google", "2026-10-01")).toMatchObject({
      recheck_reserved: 10,
      recheck_committed: 0,
    });
    await releaseReservation(pool, clock.now, held);
  });

  it("lands a commit in the month the reservation was made, past midnight", async () => {
    await freshMonth("google", "2027-05-31T23:40:00.000Z");
    const held = await hold({ engine: "google", bucket: "scan", units: 40 });

    // Thirty minutes later the UTC month has turned but the hold's hour
    // has not: the settlement belongs to the month it reserved.
    clock.set("2027-06-01T00:10:00.000Z");
    const committed = await commitReservation(pool, clock.now, held, 25);
    expect(committed.monthStart).toBe("2027-05-01");
    expect(await ledgerRow("google", "2027-05-01")).toMatchObject({
      scan_reserved: 0,
      scan_committed: 25,
    });
    // The reservation row stays pinned to May, and June opens nothing.
    expect(await reservationRow(held)).toMatchObject({
      state: "committed",
      month_start: "2027-05-01",
    });
    const june = await pool.query(
      "select count(*) as count from quota_ledger where engine = 'google' and month_start = '2027-06-01'",
    );
    expect(Number(june.rows[0].count)).toBe(0);
  });

  it("refuses a commit on an expired reservation", async () => {
    await freshMonth("google", "2026-11-10T06:00:00.000Z");
    const held = await hold({ engine: "google", bucket: "scan", units: 50 });
    clock.advance(3_600_000);
    // Every hold standing anywhere is now past its hour, so this sweep
    // settles exactly this test's hold.
    const swept = await expireReservations(pool, clock.now);
    expect(swept).toBe(1);
    await expect(
      commitReservation(pool, clock.now, held, 50),
    ).rejects.toMatchObject({ statusCode: 409, code: "state_conflict" });
    expect(await ledgerRow("google", "2026-11-01")).toMatchObject({
      scan_reserved: 0,
      scan_committed: 0,
    });
  });

  // -----------------------------------------------------------------
  // Seam 4: release.

  it("releases a hold back to its bucket and refuses repeats", async () => {
    await freshMonth("google", "2026-12-10T06:00:00.000Z");
    const held = await hold({ engine: "google", bucket: "recheck", units: 40 });
    const released = await releaseReservation(pool, clock.now, held);
    expect(released).toMatchObject({
      state: "released",
      releasedUnits: 40,
      committedUnits: null,
    });
    expect(await ledgerRow("google", "2026-12-01")).toMatchObject({
      recheck_reserved: 0,
      recheck_committed: 0,
    });

    // A double release is refused...
    await expect(
      releaseReservation(pool, clock.now, held),
    ).rejects.toMatchObject({ statusCode: 409, code: "state_conflict" });

    // ...and so is releasing a committed reservation.
    const settled = await hold({ engine: "google", bucket: "recheck", units: 10 });
    await commitReservation(pool, clock.now, settled, 10);
    await expect(
      releaseReservation(pool, clock.now, settled),
    ).rejects.toMatchObject({ statusCode: 409, code: "state_conflict" });
  });

  // -----------------------------------------------------------------
  // Seam 5: expiry sweep.

  it("expires only the holds past their hour and restores their units", async () => {
    await freshMonth("google", "2027-01-10T06:00:00.000Z");
    const old = await hold({ engine: "google", bucket: "scan", units: 25 });
    const oldCommitted = await hold({
      engine: "google",
      bucket: "recheck",
      units: 15,
    });
    await commitReservation(pool, clock.now, oldCommitted, 15);

    clock.advance(7_200_000);
    const fresh = await hold({ engine: "google", bucket: "scan", units: 10 });

    const swept = await expireReservations(pool, clock.now);
    expect(swept).toBe(1);
    expect(await reservationRow(old)).toMatchObject({
      state: "expired",
      released_units: 25,
    });
    // The fresh hold and the committed reservation are untouched.
    expect(await reservationRow(fresh)).toMatchObject({ state: "held" });
    expect(await reservationRow(oldCommitted)).toMatchObject({
      state: "committed",
    });
    // The expired scan units returned; the committed re-check units did not.
    expect(await ledgerRow("google", "2027-01-01")).toMatchObject({
      scan_reserved: 10,
      recheck_reserved: 0,
      recheck_committed: 15,
    });
    await releaseReservation(pool, clock.now, fresh);
  });

  // -----------------------------------------------------------------
  // Seam 6: rollover.

  it("opens the new month from current settings without carrying anything over", async () => {
    await freshMonth("google", "2027-02-15T06:00:00.000Z", 120);
    // $1.20 buys 2,000 units: 1,400 scan, 600 re-check.
    const spent = await hold({ engine: "google", bucket: "scan", units: 500 });
    await commitReservation(pool, clock.now, spent, 400);

    // The administrator halves the cap before the month turns.
    await pool.query(
      "update rights_holder set budget_google_monthly_cap_minor = 60",
    );

    clock.set("2027-03-01T00:00:00.000Z");
    const opened = await rollOverMonth(pool, clock.now);
    expect(opened.find((row) => row.engine === "google")).toMatchObject({
      monthStart: "2027-03-01",
      created: true,
      allowanceUnits: 1_000,
    });
    expect(await ledgerRow("google", "2027-03-01")).toMatchObject({
      scan_reserved: 0,
      scan_committed: 0,
      recheck_reserved: 0,
      recheck_committed: 0,
    });

    // The old month keeps its history exactly as it stood.
    expect(await ledgerRow("google", "2027-02-01")).toMatchObject({
      allowance_units: 2_000,
      scan_reserved: 0,
      scan_committed: 400,
    });

    // Rollover is idempotent within the month it opened.
    const again = await rollOverMonth(pool, clock.now);
    expect(again.find((row) => row.engine === "google")).toMatchObject({
      created: false,
      allowanceUnits: 1_000,
    });
    const rows = await pool.query(
      "select count(*) as count from quota_ledger where engine = 'google' and month_start = '2027-03-01'",
    );
    expect(Number(rows.rows[0].count)).toBe(1);
  });

  // -----------------------------------------------------------------
  // Seam 8: the live-cap spend authority against a lowered and raised cap.

  it("refuses new reservations under a lowered cap, keeps the committed, and unblocks on a raise", async () => {
    await freshMonth("google", "2027-04-10T06:00:00.000Z");
    const spent = await hold({ engine: "google", bucket: "scan", units: 700 });
    await commitReservation(pool, clock.now, spent, 700);

    // Lower the cap to $0.06: the live allowance is 100 units — shares
    // 70/30 — while 700 sit committed.
    await pool.query(
      "update rights_holder set budget_google_monthly_cap_minor = 6",
    );
    const row = await ledgerRow("google", "2027-04-01");
    // Nothing is un-spent and the month's snapshot stays as history.
    expect(row.scan_committed).toBe(700);
    expect(row.allowance_units).toBe(1_000);

    // The spend authority is the live cap: the scan bucket, with more
    // committed than the new share, refuses anything further...
    const refused = await reserve(pool, clock.now, {
      engine: "google",
      bucket: "scan",
      units: 1,
    });
    expect(refused).toMatchObject({
      outcome: "budget_exhausted",
      shareUnits: 70,
      usedUnits: 700,
      remainingUnits: 0,
    });

    // ...and the re-check bucket now spends against the live share of 30,
    // not the snapshot's 300: 31 does not fit, 30 does.
    const overRecheck = await reserve(pool, clock.now, {
      engine: "google",
      bucket: "recheck",
      units: 31,
    });
    expect(overRecheck).toMatchObject({
      outcome: "budget_exhausted",
      shareUnits: 30,
    });
    const fitsRecheck = await hold({
      engine: "google",
      bucket: "recheck",
      units: 30,
    });
    await releaseReservation(pool, clock.now, fitsRecheck);

    // Raising the cap buys the month room again: queued work runs.
    await pool.query(
      "update rights_holder set budget_google_monthly_cap_minor = 120",
    );
    const unblocked = await hold({ engine: "google", bucket: "scan", units: 1 });
    await releaseReservation(pool, clock.now, unblocked);

    // The committed history is exactly what it was; only the authority moved.
    expect(await ledgerRow("google", "2027-04-01")).toMatchObject({
      allowance_units: 1_000,
      scan_committed: 700,
      scan_reserved: 0,
      recheck_committed: 0,
    });
  });
});
