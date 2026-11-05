import type { Pool, PoolClient } from "pg";
import { type EngineName } from "./pricing.js";
import type { BudgetBucketName, QuotaLedgerRow, ReservationRow } from "./rows.js";
/**
 * The quota ledger (docs/design/scan-scheduling.md "Quota accounting",
 * ADR 0023). The ledger, not the provider, is the budget authority: one
 * row per engine and UTC calendar month, buckets split seventy-thirty by
 * the settings' re-check share, and a reservation taken in one
 * conditional transaction so two concurrent scans cannot both spend the
 * last of a bucket.
 *
 * Immutability: nothing deletes a ledger row and nothing decrements a
 * committed counter. The spend authority is the LIVE settings cap: a
 * raised cap lets queued work run in the opened month (budget-envelope
 * "Degradation order", step 3), while a lowered one refuses new
 * reservations without un-spending — the month over its new cap reads as
 * exhausted until the next month or a raise, and the row's
 * allowance_units snapshot stays as month history, never rewritten
 * (scan-scheduling, "Quota accounting", last paragraph).
 */
/** How long an unstarted reservation is held: one hour. */
export declare const RESERVATION_TTL_MS = 3600000;
/** The first day of the UTC month an instant belongs to. */
export declare function monthStartOf(at: Date): string;
/**
 * Splits an allowance into its buckets: the scan share is floored and the
 * remainder funds re-checks, so the two always sum to the allowance. The
 * re-check share is not borrowable by scans.
 */
export declare function bucketShares(allowanceUnits: number, recheckSharePercent: number): {
    scan: number;
    recheck: number;
};
/** Opens (or returns) an engine's month row in its own transaction. */
export declare function ensureMonth(pool: Pool, engine: EngineName, monthStart: string): Promise<QuotaLedgerRow>;
/** The engine's month row, or null when the month has not opened. */
export declare function readLedgerRow(pool: Pool | PoolClient, engine: EngineName, monthStart: string): Promise<QuotaLedgerRow | null>;
/** Every engine's rows for one month, ordered by engine. */
export declare function readMonthLedgerRows(pool: Pool | PoolClient, monthStart: string): Promise<QuotaLedgerRow[]>;
/** What a reserve call produced: a hold, or the bucket's refusal. */
export type ReserveResult = {
    outcome: "reserved";
    reservation: ReservationRow;
} | {
    outcome: "budget_exhausted";
    engine: EngineName;
    bucket: BudgetBucketName;
    shareUnits: number;
    usedUnits: number;
    remainingUnits: number;
};
/**
 * Reserves billable units against a bucket in one transaction. The
 * conditional update is the arbitration: its WHERE clause admits the
 * increment only while reserved plus committed plus the request fits the
 * share, so of two concurrent transactions competing for a bucket's last
 * units exactly one lands (the other re-evaluates against the committed
 * row and is refused). A refused plan spends nothing — the caller keeps
 * its work queued with `budget_exhausted` rather than truncating it.
 */
export declare function reserve(pool: Pool, now: () => Date, input: {
    engine: EngineName;
    bucket: BudgetBucketName;
    units: number;
    /** The scan holding the reservation. */
    scanId?: string;
}): Promise<ReserveResult>;
/**
 * Commits a reservation: the bucket's reserved counter falls by the whole
 * hold, committed rises by the units the scan actually issued, and a
 * partial scan's unissued remainder is released with it. The settlement
 * lands in the reservation's own month, so a scan that finishes after
 * midnight commits into the month it reserved. Committing a reservation
 * that is no longer held — expired, released, or already committed — is a
 * state conflict: the units are no longer this scan's to spend.
 */
export declare function commitReservation(pool: Pool, now: () => Date, reservationId: string, actualUnits: number): Promise<ReservationRow>;
/**
 * Releases a hold: the reserved units return to their bucket and the
 * reservation records its release. Only a held reservation can be
 * released — a double release, or the release of an expired or committed
 * reservation, is a state conflict.
 */
export declare function releaseReservation(pool: Pool, now: () => Date, reservationId: string): Promise<ReservationRow>;
/**
 * Expires the holds whose hour ran out: each becomes expired with its
 * units released, and the reserved counters return the units to their
 * buckets. Committed units are never touched. One statement settles every
 * expired hold and adjusts every affected month row atomically; the
 * scan.schedule job runs this sweep every fifteen minutes so freed budget
 * re-enters the pool promptly. Returns how many holds expired.
 */
export declare function expireReservations(pool: Pool, now: () => Date): Promise<number>;
