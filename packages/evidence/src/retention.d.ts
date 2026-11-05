import type { Pool } from "pg";
import type { EvidenceStore } from "./store.js";
/**
 * The retention purge (docs/design/evidence-capture.md "Retention"; ADR
 * 0017; implementation rules "Evidence capture and retention"). One pass of
 * the daily `retention.purge` job:
 *
 * 1. **Select** the evidence rows past their window. A row is due only when
 *    NOTHING still keeps it: an open violation's citation, a live notice's
 *    pinned citation (a notice that is drafted, approved, or awaiting
 *    acknowledgement), or an ACTIVE legal hold covering it directly,
 *    through a citing violation, or through a citing notice. The two
 *    windows then apply: closed citations five years after the later of
 *    the violation's closure and the last submission citing the capture;
 *    never-cited captures twelve months after the last review decision, or
 *    after capture where no decision was recorded.
 * 2. **Mark** each due row's purge marker, one committed transaction per
 *    row, BEFORE any byte is touched, and only after the marking UPDATE
 *    itself re-checked the hold coverage under its row lock — a hold that
 *    committed after the selection still wins. An interrupted run leaves
 *    orphaned bytes — never a dangling citation, which is the only one of
 *    the two failure modes that destroys defence material.
 * 3. **Delete bytes**: for every purged row whose cleanup has not
 *    completed, delete the object versions of the artifact hashes NO
 *    unpurged artifact row still references (one blob serves many
 *    records), then record bytes_purged_at. A crash between the delete and
 *    the completion marker costs one idempotent re-delete on the next run.
 * 4. **Raw SERP payloads**: the objects under `serp/` older than ninety
 *    days. The RESULT rows stay in PostgreSQL permanently as provenance;
 *    only the owned raw payload bytes carry the window. The v1 adapters
 *    store no such objects (raw_payload_ref names the provider's own
 *    retained response), so the step lists an empty prefix and deletes
 *    nothing — the path exists and is tested against the store port, so
 *    the day an adapter keeps its payload the window is already enforced.
 */
/**
 * The two evidence windows are measured in calendar intervals PostgreSQL
 * itself counts — `make_interval(years => 5)` and `make_interval(months => 12)`
 * in selectDueEvidence's SQL below — so their single home is that query's
 * literals, not constants here that would drift from it. Only the raw SERP
 * window is a clock offset the runner computes a cutoff with.
 *
 * Ninety days for the raw SERP payloads Patrol owns.
 */
export declare const RAW_SERP_RETENTION_MS: number;
/** The purge reasons the evidence row's marker carries. */
export type PurgeReason = "closed_citations_window" | "never_cited_window";
/** One evidence row the analysis found past its window. */
export interface DueEvidence {
    id: string;
    reason: PurgeReason;
}
/** A hash whose object version the cleanup owes a delete. */
export interface OrphanArtifactVersion {
    evidenceId: string;
    kind: string;
    sha256: string;
    objectVersion: string | null;
}
/**
 * The evidence rows past their window. Every keeper is a NOT in the WHERE;
 * the two windows are the two deadline comparisons. The clock is the
 * caller's, so tests freeze it.
 */
export declare function selectDueEvidence(pool: Pool, now: () => Date): Promise<DueEvidence[]>;
/**
 * Sets one due row's purge marker. One row, one statement, one committed
 * transaction — the marker is durable BEFORE the run touches bytes, and a
 * row another concurrent run already marked is left alone. The statement
 * re-checks the hold coverage under its own row lock: a hold committed
 * between the selection and this mark outranks the window (ADR 0017), so
 * the UPDATE answers 0 rows and the row stays with its bytes.
 */
export declare function markEvidencePurged(pool: Pool, now: () => Date, evidenceId: string, reason: PurgeReason): Promise<boolean>;
/**
 * The orphan object versions the cleanup owes: every artifact of a purged
 * row whose byte cleanup has not completed, whose hash no unpurged
 * artifact row still references. Content addressing makes one blob serve
 * many records, so a blob is deleted only when the last unpurged referent
 * is gone. This query is also the recovery path: it re-finds the hashes an
 * interrupted run left behind, which is what makes the re-run complete.
 */
export declare function selectOrphanArtifactVersions(pool: Pool): Promise<OrphanArtifactVersion[]>;
/** Records that a purged row's owed deletes completed. */
export declare function markBytesPurged(pool: Pool, now: () => Date, evidenceId: string): Promise<void>;
/** What one retention pass did. */
export interface RetentionPurgeSummary {
    /** Rows the analysis found due. */
    due: number;
    /** Rows this run marked (already-marked rows are not re-counted). */
    marked: number;
    /** Object versions this run deleted. */
    versionsDeleted: number;
    /** Purged rows whose cleanup completed. */
    bytesCompleted: number;
    /** Raw SERP payload keys deleted. */
    rawSerpKeysDeleted: number;
}
/** The store surface the retention job needs: the purge path alone. */
export type RetentionStore = Pick<EvidenceStore, "deleteArtifactVersion" | "purgeRawSerpPayloadsOlderThan">;
/**
 * One full retention pass, in the design's order: select, mark, delete
 * bytes, then the raw payload window. A store failure during the byte
 * phase leaves the markers standing and the run reports the error after
 * completing what it could — the next run's orphan query re-finds the
 * leftovers, so the failure mode is a slower cleanup, never a wrong one.
 */
export declare function runRetentionPurge(deps: {
    pool: Pool;
    now: () => Date;
    store: RetentionStore;
    log?: (message: string, extra?: Record<string, unknown>) => void;
}): Promise<RetentionPurgeSummary>;
