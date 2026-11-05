import type { Pool, PoolClient } from "pg";
import type { Recipient } from "./statements.js";
/**
 * The submission state machine (slice 7; docs/design/submission-model.md
 * "Flow", scan-scheduling.md "Submission retries", notice-composition.md
 * "Volume and accuracy safeguards"): an APPROVED notice's single pending
 * `Submission` row moves on the OPERATOR's recorded acts and nothing else —
 * no scheduler ever retries, contacts a recipient, or ages a row.
 *
 * The transitions and what each records:
 *
 * - pending → delivered (POST /submissions/{id}/delivery): the operator's
 *   act of filing — who, when, and the attestation that the notice was
 *   filed as the pack presents it.
 * - pending or delivered → acknowledged (POST .../acknowledgement): what
 *   the recipient returned, validated per recipient — Google a reference
 *   number of 4–40 characters plus the Removals Dashboard URL, Bing a
 *   `TicketId` plus the ticket-details URL, Yandex the reply's Message-ID
 *   plus date. A body shaped for another recipient is refused.
 * - pending → rejected (POST .../failure, `recipient_rejection`): the
 *   refusal and its REQUIRED cause note. The citation reservation ends,
 *   but the offending violation may not enter a NEW draft until a review
 *   decision names it (see `rejectionBlockedViolations`, wired into the
 *   composer). A rejected submission is never retried unchanged — the
 *   correction route is supersession, and because the model marks no
 *   single citation as the offending one, the block covers the rejected
 *   notice's whole cited set: a replacement re-cites any of it only after
 *   the review decision, or carries a set the rejection never touched.
 * - pending → failed (`recipient_error` or `operator_report`): the failure
 *   and its note.
 * - failed → pending (POST .../retry): the operator re-files THE SAME row;
 *   `attemptCount` rises, the delivery/failure/acknowledgement columns
 *   clear, the pack reference stays, and the citations' state mirror
 *   returns to `approved`, so the reservation and the recipient-level
 *   dedup protect the re-filed set again. One row per notice, ever. The
 *   re-file belongs to a LIVE notice only: a superseded or withdrawn
 *   notice owns no submission whatever its row says — the cancellation
 *   the lifecycle writes is the real guard, and the retry's own read of
 *   the parent notice is the floor under it.
 * - cancelled (a pending or failed row whose notice was withdrawn or
 *   superseded): no transition applies — the row is dead and its notice
 *   re-drafts.
 *
 * Attempt counting, fixed here because the design fixes its meaning
 * indirectly ("the operator re-files the same row, and the attempt count
 * rises"; "after three failed attempts the submission is flagged"): the
 * count rises exactly at the RETRY — it counts re-files — so the row's
 * failed attempts are always `attemptCount + 1` while it stands failed.
 * The first failure finds 0, the second 1, and the third 2: the flag
 * lands on that third failure and never clears (an administrator decides
 * whether to withdraw the notice or try again; nothing is cancelled
 * automatically).
 */
/** How many days a pending submission may wait before the reminder names it. */
export declare const REMINDER_DAYS = 7;
/** How many failed attempts flag the submission for an administrator. */
export declare const FLAGGED_FAILED_ATTEMPTS = 3;
/**
 * The attempt count a failing row must already carry for this failure to
 * be the third: `FLAGGED_FAILED_ATTEMPTS - 1`, because the count rises at
 * the retry, not at the failure.
 */
export declare const ATTEMPT_COUNT_BEFORE_FLAG: number;
/** The submission states the database holds. */
export type SubmissionState = "pending" | "delivered" | "acknowledged" | "rejected" | "failed";
/** Why a submission failed or was refused (contract SubmissionFailureReason). */
export type SubmissionFailureReason = "recipient_error" | "recipient_rejection" | "operator_report";
/** The operator's attestation that the notice was filed as presented. */
export interface SubmissionAttestationInput {
    filedAsPresented: true;
    statementVersion: string;
}
/** The acknowledgement body one recipient's answer produces. */
export type AcknowledgementBody = {
    recipient: "google";
    referenceNumber: string;
    dashboardUrl: string;
} | {
    recipient: "bing";
    ticketId: string;
    ticketDetailsUrl: string;
} | {
    recipient: "yandex";
    messageId: string;
    replyDate: string;
};
/** The stored Acknowledgement (contract Patrol.Domain.Acknowledgement). */
export interface StoredAcknowledgement {
    recipient: Recipient;
    referenceNumber?: string;
    dashboardUrl?: string;
    ticketId?: string;
    ticketDetailsUrl?: string;
    messageId?: string;
    replyDate?: string;
    note?: string;
}
/** Every machine act's dependencies: the database and the clock, nothing else. */
export interface SubmissionDeps {
    pool: Pool;
    now: () => Date;
}
export type SubmissionRefusal = {
    status: "absent";
} | {
    status: "cancelled";
} | {
    status: "not_pending";
    currentState: SubmissionState;
} | {
    status: "not_failed";
    currentState: SubmissionState;
} | {
    status: "recipient_mismatch";
    expected: Recipient;
    got: Recipient;
} | {
    status: "acknowledgement_shape";
    field: string;
} | {
    status: "note_required";
};
export type SubmissionOutcome<T> = ({
    status: "recorded";
} & T) | {
    status: "refused";
    refusal: SubmissionRefusal;
};
/**
 * Validates one acknowledgement body against the recipient the NOTICE
 * addresses (implementation rules "Acknowledgement shapes"): the variant
 * must be the notice's own recipient, and each branch's fields must carry
 * the recipient's published identifier. Pure — the write path and the
 * tests share it.
 */
export declare function validateAcknowledgement(recipient: Recipient, body: AcknowledgementBody): {
    ok: true;
    value: StoredAcknowledgement;
} | {
    ok: false;
    status: "recipient_mismatch";
    expected: Recipient;
    got: Recipient;
} | {
    ok: false;
    status: "acknowledgement_shape";
    field: string;
};
/**
 * pending → delivered: the operator's filing, with their attestation. The
 * attempt count does not move — it counts re-files (see the module
 * comment) — and the citations keep their approved reservation until an
 * outcome ends it.
 */
export declare function recordDelivery(deps: SubmissionDeps, input: {
    submissionId: string;
    operatorId: string;
    attestation: SubmissionAttestationInput;
}): Promise<SubmissionOutcome<{
    submissionId: string;
}>>;
/**
 * pending or delivered → acknowledged: what the recipient returned, in the
 * recipient's own shape. A delivered row keeps its original delivery
 * attestation — the one made when the notice was actually filed.
 */
export declare function recordAcknowledgement(deps: SubmissionDeps, input: {
    submissionId: string;
    operatorId: string;
    attestation: SubmissionAttestationInput;
    acknowledgement: AcknowledgementBody;
}): Promise<SubmissionOutcome<{
    submissionId: string;
}>>;
/**
 * pending → rejected or failed. `recipient_rejection` is the recipient's
 * refusal (decided_at; the citation reservation ends and the offending
 * violation needs a review decision before it is cited again); the other
 * reasons are failures (failed_at; the reservation ends the same way and
 * the operator may re-file). Both require a note: a rejection without a
 * note naming its cause is refused outright, and an unexplained failure is
 * no account at all. The third failed attempt raises the administrator's
 * flag; the profile's pause window recomputes on both outcomes.
 */
export declare function recordSubmissionFailure(deps: SubmissionDeps, input: {
    submissionId: string;
    operatorId: string;
    reason: SubmissionFailureReason;
    note: string;
}): Promise<SubmissionOutcome<{
    submissionId: string;
    state: "rejected" | "failed";
}>>;
/**
 * failed → pending: the operator re-files THE SAME row, and only while the
 * notice behind it still lives. The attempt count rises (it counts
 * re-files), every delivery, failure, and acknowledgement column clears
 * for the fresh attempt, and the pack reference, the flag, and the row's
 * identity stay — a retry never creates a second delivery. The citations'
 * state mirror returns from `failed` to `approved` inside the same
 * transaction, so the reservation and the recipient-level dedup hold the
 * re-filed set again (a mirror only the failure itself lowered; one a
 * supersession released stays released). The pause counters refresh (the
 * share fell); the pause itself only an administrator's clearance lifts.
 */
export declare function retrySubmission(deps: SubmissionDeps, input: {
    submissionId: string;
}): Promise<SubmissionOutcome<{
    submissionId: string;
    attemptCount: number;
}>>;
/**
 * The citations a REJECTED submission carried, whose violations may not
 * enter a NEW draft until a review decision on the pair names the cause
 * (notice-composition.md "Volume and accuracy safeguards"). A violation is
 * blocked exactly when some notice whose submission stands REJECTED cites
 * it and no review decision on its candidate was recorded after that
 * rejection. The block keys on the SUBMISSION's state alone — the
 * citations' state mirror is a release bookkeeping fact (a supersession of
 * the rejected notice moves it to `superseded`) and must not end the
 * block: the refusal is still unexamined however the notice left the
 * stage. The composer calls this inside its own transaction; the scheduled
 * path drops the blocked violations, on demand refuses.
 */
export declare function rejectionBlockedViolations(client: PoolClient, violationIds: string[]): Promise<Map<string, string>>;
/** One pending-backlog row, as the reminder and the filter see it. */
export interface PendingBacklogItem {
    submissionId: string;
    noticeId: string;
    recipientProfileId: string;
    createdAt: string;
}
/** The backlog window's cutoff instant, in the caller's clock. */
export declare function pendingBacklogCutoff(now: () => Date, olderThanDays: number): string;
/**
 * The backlog predicate, single-homed here and shared by every reader: the
 * reminder's read, its alert write, and the list filter's `olderThanDays`
 * branch (packages/notices exports it; the API domain imports it, so the
 * homes cannot drift). Live rows in the given state older than the cutoff
 * — cancelled rows are dead: a withdrawn or superseded notice re-drafts,
 * and its old row never nags. `alias` prefixes the columns for a joined
 * query, `cutoffParam` is the placeholder the caller's cutoff binds, and
 * `state` narrows to pending unless the caller names another state (the
 * list's age window beside an explicit state filter applies to that
 * state).
 */
export declare function pendingBacklogCondition(cutoffParam: string, alias?: string, state?: SubmissionState): string;
/**
 * The live pending submissions older than the given number of days — the
 * seven-day reminder's read and the `olderThanDays` filter's predicate,
 * both through the shared `pendingBacklogCondition`. Uses the caller's
 * clock, so tests drive the boundary exactly.
 */
export declare function pendingSubmissionBacklog(pool: Pool, now: () => Date, olderThanDays: number): Promise<PendingBacklogItem[]>;
/** One flagged row, as the administrators' read model shows it. */
export interface FlaggedSubmissionItem {
    submissionId: string;
    noticeId: string;
    recipientProfileId: string;
    attemptCount: number;
    flaggedAt: string;
}
/**
 * The submissions flagged for administrators: rows whose third attempt
 * failed. The flag is a durable fact on the row (never cleared by a
 * retry); slice 8's dashboard badge reads this surface.
 */
export declare function flaggedSubmissions(pool: Pool): Promise<{
    items: FlaggedSubmissionItem[];
}>;
/**
 * The reminder's durable half: one `submission_alerts` row per backlog
 * submission the seven-day reminder has named, in the budget alerts'
 * fire-once pattern — the table's UNIQUE submission_id dedupes, so the
 * second daily run that still sees the row inserts nothing. The row stands
 * exactly while the submission stays a named, still-pending, overdue
 * delivery: every transition out of pending (and the cancellation a
 * withdrawal or supersession writes) deletes it, so a re-filed submission
 * that goes overdue again is re-raised by the next run. Slice 8/9's
 * dashboard badge and reminder surfacing read this table; the backlog
 * filter and the log line name the same rows it does.
 */
export declare function raiseSubmissionAlerts(pool: Pool, now: () => Date, olderThanDays: number): Promise<{
    backlog: PendingBacklogItem[];
    raised: string[];
}>;
/**
 * Clears the reminder's alert row — the submission left the backlog, so
 * the alert is no longer anyone's to see. Called inside every transition's
 * own transaction; the withdrawal and supersession paths clear beside the
 * cancellation they write.
 */
export declare function clearSubmissionAlert(client: PoolClient, submissionId: string): Promise<void>;
/**
 * The same clear, keyed by notice for the paths that cancel a submission
 * without holding its row (the supersession cancels by notice_id). One
 * submission exists per notice, so the keying is exact.
 */
export declare function clearSubmissionAlertByNotice(client: PoolClient, noticeId: string): Promise<void>;
