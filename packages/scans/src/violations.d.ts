import type { Pool, PoolClient } from "pg";
/**
 * The violation store (docs/design/matching-and-classification-rules.md
 * "Review decisions"; contract Patrol.Domain.Violation / ViolationEvidence;
 * INVARIANTS.md "Violations"). A violation is created only from a candidate
 * a review decision confirmed, is keyed by (normalized URL, tracked title)
 * with at most one open row per pair, and cites at least one pinned capture.
 * Neither the identity columns nor a citation is ever rewritten; a lifecycle
 * update is the one forward step out of open, and a reappearing URL starts a
 * new row linked to its predecessor.
 *
 * The store lives in this shared package because both processes write it:
 * the API creates violations inside the decision transaction, and the
 * worker records removals when a capture shows a URL gone.
 */
/** The violation lifecycle states (the contract's ViolationState). */
export type ViolationState = "open" | "removed" | "closed";
/** Why a violation left the open state (the contract's ViolationClosureReason). */
export type ViolationClosureReason = "url_removed" | "operator_closed";
/** One violations-table row. */
export interface ViolationRow {
    id: string;
    trackedTitleId: string;
    candidateId: string;
    reviewDecisionId: string;
    url: string;
    normalizedUrl: string;
    host: string;
    hostSource: "landing_page" | "submitted_url";
    registrableDomain: string;
    detectedAt: Date;
    confirmedAt: Date;
    confirmedBy: string;
    predecessorViolationId: string | null;
    state: ViolationState;
    openedAt: Date;
    closedAt: Date | null;
    closureReason: ViolationClosureReason | null;
    closureNote: string | null;
    closureEvidenceId: string | null;
    closedBy: string | null;
}
type RawViolationRow = {
    id: string;
    tracked_title_id: string;
    candidate_id: string;
    review_decision_id: string;
    url: string;
    normalized_url: string;
    host: string;
    host_source: "landing_page" | "submitted_url";
    registrable_domain: string;
    detected_at: Date;
    confirmed_at: Date;
    confirmed_by: string;
    predecessor_violation_id: string | null;
    state: ViolationState;
    opened_at: Date;
    closed_at: Date | null;
    closure_reason: ViolationClosureReason | null;
    closure_note: string | null;
    closure_evidence_id: string | null;
    closed_by: string | null;
};
export declare function mapViolation(row: RawViolationRow): ViolationRow;
/** A violation ready to insert, inside the caller's decision transaction. */
export interface NewViolation {
    /**
     * The violation's id, pre-generated so the decision row can name it
     * before the violation row lands (the two foreign keys point at each
     * other; one id must come first, and both land in one transaction).
     */
    id: string;
    trackedTitleId: string;
    candidateId: string;
    reviewDecisionId: string;
    url: string;
    normalizedUrl: string;
    host: string;
    hostSource: "landing_page" | "submitted_url";
    registrableDomain: string;
    detectedAt: Date;
    confirmedAt: Date;
    confirmedBy: string;
    predecessorViolationId: string | null;
}
/**
 * Inserts one violation as open. The caller runs inside the decision
 * transaction, after the decision row it names; the partial unique index on
 * (normalized_url, tracked_title_id) WHERE state = 'open' refuses a second
 * open row for the pair, which the caller maps onto its conflict answer.
 * Returns the inserted row.
 */
export declare function insertViolation(client: PoolClient, violation: NewViolation): Promise<ViolationRow>;
/** Reads one violation by id; null when absent. */
export declare function readViolation(pool: Pool, violationId: string): Promise<ViolationRow | null>;
/** The open violation for one (URL, tracked title) pair, when one stands. */
export declare function openViolationForPair(client: Pool | PoolClient, input: {
    normalizedUrl: string;
    trackedTitleId: string;
}): Promise<ViolationRow | null>;
/**
 * The most recent violation of the pair that left the open state, when one
 * exists — the predecessor a reappearance's confirm links to. The closed
 * record is never reopened; a new row carries the chain.
 */
export declare function latestTerminalViolationForPair(client: Pool | PoolClient, input: {
    normalizedUrl: string;
    trackedTitleId: string;
}): Promise<ViolationRow | null>;
/** Every open violation whose URL is one normalized URL. */
export declare function openViolationsForUrl(pool: Pool, normalizedUrl: string): Promise<ViolationRow[]>;
/** What one closure attempt produced. */
export type ViolationClosureResult = {
    status: "closed";
    violation: ViolationRow;
} | {
    status: "not_open";
    violation: ViolationRow;
} | {
    status: "absent";
};
/**
 * Records that a capture showed a URL gone: every open violation of the URL
 * leaves the open state as `removed`, with the capture that showed it (the
 * newest capture, retained) and the reason frozen on the row. Removal is
 * terminal; a reappearance starts a new violation. Idempotent per capture:
 * a violation already removed stays exactly as it was.
 */
export declare function recordRemovalsForDeadCapture(pool: Pool, now: () => Date, input: {
    normalizedUrl: string;
    evidenceId: string;
}): Promise<ViolationRow[]>;
/** Closes an open violation an operator recorded, by either reason. */
export declare function recordOperatorClosure(pool: Pool, now: () => Date, input: {
    violationId: string;
    operatorId: string;
    reason: ViolationClosureReason;
    note: string | null;
    evidenceId: string | null;
}): Promise<ViolationClosureResult>;
/** One pinned citation (the violation_evidence table). */
export interface ViolationCitation {
    violationId: string;
    evidenceId: string;
    role: "detection" | "review" | "pre_handoff";
    citedAt: Date;
    pinnedVersions: Array<{
        kind: string;
        sha256: string;
        objectVersion: string | null;
    }>;
}
/**
 * Cites one capture for one violation, pinning the artifact versions as
 * they stand at citation time. The insert is idempotent on the pair: a
 * second citation of the same capture keeps the first pin, because a pin is
 * the fact at citation, not a pointer that follows the store.
 */
export declare function citeViolationEvidence(client: PoolClient, citation: Omit<ViolationCitation, "pinnedVersions"> & {
    pinnedVersions: ViolationCitation["pinnedVersions"];
}): Promise<void>;
/**
 * The artifact versions a citation pins: one {kind, sha256, objectVersion}
 * per artifact of the capture, read inside the caller's transaction so the
 * pin and the citation land together.
 */
export declare function pinnedVersionsForEvidence(client: PoolClient, evidenceId: string): Promise<ViolationCitation["pinnedVersions"]>;
/** The citations of one violation, newest first. */
export declare function citationsForViolation(pool: Pool, violationId: string): Promise<ViolationCitation[]>;
/**
 * Whether any violation under one title group is still open — the re-check
 * ladder's continuation question ("every 14 days for as long as any
 * violation from that pair is `Open`"; docs/design/scan-scheduling.md "The
 * re-check ladder"). Documented deviation: the doc keys a re-check by
 * `(title group, engine)` because a scan targets exactly that pair, while
 * a violation is not engine-owned — it records no engine — so the open
 * state is answered at the group level and a group's ladders continue
 * while any of its violations stands open.
 */
export declare function anyOpenViolationForGroup(pool: Pool, titleGroupId: string): Promise<boolean>;
/**
 * Whether one completed scan produced a violation for its pair — the
 * ladder's start question. The violation's candidate traces to a search
 * result of a query of the scan's plan, and the candidate's title belongs
 * to the group. Called only while no ladder stands for the pair, so any
 * violation the scan produced is the pair's first.
 */
export declare function scanProducedViolation(pool: Pool, input: {
    scanId: string;
    titleGroupId: string;
}): Promise<boolean>;
export {};
