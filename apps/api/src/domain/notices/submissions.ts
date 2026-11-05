import type { Pool } from "pg";
import {
  pendingBacklogCondition,
  pendingBacklogCutoff,
  recordAcknowledgement,
  recordDelivery,
  recordSubmissionFailure,
  retrySubmission,
  type AcknowledgementBody,
  type SubmissionAttestationInput,
  type SubmissionFailureReason,
  type SubmissionRefusal,
} from "@patrol/notices";
import { ApiError } from "../../errors.js";
import { pageParams } from "../../routes/support.js";
import {
  noticeStatus,
  submissionJson,
  SUBMISSION_COLUMNS,
  type SubmissionRow,
} from "./read.js";

/**
 * The Submissions interface's half (Patrol.Http `list`, `read`, `deliver`,
 * `acknowledge`, `fail`, `retry`): the shared machine's refusals mapped
 * onto the contract's error bodies, and the read models the submissions
 * screen renders. Every mutation is the OPERATOR's recorded act — no
 * scheduler path exists here at all (the contact rule: no scheduled
 * process ever touches a recipient).
 */

/** Maps one machine refusal onto the contract's error response. */
export function submissionRefusalError(refusal: SubmissionRefusal): ApiError {
  switch (refusal.status) {
    case "absent":
      return new ApiError(404, "not_found");
    case "cancelled":
      // A cancelled row is dead: its notice was withdrawn or superseded and
      // re-drafts; the row itself has no future transitions.
      return new ApiError(409, "state_conflict", { currentState: "cancelled" });
    case "not_pending":
      return new ApiError(409, "submission_not_pending", {
        currentState: refusal.currentState,
      });
    case "not_failed":
      // Retry is the failed row's alone: a rejected submission is
      // corrected by supersession, never re-filed unchanged.
      return new ApiError(409, "state_conflict", { currentState: refusal.currentState });
    case "recipient_mismatch":
      return new ApiError(422, "unprocessable", {
        fieldErrors: [
          {
            path: "/acknowledgement/recipient",
            message: `the acknowledgement is shaped for ${refusal.got}, but the notice addresses ${refusal.expected}`,
          },
        ],
      });
    case "acknowledgement_shape":
      return new ApiError(422, "unprocessable", {
        fieldErrors: [
          {
            path: `/acknowledgement/${refusal.field}`,
            message: "the field does not carry the recipient's published acknowledgement shape",
          },
        ],
      });
    case "note_required":
      return new ApiError(422, "note_required", {
        fieldErrors: [{ path: "/note", message: "a cause note is required" }],
      });
  }
}

function machineDeps(pool: Pool, now: () => Date) {
  return { pool, now };
}

/** POST /submissions/{id}/delivery. */
export async function deliverSubmission(
  pool: Pool,
  now: () => Date,
  operatorId: string,
  submissionId: string,
  attestation: SubmissionAttestationInput,
): Promise<Record<string, unknown>> {
  const outcome = await recordDelivery(machineDeps(pool, now), {
    submissionId,
    operatorId,
    attestation,
  });
  if (outcome.status === "refused") {
    throw submissionRefusalError(outcome.refusal);
  }
  return readSubmissionJson(pool, submissionId);
}

/** POST /submissions/{id}/acknowledgement. */
export async function acknowledgeSubmission(
  pool: Pool,
  now: () => Date,
  operatorId: string,
  submissionId: string,
  attestation: SubmissionAttestationInput,
  acknowledgement: AcknowledgementBody,
): Promise<Record<string, unknown>> {
  const outcome = await recordAcknowledgement(machineDeps(pool, now), {
    submissionId,
    operatorId,
    attestation,
    acknowledgement,
  });
  if (outcome.status === "refused") {
    throw submissionRefusalError(outcome.refusal);
  }
  return readSubmissionJson(pool, submissionId);
}

/** POST /submissions/{id}/failure. */
export async function failSubmission(
  pool: Pool,
  now: () => Date,
  operatorId: string,
  submissionId: string,
  input: { reason: SubmissionFailureReason; note: string },
): Promise<Record<string, unknown>> {
  const outcome = await recordSubmissionFailure(machineDeps(pool, now), {
    submissionId,
    operatorId,
    ...input,
  });
  if (outcome.status === "refused") {
    throw submissionRefusalError(outcome.refusal);
  }
  return readSubmissionJson(pool, submissionId);
}

/** POST /submissions/{id}/retry. */
export async function retrySubmissionRoute(
  pool: Pool,
  now: () => Date,
  submissionId: string,
): Promise<Record<string, unknown>> {
  const outcome = await retrySubmission(machineDeps(pool, now), { submissionId });
  if (outcome.status === "refused") {
    throw submissionRefusalError(outcome.refusal);
  }
  return readSubmissionJson(pool, submissionId);
}

/** The submission row as the mutation responses return it. */
async function readSubmissionJson(
  pool: Pool,
  submissionId: string,
): Promise<Record<string, unknown>> {
  const row = await pool.query<SubmissionRow>(
    `select ${SUBMISSION_COLUMNS} from submissions where id = $1`,
    [submissionId],
  );
  if (row.rows.length === 0) {
    throw new ApiError(404, "not_found");
  }
  return submissionJson(row.rows[0]);
}

/** The SubmissionState values the list filter accepts. */
const LIST_STATES = ["pending", "delivered", "acknowledged", "rejected", "failed"] as const;

/**
 * The submission columns the list and detail selects carry, table-prefixed
 * for their join with the notice. `SUBMISSION_COLUMNS` in read.ts spells
 * the same set unprefixed; the two move together by hand.
 */
const SUBMISSION_COLUMNS_JOINED = `s.id, s.notice_id, s.recipient_profile_id, s.channel,
  s.state, s.attempt_count, s.pack_language, s.pack_ref, s.pack_sha256, s.created_at,
  s.cancelled_at, s.operator_id, s.delivered_at, s.decided_at, s.failed_at, s.failure_reason,
  s.failure_note, s.failure_recorded_at, s.attested_at, s.statement_version, s.acknowledgement,
  s.acknowledged_at`;

/**
 * GET /submissions: the page, newest first. `olderThanDays` is the pending
 * backlog's parameter — on its own it narrows to live pending rows older
 * than the window (the seven-day reminder's surface); beside an explicit
 * state it applies the age to that state, and cancelled rows never answer
 * a backlog query.
 */
export async function listSubmissions(
  pool: Pool,
  now: () => Date,
  query: Record<string, unknown>,
): Promise<{
  items: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const { page, pageSize, limit, offset } = pageParams(query);
  const conditions: string[] = [];
  const values: unknown[] = [];

  const state =
    typeof query.state === "string" &&
    (LIST_STATES as readonly string[]).includes(query.state)
      ? (query.state as (typeof LIST_STATES)[number])
      : undefined;

  const olderThanDays =
    typeof query.olderThanDays === "number"
      ? query.olderThanDays
      : typeof query.olderThanDays === "string" && /^\d+$/.test(query.olderThanDays)
        ? Number.parseInt(query.olderThanDays, 10)
        : undefined;
  const backlogWindow =
    olderThanDays !== undefined && !Number.isNaN(olderThanDays) && olderThanDays >= 1
      ? olderThanDays
      : undefined;

  // The state filter stands alone until the backlog window is active;
  // then the shared predicate carries the state so it is written once.
  if (state !== undefined && backlogWindow === undefined) {
    values.push(state);
    conditions.push(`s.state = $${values.length}`);
  }
  if (backlogWindow !== undefined) {
    values.push(pendingBacklogCutoff(now, backlogWindow));
    // The backlog predicate's single home (packages/notices exports it;
    // the reminder's read and its alert write apply the same condition):
    // live rows in the filtered state older than the window — never the
    // dead rows a withdrawal or supersession cancelled. On its own the
    // state narrows to pending, the seven-day reminder's surface; beside
    // an explicit state the age applies to that state. (The interpolated
    // literal is safe because `state` came through the closed vocabulary
    // the enum filter admitted it from.)
    conditions.push(pendingBacklogCondition(`$${values.length}`, "s.", state ?? "pending"));
  }

  if (typeof query.noticeId === "string" && query.noticeId !== "") {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.noticeId)) {
      throw new ApiError(400, "validation_failed", {
        fieldErrors: [{ path: "/noticeId", message: "not a notice identifier" }],
      });
    }
    values.push(query.noticeId);
    conditions.push(`s.notice_id = $${values.length}`);
  }

  const where = conditions.length === 0 ? "" : `where ${conditions.join(" and ")}`;
  const rows = await pool.query<SubmissionRow & {
    notice_recipient: "google" | "bing" | "yandex";
    notice_state: "draft" | "approved" | "withdrawn" | "superseded";
    notice_created_at: Date;
    pack_available: boolean;
  }>(
    `select ${SUBMISSION_COLUMNS_JOINED},
            n.recipient as notice_recipient, n.state as notice_state, n.composed_at as notice_created_at,
            exists(select 1 from handoff_packs p where p.notice_id = s.notice_id) as pack_available
     from submissions s join notices n on n.id = s.notice_id ${where}
     order by s.created_at desc, s.id
     limit $${values.length + 1} offset $${values.length + 2}`,
    [...values, limit, offset],
  );
  const total = await pool.query<{ count: string }>(
    `select count(*) as count from submissions s ${where}`,
    values,
  );
  return {
    items: rows.rows.map((row) => submissionListItem(row)),
    total: Number(total.rows[0].count),
    page,
    pageSize,
  };
}

/** One SubmissionDetail row: the submission, its notice ref, the pack flag. */
function submissionListItem(row: SubmissionRow & {
  notice_recipient: "google" | "bing" | "yandex";
  notice_state: "draft" | "approved" | "withdrawn" | "superseded";
  notice_created_at: Date;
  pack_available: boolean;
}): Record<string, unknown> {
  return {
    submission: submissionJson(row),
    notice: {
      id: row.notice_id,
      recipient: row.notice_recipient,
      status: noticeStatus(row.notice_state, row.state),
      createdAt: row.notice_created_at.toISOString(),
    },
    packAvailable: row.pack_available,
  };
}

/** GET /submissions/{id}: the detail with the notice it delivers. */
export async function readSubmissionDetail(
  pool: Pool,
  submissionId: string,
): Promise<Record<string, unknown>> {
  const row = await pool.query<SubmissionRow & {
    notice_recipient: "google" | "bing" | "yandex";
    notice_state: "draft" | "approved" | "withdrawn" | "superseded";
    notice_created_at: Date;
    pack_available: boolean;
  }>(
    `select ${SUBMISSION_COLUMNS_JOINED},
            n.recipient as notice_recipient, n.state as notice_state, n.composed_at as notice_created_at,
            exists(select 1 from handoff_packs p where p.notice_id = s.notice_id) as pack_available
     from submissions s join notices n on n.id = s.notice_id
     where s.id = $1`,
    [submissionId],
  );
  if (row.rows.length === 0) {
    throw new ApiError(404, "not_found");
  }
  return submissionListItem(row.rows[0]);
}
