import type { Pool } from "pg";
import { type IntentPhraseConfig, type PlanTitle, type QueueEntry } from "@patrol/domain";
/**
 * The scan store: the SQL beneath the scans table's lifecycle. One scan is
 * idempotent on (title group, engine, due date) — the scheduler's insert
 * and the API's manual insert both ride the unique index, so a duplicate
 * wake-up or a manual scan after the scheduler returns the row that
 * already stands. The queue's dequeue order is computed by the shared
 * `orderQueue` function over the queued rows, so the SQL never reimplements
 * the design's ordering.
 */
/** The engines the scheduler drives; Bing buys no route in v1. */
export declare const SCHEDULED_ENGINES: readonly ["google", "yandex"];
export interface ScanRow {
    id: string;
    titleGroupId: string;
    trackedTitleId: string | null;
    engine: "google" | "bing" | "yandex";
    dueDate: string;
    triggerKind: "scheduled" | "manual" | "recheck" | "manual_recheck";
    state: "queued" | "running" | "succeeded" | "partial" | "failed";
    failureReason: string | null;
    plannedQueries: number;
    issuedQueries: number;
    reservationId: string | null;
    createdAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
    /** The operator who requested a manual row, when the row records one. */
    createdBy: string | null;
}
/** Reads one scan by id; null when absent. */
export declare function readScan(pool: Pool, scanId: string): Promise<ScanRow | null>;
/**
 * One page of the scan history, newest first, with the filters the Scans
 * interface serves. The listing reads its rows in one query — `created_by`
 * included — so a page costs a fixed number of statements whatever its
 * size; the per-scan detail (plan, failures) stays with `readScan` and
 * `loadScanFailures`. Returns the page's rows and the filter's total.
 */
export declare function listScanPage(pool: Pool, input: {
    titleGroupId?: string;
    engine?: string;
    state?: string;
    trigger?: string;
    dueDate?: string;
    limit: number;
    offset: number;
}): Promise<{
    rows: ScanRow[];
    total: number;
}>;
/**
 * Creates (or finds) the manual scan rows for a request: one per targeted
 * engine, idempotent on the day. A scan that already stands for the group,
 * engine, and due date is returned unchanged — a manual scan after the
 * scheduler, or a second identical request, never produces a second scan,
 * and the manual row marks the group scanned for the day.
 */
export declare function insertManualScans(pool: Pool, now: () => Date, input: {
    titleGroupId: string;
    trackedTitleId?: string;
    engines: readonly ("google" | "yandex")[];
    trigger: "manual" | "manual_recheck";
    createdBy: string;
}): Promise<ScanRow[]>;
/**
 * Enqueues the day's due scheduled scans for one engine: every group whose
 * scan_time slot has passed and which has not been scanned today. The
 * unique index makes the pass idempotent across duplicate wake-ups and
 * restarts. Returns how many scans were created.
 */
export declare function insertDueScheduledScans(pool: Pool, now: () => Date, engine: "google" | "yandex"): Promise<number>;
/**
 * Enqueues the recheck scans that fell due: one scan row per active ladder
 * past its next-due time, unless the pair already has a scan for today —
 * the standing scan serves the observation, whichever trigger created it.
 * Returns how many scans were created.
 */
export declare function insertDueRecheckScans(pool: Pool, now: () => Date): Promise<number>;
/**
 * The queued scans for one engine, in the order the queue runs them
 * (docs/design/scan-scheduling.md "Order of work"): manual work by request
 * order, then re-checks, then scheduled work by priority and
 * least-recently-scanned. The ordering itself is the shared pure function;
 * this query only gathers the entries it needs.
 */
export declare function queuedScanOrder(pool: Pool, engine: "google" | "bing" | "yandex"): Promise<QueueEntry[]>;
/**
 * Claims one scan for execution: the conditional update is the arbitration
 * between two pickers, a pg-boss retry, and a scheduler wake-up — exactly
 * one lands. Returns null when the scan is no longer queued or already
 * running from this picker's perspective (a running scan continues only
 * through its own holder; a holder that died is swept back to the queue by
 * `requeueCrashedScans`).
 */
export declare function claimScan(pool: Pool, now: () => Date, scanId: string): Promise<ScanRow | null>;
/**
 * The crash sweep (docs/design/scan-scheduling.md "Failure handling",
 * "Worker crash mid-scan"): a scan left `running` by a dead worker returns
 * to the queue with `worker_crash` recorded, and the next picker re-prices
 * the remainder as a new attempt on the same scan. A scan is crashed only
 * when nothing holds it up — no live held reservation stands for it — and
 * it has been running longer than `staleAfterMs` (the reservation TTL the
 * caller passes), so a scan claimed moments ago, still mid-plan before its
 * hold exists, is never torn from a live worker. The sweep never releases
 * a reservation itself: an expired hold was already settled by the
 * reservation expiry sweep. Returns how many scans were requeued.
 */
export declare function requeueCrashedScans(pool: Pool, now: () => Date, staleAfterMs: number): Promise<number>;
/** Returns a running scan to the queue with the reason it waits. */
export declare function requeueScan(pool: Pool, scanId: string, reason: "budget_exhausted" | "route_unavailable"): Promise<void>;
/**
 * The plan inputs: the group's locales, its live titles and variants, and
 * the intent phrases as configured. A merged title's variants moved to the
 * survivor, so only unmerged titles plan.
 */
export declare function loadPlanInputs(pool: Pool, input: {
    titleGroupId: string;
    trackedTitleId?: string | null;
}, now?: () => Date): Promise<{
    locales: string[];
    titles: PlanTitle[];
    intentPhrases: Record<string, IntentPhraseConfig[]>;
}>;
/**
 * The intent phrases as stored, seeded on first read so a fresh database
 * carries the design's defaults without a migration writing
 * operator-editable configuration. A language with no stored rows falls
 * back to the defaults, so deleting a row cannot silently disable intent
 * queries.
 */
export declare function loadIntentPhrases(pool: Pool, now?: () => Date): Promise<Record<string, IntentPhraseConfig[]>>;
/**
 * Persists a plan: the query_plans row and its ordered search_queries. A
 * scan keeps the plan it started with — a retried run continues the
 * standing plan rather than re-deriving it, because the queries already
 * issued carry results that reference their rows (results are never
 * rewritten). Returns false when the plan already stood.
 */
export declare function storePlan(pool: Pool, now: () => Date, input: {
    scanId: string;
    queries: Array<{
        trackedTitleId: string;
        locale: string;
        kind: "variant" | "intent";
        text: string;
        variantId?: string;
        intentPhrase?: IntentPhraseConfig;
    }>;
}): Promise<boolean>;
/** One scan's stored queries, in plan order. */
export declare function loadScanQueries(pool: Pool, scanId: string): Promise<Array<{
    id: string;
    trackedTitleId: string;
    locale: string;
    kind: "variant" | "intent";
    text: string;
    issued: boolean;
    position: number;
}>>;
/**
 * Stores the rows one query returned, as provenance: the raw URL verbatim,
 * the normalized key, the host, the registrable domain, and the query's
 * locale and territory. Results are only ever inserted — the table's
 * trigger refuses updates.
 */
export declare function storeResults(pool: Pool, input: {
    scanId: string;
    engine: "google" | "bing" | "yandex";
    queryId: string;
    locale: string;
    territory?: string;
    observedAt: string;
    rawPayloadRef: string;
    rows: Array<{
        url: string;
        title: string;
        snippet: string;
        rank: number;
    }>;
}): Promise<number>;
/** Marks a query issued-and-failed and records its attempts. */
export declare function storeQueryFailure(pool: Pool, now: () => Date, input: {
    scanId: string;
    queryId: string;
    reason: string;
    attempts: number;
    attemptLog: unknown;
}): Promise<void>;
/** The failure rows a scan recorded, in plan order. */
export declare function loadScanFailures(pool: Pool, scanId: string): Promise<Array<{
    queryId: string;
    reason: string;
    attempts: number;
}>>;
/**
 * Closes a scan out: the terminal state, the finish time, the units the
 * reservation settled for, and the reservation link. `state` must already
 * be one of the terminal states the executor computed.
 */
export declare function finishScan(pool: Pool, now: () => Date, input: {
    scanId: string;
    state: "succeeded" | "partial" | "failed";
    failureReason?: string;
    reservationId?: string | null;
    reservedUnits?: number | null;
    committedUnits?: number | null;
}): Promise<void>;
/** Links the reservation the scan holds, before the queries run. */
export declare function attachReservation(pool: Pool, scanId: string, reservation: {
    id: string;
    units: number;
}): Promise<void>;
/** Whether the scan still holds its reservation (a crash recovery check). */
export declare function heldReservationFor(pool: Pool, scanId: string): Promise<{
    id: string;
    units: number;
} | null>;
