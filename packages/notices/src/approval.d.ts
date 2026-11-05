import type { Pool } from "pg";
/**
 * Approval (docs/design/notice-composition.md "Approval"; ADR 0021): the
 * attestation that freezes a draft. One transaction holds the whole freeze —
 * the template gates, the second-operator first-five control, the content
 * recomputed from LIVE rights-holder, signatory, and profile reads (a
 * draft's stored values are never trusted as the frozen content), the
 * citation pins refreshed to the captures that exist now (a later capture
 * never changes what an approved notice claims), the three snapshots, the
 * approving operator's language frozen beside them (the pack renders in it
 * whenever it is later built), and the pre-handoff captures queued for URLs
 * whose newest live capture is older than seven days. The submission is
 * created once those captures settle — inline when there was nothing to
 * wait on — as a database row alone; the pack's bytes are the API's to
 * build (the topology grants the object store to it alone).
 */
/** The approval's database, clock, and capture dispatch. */
export interface ApprovalDeps {
    pool: Pool;
    now: () => Date;
    dispatch: (captureId: string) => Promise<void>;
}
/** Every refusal approval can answer, in the API's error vocabulary. */
export type ApprovalRefusal = {
    status: "absent";
} | {
    status: "state_conflict";
    currentState: string;
} | {
    status: "statement_version_mismatch";
    noticeVersion: string;
} | {
    status: "template_absent";
} | {
    status: "template_superseded";
    newerVersion: string;
} | {
    status: "template_stale";
    lastVerification: string;
} | {
    status: "second_operator_required";
};
export type ApprovalOutcome = {
    status: "approved";
    noticeId: string;
    /** How many pre-handoff captures the approval queued. */
    queuedCaptures: number;
    /** The submission, present when every capture had already settled. */
    submissionId: string | null;
} | {
    status: "refused";
    refusal: ApprovalRefusal;
};
/** The approving input; the attestations were validated upstream. */
export interface ApprovalInput {
    noticeId: string;
    operatorId: string;
    /** The statement template version the operator confirmed. */
    statementVersion: string;
}
/** The ninety-day approval gate (implementation rules "Approval gate"). */
export declare const TEMPLATE_MAX_AGE_MS: number;
/** The design's second-operator window: a profile's first five notices. */
export declare const SECOND_OPERATOR_FIRST_NOTICES = 5;
/**
 * Approves a draft. The whole freeze lands in one transaction; the capture
 * enqueues ride it (a rolled-back approval leaves no queued captures), and
 * the submission is created after the commit when nothing was queued.
 */
export declare function approveNotice(deps: ApprovalDeps, input: ApprovalInput): Promise<ApprovalOutcome>;
