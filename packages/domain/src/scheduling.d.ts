/**
 * The pure scheduling rules the worker's queue, degradation, and re-check
 * ladder compute with (docs/design/scan-scheduling.md "Order of work",
 * "The re-check ladder"; docs/design/budget-envelope.md "Degradation
 * order"). Everything here is date arithmetic and ordering; the database
 * and pg-boss wiring live in the worker.
 */
/** The contract's ScanTrigger. */
export type ScanTriggerName = "scheduled" | "manual" | "recheck" | "manual_recheck";
/** A title group's scheduling priority. */
export type GroupPriorityName = "high" | "normal" | "low";
/** One queued scan as the engine-queue ordering sees it. */
export interface QueueEntry {
    scanId: string;
    trigger: ScanTriggerName;
    /** When the scan was requested: request order for manual work. */
    requestedAt: Date;
    /** The group's priority, for scheduled work. */
    priority: GroupPriorityName;
    /**
     * When the group last completed a scan on this engine; null when it never
     * has, which is the staleest a group can be.
     */
    lastScanAt: Date | null;
}
/**
 * The order one engine queue runs its queued scans in
 * (docs/design/scan-scheduling.md "Order of work"):
 *
 * 1. Manual scans, in the order an operator requested them — a manual
 *    re-check is operator-requested work too.
 * 2. Re-checks, after manual work and before scheduled work, because their
 *    whole purpose is to observe a page before more damage is done.
 * 3. Scheduled scans by group priority, high then normal then low.
 * 4. Within one priority, by least-recently-scanned, the stalest group
 *    first; a group that has never completed a scan is the stalest of all.
 *
 * Ties break on the request time and then the scan id, so the order is
 * total and deterministic.
 */
export declare function orderQueue(entries: QueueEntry[]): QueueEntry[];
/**
 * The degradation order as the scheduler applies it
 * (docs/design/budget-envelope.md; implementation rules "Degradation
 * order"): re-checks starve first through their own unborrowable share; at
 * ninety percent of the scan share low-priority groups stop scanning; at
 * one hundred percent scheduled scans queue with `budget_exhausted`.
 * Manual scans are never skipped by the policy — they preflight the same
 * pool and queue rather than skip.
 */
export interface DegradationPolicy {
    /** Whether scheduled scans of low-priority groups stop. */
    stopLowPriorityGroups: boolean;
    /** Whether every scheduled scan queues rather than starts. */
    queueScheduledScans: boolean;
}
/** Integer-safe: 899 of 1,000 degrades nothing; 900 stops low priority; 1,000 queues. */
export declare function degradationPolicy(input: {
    scanShareUnits: number;
    scanUsedUnits: number;
}): DegradationPolicy;
/** The ladder's fixed shape: rungs fall due 3, 7, and 14 days after the anchor scan. */
export declare const LADDER_RUNG_DAYS: readonly [3, 7, 14];
/**
 * When a rung falls due, measured from the scan that anchors the ladder:
 * rung one at +3 days, rung two at +7, rung three at +14, then every rung
 * a further 14 days while a violation from the pair stays open
 * (docs/design/scan-scheduling.md "The re-check ladder").
 */
export declare function rungDueAt(anchor: Date, rung: number): Date;
/** A day boundary in UTC, as the ledger's months are counted. */
export declare function utcDate(at: Date): string;
