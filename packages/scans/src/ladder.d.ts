import type { Pool } from "pg";
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
 * whether a completed scan produced the pair's first confirmed violation,
 * and `shouldContinue` answers whether any violation from the pair is still
 * open. Slice 5b ships the violations-backed pair
 * (`violationBackedLadderPredicates`) and the worker wires it into its
 * executor; the no-violation defaults remain for callers with no database,
 * where nothing can be open, ladders stop after rung three, and no scan
 * starts one.
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
export declare const noViolationsPredicates: LadderPredicates;
/**
 * The real predicates over the violations table slice 5b writes. `shouldStart`
 * answers whether the completed scan produced a violation for its pair — the
 * violation's candidate traces to a search result of the scan's plan — and is
 * asked only while no ladder stands, so any violation it finds is the pair's
 * first. `shouldContinue` answers whether any violation under the title group
 * is still open; a violation is not engine-owned, so the group is the scope
 * the open state answers for. The worker wires these into its executor; the
 * no-violation defaults stay for callers with no database.
 */
export declare function violationBackedLadderPredicates(pool: Pool): LadderPredicates;
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
export declare function readLadder(pool: Pool, input: {
    titleGroupId: string;
    engine: "google" | "bing" | "yandex";
}): Promise<LadderRow | null>;
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
export declare function onScanCompleted(pool: Pool, now: () => Date, predicates: LadderPredicates, input: {
    scanId: string;
    titleGroupId: string;
    engine: "google" | "bing" | "yandex";
    trigger: "scheduled" | "manual" | "recheck" | "manual_recheck";
    finishedAt: Date;
    dueDate: string;
}): Promise<void>;
/**
 * Resets a pair's ladder at a manual request, anchored at the scan the
 * request found or created. The API calls this so an idempotent same-day
 * manual request — one that returned the day's standing scan and so will
 * never fire a completion — still means "look again soon". An ordinary
 * manual scan resets only a standing ladder; a manual re-check starts one
 * when none stands, exactly as the completion path does.
 */
export declare function resetLadderForManualRequest(pool: Pool, now: () => Date, input: {
    titleGroupId: string;
    engine: "google" | "bing" | "yandex";
    trigger: "manual" | "manual_recheck";
    anchorScanId: string;
    anchorFinishedAt: Date | null;
}): Promise<void>;
