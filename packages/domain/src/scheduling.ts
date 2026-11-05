/**
 * The pure scheduling rules the worker's queue, degradation, and re-check
 * ladder compute with (docs/design/scan-scheduling.md "Order of work",
 * "The re-check ladder"; docs/design/budget-envelope.md "Degradation
 * order"). Everything here is date arithmetic and ordering; the database
 * and pg-boss wiring live in the worker.
 */

/** The contract's ScanTrigger. */
export type ScanTriggerName =
  | "scheduled"
  | "manual"
  | "recheck"
  | "manual_recheck";

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

/** Which class of work an entry is, in the design's order. */
function queueClass(trigger: ScanTriggerName): "manual" | "recheck" | "scheduled" {
  if (trigger === "manual" || trigger === "manual_recheck") {
    return "manual";
  }
  return trigger === "recheck" ? "recheck" : "scheduled";
}

const CLASS_ORDER = { manual: 0, recheck: 1, scheduled: 2 } as const;
const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 } as const;

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
export function orderQueue(entries: QueueEntry[]): QueueEntry[] {
  return [...entries].sort((left, right) => {
    const classRank =
      CLASS_ORDER[queueClass(left.trigger)] - CLASS_ORDER[queueClass(right.trigger)];
    if (classRank !== 0) {
      return classRank;
    }
    if (queueClass(left.trigger) === "manual") {
      return tieBreak(left, right);
    }
    if (queueClass(left.trigger) === "recheck") {
      return tieBreak(left, right);
    }
    const priorityRank = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
    if (priorityRank !== 0) {
      return priorityRank;
    }
    const leftLast = left.lastScanAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const rightLast = right.lastScanAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (leftLast !== rightLast) {
      return leftLast - rightLast;
    }
    return tieBreak(left, right);
  });
}

/** Request order, then scan id: the tiebreak every class shares. */
function tieBreak(left: QueueEntry, right: QueueEntry): number {
  const at = left.requestedAt.getTime() - right.requestedAt.getTime();
  return at !== 0 ? at : (left.scanId < right.scanId ? -1 : 1);
}

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
export function degradationPolicy(input: {
  scanShareUnits: number;
  scanUsedUnits: number;
}): DegradationPolicy {
  const { scanShareUnits, scanUsedUnits } = input;
  if (scanShareUnits <= 0) {
    return { stopLowPriorityGroups: true, queueScheduledScans: true };
  }
  return {
    stopLowPriorityGroups: scanUsedUnits * 100 >= scanShareUnits * 90,
    queueScheduledScans: scanUsedUnits >= scanShareUnits,
  };
}

/** The ladder's fixed shape: rungs fall due 3, 7, and 14 days after the anchor scan. */
export const LADDER_RUNG_DAYS = [3, 7, 14] as const;

/**
 * When a rung falls due, measured from the scan that anchors the ladder:
 * rung one at +3 days, rung two at +7, rung three at +14, then every rung
 * a further 14 days while a violation from the pair stays open
 * (docs/design/scan-scheduling.md "The re-check ladder").
 */
export function rungDueAt(anchor: Date, rung: number): Date {
  if (!Number.isInteger(rung) || rung < 1) {
    throw new Error(`a ladder rung is a positive integer, got ${rung}`);
  }
  const days =
    rung <= LADDER_RUNG_DAYS.length
      ? LADDER_RUNG_DAYS[rung - 1]
      : 14 * (rung - 2);
  return new Date(anchor.getTime() + days * 86_400_000);
}

/** A day boundary in UTC, as the ledger's months are counted. */
export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}
