import type { Pool, PoolClient } from "pg";
import type { Recipient } from "./statements.js";
import { recomputeProfilePause } from "./pause.js";

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
export const REMINDER_DAYS = 7;

/** How many failed attempts flag the submission for an administrator. */
export const FLAGGED_FAILED_ATTEMPTS = 3;

/**
 * The attempt count a failing row must already carry for this failure to
 * be the third: `FLAGGED_FAILED_ATTEMPTS - 1`, because the count rises at
 * the retry, not at the failure.
 */
export const ATTEMPT_COUNT_BEFORE_FLAG = FLAGGED_FAILED_ATTEMPTS - 1;

/** The submission states the database holds. */
export type SubmissionState = "pending" | "delivered" | "acknowledged" | "rejected" | "failed";

/** Why a submission failed or was refused (contract SubmissionFailureReason). */
export type SubmissionFailureReason =
  | "recipient_error"
  | "recipient_rejection"
  | "operator_report";

/** The operator's attestation that the notice was filed as presented. */
export interface SubmissionAttestationInput {
  filedAsPresented: true;
  statementVersion: string;
}

/** The acknowledgement body one recipient's answer produces. */
export type AcknowledgementBody =
  | { recipient: "google"; referenceNumber: string; dashboardUrl: string }
  | { recipient: "bing"; ticketId: string; ticketDetailsUrl: string }
  | { recipient: "yandex"; messageId: string; replyDate: string };

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

export type SubmissionRefusal =
  | { status: "absent" }
  | { status: "cancelled" }
  | { status: "not_pending"; currentState: SubmissionState }
  | { status: "not_failed"; currentState: SubmissionState }
  | { status: "recipient_mismatch"; expected: Recipient; got: Recipient }
  | { status: "acknowledgement_shape"; field: string }
  | { status: "note_required" };

export type SubmissionOutcome<T> =
  | ({ status: "recorded" } & T)
  | { status: "refused"; refusal: SubmissionRefusal };

/** A URL the acknowledgement fields accept: absolute http(s). */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** An ISO calendar date (YYYY-MM-DD), the contract's plainDate shape. */
function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Validates one acknowledgement body against the recipient the NOTICE
 * addresses (implementation rules "Acknowledgement shapes"): the variant
 * must be the notice's own recipient, and each branch's fields must carry
 * the recipient's published identifier. Pure — the write path and the
 * tests share it.
 */
export function validateAcknowledgement(
  recipient: Recipient,
  body: AcknowledgementBody,
):
  | { ok: true; value: StoredAcknowledgement }
  | { ok: false; status: "recipient_mismatch"; expected: Recipient; got: Recipient }
  | { ok: false; status: "acknowledgement_shape"; field: string } {
  if (body.recipient !== recipient) {
    return { ok: false, status: "recipient_mismatch", expected: recipient, got: body.recipient };
  }
  switch (body.recipient) {
    case "google": {
      const referenceNumber = body.referenceNumber.trim();
      if (referenceNumber.length < 4 || referenceNumber.length > 40) {
        return { ok: false, status: "acknowledgement_shape", field: "referenceNumber" };
      }
      if (!isHttpUrl(body.dashboardUrl)) {
        return { ok: false, status: "acknowledgement_shape", field: "dashboardUrl" };
      }
      return {
        ok: true,
        value: { recipient, referenceNumber, dashboardUrl: body.dashboardUrl.trim() },
      };
    }
    case "bing": {
      if (body.ticketId.trim() === "") {
        return { ok: false, status: "acknowledgement_shape", field: "ticketId" };
      }
      if (!isHttpUrl(body.ticketDetailsUrl)) {
        return { ok: false, status: "acknowledgement_shape", field: "ticketDetailsUrl" };
      }
      return {
        ok: true,
        value: { recipient, ticketId: body.ticketId.trim(), ticketDetailsUrl: body.ticketDetailsUrl.trim() },
      };
    }
    case "yandex": {
      if (body.messageId.trim() === "") {
        return { ok: false, status: "acknowledgement_shape", field: "messageId" };
      }
      if (!isIsoDate(body.replyDate)) {
        return { ok: false, status: "acknowledgement_shape", field: "replyDate" };
      }
      return { ok: true, value: { recipient, messageId: body.messageId.trim(), replyDate: body.replyDate } };
    }
  }
}

/** The submission row, locked for the transition about to run. */
interface LockedSubmission {
  id: string;
  notice_id: string;
  recipient_profile_id: string;
  state: SubmissionState;
  attempt_count: number;
  cancelled_at: Date | null;
}

async function lockSubmission(
  client: PoolClient,
  submissionId: string,
): Promise<LockedSubmission | null> {
  const result = await client.query<LockedSubmission>(
    `select id, notice_id, recipient_profile_id, state, attempt_count, cancelled_at
       from submissions where id = $1 for update`,
    [submissionId],
  );
  return result.rows[0] ?? null;
}

/** The machine's common prefix: absent, cancelled, and state guards. */
function guard(
  row: LockedSubmission,
  expected: readonly SubmissionState[],
  failure: { status: "not_pending" } | { status: "not_failed" },
): SubmissionRefusal | null {
  if (row.cancelled_at !== null) {
    return { status: "cancelled" };
  }
  if (!expected.includes(row.state)) {
    return failure.status === "not_pending"
      ? { status: "not_pending", currentState: row.state }
      : { status: "not_failed", currentState: row.state };
  }
  return null;
}

/**
 * pending → delivered: the operator's filing, with their attestation. The
 * attempt count does not move — it counts re-files (see the module
 * comment) — and the citations keep their approved reservation until an
 * outcome ends it.
 */
export async function recordDelivery(
  deps: SubmissionDeps,
  input: {
    submissionId: string;
    operatorId: string;
    attestation: SubmissionAttestationInput;
  },
): Promise<SubmissionOutcome<{ submissionId: string }>> {
  const client = await deps.pool.connect();
  try {
    await client.query("begin");
    const row = await lockSubmission(client, input.submissionId);
    if (row === null) {
      await client.query("rollback");
      return { status: "refused", refusal: { status: "absent" } };
    }
    const refusal = guard(row, ["pending"], { status: "not_pending" });
    if (refusal !== null) {
      await client.query("rollback");
      return { status: "refused", refusal };
    }
    const now = deps.now().toISOString();
    await client.query(
      `update submissions set
          state = 'delivered',
          operator_id = $2,
          delivered_at = $3::timestamptz,
          attested_at = $3::timestamptz,
          statement_version = $4
        where id = $1`,
      [row.id, input.operatorId, now, input.attestation.statementVersion],
    );
    // The filing ends any reminder stint the pending wait ran up.
    await clearSubmissionAlert(client, row.id);
    await client.query("commit");
    return { status: "recorded", submissionId: row.id };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * pending or delivered → acknowledged: what the recipient returned, in the
 * recipient's own shape. A delivered row keeps its original delivery
 * attestation — the one made when the notice was actually filed.
 */
export async function recordAcknowledgement(
  deps: SubmissionDeps,
  input: {
    submissionId: string;
    operatorId: string;
    attestation: SubmissionAttestationInput;
    acknowledgement: AcknowledgementBody;
  },
): Promise<SubmissionOutcome<{ submissionId: string }>> {
  // The recipient the NOTICE addresses decides which shape applies; the
  // wrong-recipient body is refused before anything is written.
  const notice = await deps.pool.query<{ recipient: Recipient }>(
    `select n.recipient from notices n
       join submissions s on s.notice_id = n.id where s.id = $1`,
    [input.submissionId],
  );
  if (notice.rows.length === 0) {
    return { status: "refused", refusal: { status: "absent" } };
  }
  const validated = validateAcknowledgement(notice.rows[0].recipient, input.acknowledgement);
  if (!validated.ok) {
    return { status: "refused", refusal: validated };
  }

  const client = await deps.pool.connect();
  try {
    await client.query("begin");
    const row = await lockSubmission(client, input.submissionId);
    if (row === null) {
      await client.query("rollback");
      return { status: "refused", refusal: { status: "absent" } };
    }
    const refusal = guard(row, ["pending", "delivered"], { status: "not_pending" });
    if (refusal !== null) {
      await client.query("rollback");
      return { status: "refused", refusal };
    }
    const now = deps.now().toISOString();
    // Direct from pending, the request's attestation stands in for the
    // delivery act; from delivered, the original attestation is the one
    // made at the actual filing and stays — and so does the operator who
    // FILED the notice: the acknowledger records what the recipient
    // returned, never replaces the filer of record.
    await client.query(
      `update submissions set
          state = 'acknowledged',
          operator_id = coalesce(operator_id, $2),
          delivered_at = coalesce(delivered_at, $3::timestamptz),
          attested_at = coalesce(attested_at, $3::timestamptz),
          statement_version = coalesce(statement_version, $4),
          acknowledgement = $5::jsonb,
          acknowledged_at = $3::timestamptz
        where id = $1`,
      [
        row.id,
        input.operatorId,
        now,
        input.attestation.statementVersion,
        JSON.stringify(validated.value),
      ],
    );
    // The direct pending → acknowledged act files as it confirms, so the
    // reminder's stint ends here exactly as a delivery would end it.
    await clearSubmissionAlert(client, row.id);
    await client.query("commit");
    return { status: "recorded", submissionId: row.id };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

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
export async function recordSubmissionFailure(
  deps: SubmissionDeps,
  input: {
    submissionId: string;
    operatorId: string;
    reason: SubmissionFailureReason;
    note: string;
  },
): Promise<SubmissionOutcome<{ submissionId: string; state: "rejected" | "failed" }>> {
  const note = input.note.trim();
  if (note === "") {
    return { status: "refused", refusal: { status: "note_required" } };
  }
  const state: "rejected" | "failed" =
    input.reason === "recipient_rejection" ? "rejected" : "failed";

  const client = await deps.pool.connect();
  try {
    await client.query("begin");
    const row = await lockSubmission(client, input.submissionId);
    if (row === null) {
      await client.query("rollback");
      return { status: "refused", refusal: { status: "absent" } };
    }
    const refusal = guard(row, ["pending"], { status: "not_pending" });
    if (refusal !== null) {
      await client.query("rollback");
      return { status: "refused", refusal };
    }
    const now = deps.now().toISOString();
    await client.query(
      `update submissions set
          state = $2,
          operator_id = $3,
          decided_at = case when $2 = 'rejected' then $4::timestamptz end,
          failed_at = case when $2 = 'failed' then $4::timestamptz end,
          failure_reason = $5,
          failure_note = $6,
          failure_recorded_at = $4::timestamptz,
          flagged_at = case
            when $2 = 'failed' and attempt_count >= $7::int and flagged_at is null
              then $4::timestamptz
            else flagged_at
          end
        where id = $1`,
      [
        row.id,
        state,
        input.operatorId,
        now,
        input.reason,
        note,
        ATTEMPT_COUNT_BEFORE_FLAG,
      ],
    );
    // The outcome ends the citation reservation and the recipient-level
    // dedup: the citations' state mirror moves, exactly the write the
    // freeze trigger sanctions.
    await client.query("update notice_citations set state = $2 where notice_id = $1", [
      row.notice_id,
      state,
    ]);
    // Both outcomes leave pending, so the reminder's alert dies with the
    // stint; a retry that goes overdue again is re-raised by the next run.
    await clearSubmissionAlert(client, row.id);
    // The rejection threshold reads the profile's window; this outcome is
    // the moment the share can change.
    await recomputeProfilePause(client, deps.now, row.recipient_profile_id);
    await client.query("commit");
    return { status: "recorded", submissionId: row.id, state };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

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
export async function retrySubmission(
  deps: SubmissionDeps,
  input: { submissionId: string },
): Promise<SubmissionOutcome<{ submissionId: string; attemptCount: number }>> {
  const client = await deps.pool.connect();
  try {
    await client.query("begin");
    const row = await lockSubmission(client, input.submissionId);
    if (row === null) {
      await client.query("rollback");
      return { status: "refused", refusal: { status: "absent" } };
    }
    const refusal = guard(row, ["failed"], { status: "not_failed" });
    if (refusal !== null) {
      await client.query("rollback");
      return { status: "refused", refusal };
    }
    // Belt and braces: the row says failed and uncancelled, but a
    // superseded or withdrawn notice owns no submission whatever the row
    // says — re-filing it would stand pending under a dead notice with no
    // reservation behind it. The lifecycle's cancellation is the real
    // guard; this read is the floor under any path that misses it. It
    // takes no lock on purpose: the lifecycle paths lock the notice first
    // and the submission second, and inverting that order here would
    // deadlock the two against each other. A supersession committing
    // beside this transaction either wins the row lock first (this retry
    // then sees the cancellation and refuses above) or waits for it and
    // cancels the re-filed row itself.
    const notice = await client.query<{ state: string }>(
      "select state from notices where id = $1",
      [row.notice_id],
    );
    const noticeState = notice.rows[0]?.state;
    if (noticeState === "superseded" || noticeState === "withdrawn") {
      await client.query("rollback");
      return { status: "refused", refusal: { status: "cancelled" } };
    }
    const now = deps.now().toISOString();
    const updated = await client.query<{ attempt_count: number }>(
      `update submissions set
          state = 'pending',
          attempt_count = attempt_count + 1,
          last_retried_at = $2::timestamptz,
          operator_id = null,
          delivered_at = null,
          decided_at = null,
          failed_at = null,
          failure_reason = null,
          failure_note = null,
          failure_recorded_at = null,
          attested_at = null,
          statement_version = null,
          acknowledgement = null,
          acknowledged_at = null
        where id = $1
        returning attempt_count`,
      [row.id, now],
    );
    // The reservation the failure ended returns with the re-file: the
    // citations' mirror moves back to `approved`, a state-only write the
    // freeze trigger sanctions, so a second draft citing the violations is
    // refused for as long as the re-filed attempt stands.
    await client.query(
      "update notice_citations set state = 'approved' where notice_id = $1 and state = 'failed'",
      [row.notice_id],
    );
    await recomputeProfilePause(client, deps.now, row.recipient_profile_id);
    await client.query("commit");
    return {
      status: "recorded",
      submissionId: row.id,
      attemptCount: Number(updated.rows[0].attempt_count),
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

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
export async function rejectionBlockedViolations(
  client: PoolClient,
  violationIds: string[],
): Promise<Map<string, string>> {
  if (violationIds.length === 0) {
    return new Map();
  }
  const result = await client.query<{ violation_id: string; notice_id: string }>(
    `select b.violation_id, b.notice_id
     from (
       select distinct on (c.violation_id) c.violation_id, c.notice_id, max(s.decided_at) as rejected_at
       from notice_citations c
       join submissions s on s.notice_id = c.notice_id
       where c.violation_id = any($1::uuid[]) and s.state = 'rejected'
       group by c.violation_id, c.notice_id
       order by c.violation_id, max(s.decided_at) desc
     ) b
     join violations v on v.id = b.violation_id
     left join review_decisions rd on rd.candidate_id = v.candidate_id and rd.decided_at > b.rejected_at
     where rd.id is null`,
    [violationIds],
  );
  return new Map(result.rows.map((row) => [row.violation_id, row.notice_id]));
}

/** One pending-backlog row, as the reminder and the filter see it. */
export interface PendingBacklogItem {
  submissionId: string;
  noticeId: string;
  recipientProfileId: string;
  createdAt: string;
}

/** The backlog window's cutoff instant, in the caller's clock. */
export function pendingBacklogCutoff(now: () => Date, olderThanDays: number): string {
  return new Date(now().getTime() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
}

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
export function pendingBacklogCondition(
  cutoffParam: string,
  alias = "",
  state: SubmissionState = "pending",
): string {
  return `${alias}state = '${state}' and ${alias}cancelled_at is null and ${alias}created_at < ${cutoffParam}::timestamptz`;
}

/**
 * The live pending submissions older than the given number of days — the
 * seven-day reminder's read and the `olderThanDays` filter's predicate,
 * both through the shared `pendingBacklogCondition`. Uses the caller's
 * clock, so tests drive the boundary exactly.
 */
export async function pendingSubmissionBacklog(
  pool: Pool,
  now: () => Date,
  olderThanDays: number,
): Promise<PendingBacklogItem[]> {
  const result = await pool.query<{
    id: string;
    notice_id: string;
    recipient_profile_id: string;
    created_at: Date;
  }>(
    `select s.id, s.notice_id, s.recipient_profile_id, s.created_at
     from submissions s
     where ${pendingBacklogCondition("$1", "s.")}
     order by s.created_at asc, s.id`,
    [pendingBacklogCutoff(now, olderThanDays)],
  );
  return result.rows.map((row) => ({
    submissionId: row.id,
    noticeId: row.notice_id,
    recipientProfileId: row.recipient_profile_id,
    createdAt: row.created_at.toISOString(),
  }));
}

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
export async function flaggedSubmissions(
  pool: Pool,
): Promise<{ items: FlaggedSubmissionItem[] }> {
  const result = await pool.query<{
    id: string;
    notice_id: string;
    recipient_profile_id: string;
    attempt_count: number;
    flagged_at: Date;
  }>(
    `select id, notice_id, recipient_profile_id, attempt_count, flagged_at
       from submissions where flagged_at is not null
       order by flagged_at desc, id`,
  );
  return {
    items: result.rows.map((row) => ({
      submissionId: row.id,
      noticeId: row.notice_id,
      recipientProfileId: row.recipient_profile_id,
      attemptCount: Number(row.attempt_count),
      flaggedAt: row.flagged_at.toISOString(),
    })),
  };
}

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
export async function raiseSubmissionAlerts(
  pool: Pool,
  now: () => Date,
  olderThanDays: number,
): Promise<{ backlog: PendingBacklogItem[]; raised: string[] }> {
  const backlog = await pendingSubmissionBacklog(pool, now, olderThanDays);
  const raised: string[] = [];
  for (const item of backlog) {
    const inserted = await pool.query<{ submission_id: string }>(
      `insert into submission_alerts (submission_id, raised_at)
       values ($1, $2) on conflict (submission_id) do nothing
       returning submission_id`,
      [item.submissionId, now().toISOString()],
    );
    if (inserted.rows.length > 0) {
      raised.push(inserted.rows[0].submission_id);
    }
  }
  return { backlog, raised };
}

/**
 * Clears the reminder's alert row — the submission left the backlog, so
 * the alert is no longer anyone's to see. Called inside every transition's
 * own transaction; the withdrawal and supersession paths clear beside the
 * cancellation they write.
 */
export async function clearSubmissionAlert(
  client: PoolClient,
  submissionId: string,
): Promise<void> {
  await client.query("delete from submission_alerts where submission_id = $1", [submissionId]);
}

/**
 * The same clear, keyed by notice for the paths that cancel a submission
 * without holding its row (the supersession cancels by notice_id). One
 * submission exists per notice, so the keying is exact.
 */
export async function clearSubmissionAlertByNotice(
  client: PoolClient,
  noticeId: string,
): Promise<void> {
  await client.query(
    `delete from submission_alerts a using submissions s
       where a.submission_id = s.id and s.notice_id = $1`,
    [noticeId],
  );
}
