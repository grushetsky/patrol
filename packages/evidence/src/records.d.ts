import type { Pool } from "pg";
import { type AllowlistTitleContext } from "@patrol/domain";
import type { EvidenceArtifactKind } from "./store.js";
/**
 * The evidence records (docs/design/evidence-capture.md): the captures
 * queue table, the append-only evidence and artifact rows it produces, and
 * host objections with their clearance. The enqueue port here is the seam
 * slice 5 wires into candidate formation, review opens, and notice
 * approval; its guards run in the design's order — the allowlist before
 * any fetch, an individualized objection before any fetch, the freshness
 * window before another row — so a refused or fresh URL never reaches a
 * queue and never costs a fetch.
 */
/** Why a capture was taken (the contract's CaptureReason). */
export type CaptureReason = "detection" | "review" | "pre_handoff";
/** What a capture observed (the contract's CaptureOutcome). */
export type CaptureOutcome = "captured" | "dead" | "blocked" | "error";
/** One hop of a recorded redirect chain (the contract's RedirectHop). */
export interface RedirectHopRow {
    url: string;
    statusCode: number;
    location?: string;
}
/** The browser and extraction settings one capture ran under (CaptureProfile). */
export interface CaptureProfileJson {
    userAgent: string;
    viewportWidth: number;
    viewportHeight: number;
    locale: string;
    timezone: string;
    javascriptEnabled: boolean;
    blockedResourceKinds: string[];
    navigationPolicy: string;
    extractorVersion: string;
}
/**
 * The freshness windows (implementation rules "Capture points"): review
 * captures a URL whose newest live capture is over 24 hours old,
 * pre_handoff one over 7 days old; detection always captures at candidate
 * formation.
 */
export declare const FRESHNESS_WINDOWS_MS: Readonly<Record<Exclude<CaptureReason, "detection">, number>>;
/**
 * The default point key, which makes "one fetch per URL per capture point"
 * hold before slice 5 passes the real event identity: a detection enqueue
 * is its own instant (every formation captures), while review and
 * pre_handoff bucket to their freshness window, so a second action inside
 * the window deduplicates onto the capture that already stands.
 */
export declare function defaultPointKey(reason: CaptureReason, now: () => Date): string;
/** One queued evidentiary fetch (the captures table). */
export interface CaptureRow {
    id: string;
    requestedUrl: string;
    normalizedUrl: string;
    reason: CaptureReason;
    pointKey: string;
    state: "pending" | "running" | "done" | "failed" | "skipped";
    skipReason: "allowlist" | "host_objection" | null;
    attemptCount: number;
    requestedAt: Date;
    lastAttemptAt: Date | null;
    nextAttemptAt: Date | null;
    finishedAt: Date | null;
    evidenceId: string | null;
}
/** What enqueueing one capture produced. */
export type EnqueueCaptureResult = {
    status: "queued";
    captureId: string;
} | {
    status: "exists";
    captureId: string;
    state: CaptureRow["state"];
    evidenceId: string | null;
} | {
    status: "skipped_allowlist";
    captureId: string;
} | {
    status: "refused";
    hostObjectionId: string;
} | {
    status: "fresh";
    evidenceId: string;
};
/**
 * Anything that can run a parameterized query — the pool itself or a
 * transaction client. The enqueue port's callers run inside approval
 * transactions (the capture rows join the notice's commit), so the port
 * takes the narrower executor rather than demanding the pool.
 */
export type SqlExecutor = {
    query: Pool["query"];
};
/** The enqueue port's dependencies; slice 5 injects the queue dispatch. */
export interface EnqueueCaptureDeps {
    pool: SqlExecutor;
    now: () => Date;
    /** Wakes the worker's capture queue for one capture. */
    dispatch: (captureId: string) => Promise<void>;
}
/**
 * The capture enqueue port — the one door captures enter through.
 *
 * Guards, in the design's order:
 *
 * 1. **Allowlist before the fetch.** A URL matching a rights-holder-scoped
 *    entry is never fetched: the capture row records the skip and no
 *    evidence row is ever created. When the caller passes the candidate's
 *    title context (formation does), the title-group and tracked-title
 *    entries scoped to that pair join the check, and a licensed destination
 *    additionally needs the observation's territory — the same rule the
 *    formation check applies.
 * 2. **An individualized objection stops capture.** A host under an active
 *    objection refuses the enqueue — the 409 host_objection semantics the
 *    contract carries — until an operator clears it.
 * 3. **Freshness.** A review or pre_handoff capture whose newest live
 *    capture is inside the window is not taken; the caller pins the
 *    existing capture instead.
 *
 * Then the one-per-point insert: UNIQUE (normalized_url, reason,
 * point_key) makes a duplicate wake-up return the row that already stands.
 *
 * Throws on an unparseable URL; the caller decides how that reaches an
 * operator.
 */
export declare function enqueueCapture(deps: EnqueueCaptureDeps, input: {
    url: string;
    reason: CaptureReason;
    pointKey?: string;
    /** The candidate's title context, when the enqueue is a candidate's. */
    context?: AllowlistTitleContext;
}): Promise<EnqueueCaptureResult>;
/**
 * The allowlist guard's answer for a URL: the winning entry among the
 * applicable rows, or null. Without a title context only the rights-holder
 * entries apply; with one — the candidate's, passed by formation — the
 * title-group and tracked-title entries scoped to that pair join, and a
 * licensed destination additionally needs the context's territory, the
 * same rule the candidate store's formation check applies. TODO(slice-5b):
 * the run-time re-check still passes no context — the capture row carries
 * no title pairing — so a scoped entry landing between the enqueue and the
 * fetch is seen only once 5b carries the pair onto the capture itself.
 */
export declare function allowlistHitForUrl(pool: SqlExecutor | Pool, url: string, context?: AllowlistTitleContext): Promise<{
    kind: string;
    matchKind: string;
    value: string;
} | null>;
/** One evidence row (the contract's Evidence). */
export interface EvidenceRow {
    id: string;
    captureId: string;
    requestedUrl: string;
    normalizedUrl: string;
    finalUrl: string | null;
    redirectChain: RedirectHopRow[];
    host: string | null;
    hostSource: "landing_page" | "submitted_url" | null;
    reason: CaptureReason;
    outcome: CaptureOutcome;
    httpStatus: number | null;
    failureReason: string | null;
    attemptNumber: number;
    observedAt: Date;
    profile: CaptureProfileJson;
    purgedAt: Date | null;
    purgeReason: string | null;
}
/** One artifact row (the contract's EvidenceArtifact plus the pinned version). */
export interface EvidenceArtifactRow {
    id: string;
    evidenceId: string;
    kind: EvidenceArtifactKind;
    sha256: string;
    sizeBytes: number;
    contentType: string;
    width: number | null;
    height: number | null;
    truncated: boolean;
    objectVersion: string | null;
}
/** One artifact the capture produced, ready to record. */
export interface NewEvidenceArtifact {
    kind: EvidenceArtifactKind;
    sha256: string;
    sizeBytes: number;
    contentType: string;
    width?: number;
    height?: number;
    truncated: boolean;
    objectVersion: string | null;
}
/** One attempt's complete record, ready to append. */
export interface NewEvidenceRecord {
    captureId: string;
    requestedUrl: string;
    normalizedUrl: string;
    redirectChain: RedirectHopRow[];
    finalUrl: string | null;
    httpStatus: number | null;
    host: string | null;
    hostSource: "landing_page" | null;
    reason: CaptureReason;
    outcome: CaptureOutcome;
    failureReason: string | null;
    attemptNumber: number;
    observedAt: Date;
    profile: CaptureProfileJson;
    artifacts: NewEvidenceArtifact[];
}
/**
 * Appends one attempt's evidence row with its artifact manifest and moves
 * the capture row to its next state, in one transaction: either the record
 * and the queue state land together or neither does. `terminal` carries
 * captured and dead (never retried) and exhausted blocked/error attempts;
 * otherwise the capture returns to pending with the next attempt's time,
 * which the caller also schedules with the queue.
 */
export declare function appendEvidence(pool: Pool, now: () => Date, record: NewEvidenceRecord, options: {
    terminal: boolean;
    nextAttemptAt?: Date;
}): Promise<string>;
/**
 * Claims one capture for an attempt: pending → running, attempt count up.
 * Returns the new attempt number, or null when the capture was not pending
 * (already claimed, done, or skipped) — the caller leaves those alone.
 */
export declare function beginCaptureAttempt(pool: Pool, captureId: string, now: () => Date): Promise<number | null>;
/** Marks a capture finished without an attempt record — the guards' skips. */
export declare function markCaptureSkippedAtRun(pool: Pool, captureId: string, skipReason: "allowlist" | "host_objection", now: () => Date): Promise<void>;
/** Marks a capture failed by capture machinery (storage or database), for ops. */
export declare function markCaptureFailed(pool: Pool, captureId: string, now: () => Date): Promise<void>;
/** Reads one capture by id; null when absent. */
export declare function readCapture(pool: Pool, captureId: string): Promise<CaptureRow | null>;
/**
 * When a running capture is stale: the runner's budgets end inside a
 * minute and the capture queue expires an unfinished job in five, so a
 * running attempt older than ten minutes belongs to a worker that no
 * longer exists. The sweeper reaps those rows rather than trusting the
 * process that lost them.
 */
export declare const STALE_RUNNING_CAPTURE_MS: number;
/**
 * The pending captures whose next attempt has come due: every retry whose
 * scheduled wake-up must exist, whether the runner's own schedule sent it
 * or the sweeper is replacing one that was lost. A pending row waiting for
 * its first attempt carries no next-attempt time and stays out — its
 * enqueue dispatched it.
 */
export declare function duePendingCaptureIds(pool: Pool, now: () => Date): Promise<string[]>;
/**
 * Reaps the captures a dead worker left running — older than the stale
 * threshold — back to pending with the next attempt due immediately. The
 * attempt a reaped row spent stands (the count is not reset): the retry
 * matrix budgets attempts, not crashes. Returns the reaped ids.
 */
export declare function reapStaleRunningCaptures(pool: Pool, now: () => Date, staleMs?: number): Promise<string[]>;
/** Reads one evidence row with its artifacts; null when absent. */
export declare function readEvidence(pool: Pool, evidenceId: string): Promise<{
    evidence: EvidenceRow;
    artifacts: EvidenceArtifactRow[];
} | null>;
/** The newest live (captured) evidence for a normalized URL; null when none. */
export declare function newestLiveEvidence(pool: SqlExecutor, normalizedUrl: string): Promise<EvidenceRow | null>;
/** One recorded host objection (the contract's HostObjection). */
export interface HostObjectionRow {
    id: string;
    host: string;
    registrableDomain: string;
    source: "host_contact" | "operator";
    reason: string;
    recordedAt: Date;
    recordedBy: string | null;
    affectedCandidateCount: number;
    clearedAt: Date | null;
    clearedBy: string | null;
    clearanceReason: string | null;
}
/**
 * The active objection covering a URL, or null. An objection suspends the
 * host it names and every host under it: a cease-and-desist naming a
 * platform covers the platform's subdomains, and continued access after a
 * personal objection is exactly the conduct the design refuses. It does
 * not reach sideways — an objection on one subdomain of a domain does not
 * suspend its siblings, because the host said what it said and no more.
 */
export declare function activeObjectionForUrl(pool: SqlExecutor | Pool, url: string): Promise<HostObjectionRow | null>;
/**
 * Records an objection — the worker's reading of a host's 451 or its page
 * naming Patrol in a cease-and-desist, or (slice 5+ via the operator
 * surface) a letter an operator enters. Idempotent per host while active:
 * a second signal returns the standing objection rather than a second row.
 */
export declare function recordHostObjection(pool: Pool, now: () => Date, input: {
    host: string;
    source: "host_contact" | "operator";
    reason: string;
    affectedCandidateCount: number;
    recordedBy?: string;
}): Promise<HostObjectionRow>;
/** One page of objections, newest first, filtered by host or active state. */
export declare function listHostObjections(pool: Pool, filter: {
    host?: string;
    active?: boolean;
}, paging: {
    limit: number;
    offset: number;
}): Promise<{
    rows: HostObjectionRow[];
    total: number;
}>;
/** What clearing one objection produced. */
export type ClearObjectionResult = {
    status: "cleared";
    row: HostObjectionRow;
} | {
    status: "already_cleared";
    row: HostObjectionRow;
} | {
    status: "absent";
};
/**
 * An operator's explicit decision to reopen a host to capture. The
 * objection is never deleted: the clearance trio (who, when, why) is
 * recorded on the row the guards' update trigger permits, and the row
 * stays in the history the list serves.
 */
export declare function clearHostObjection(pool: Pool, now: () => Date, input: {
    hostObjectionId: string;
    operatorId: string;
    reason: string;
}): Promise<ClearObjectionResult>;
/**
 * How many distinct URLs Patrol has surfaced on a host — the objection's
 * affected-candidate count. Candidates arrive with slice 5; until then the
 * search results Patrol already stores are the surfaced set, which is the
 * same population the review queue will form candidates from.
 */
export declare function affectedSurfaceCount(pool: Pool, host: string): Promise<number>;
