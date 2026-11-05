import type { Pool } from "pg";
import { composeInTransaction, type ComposeOutcome } from "./compose.js";
import { clearSubmissionAlertByNotice } from "./submissions.js";
import type { Recipient } from "./statements.js";

/**
 * Supersession (docs/design/notice-composition.md "Approval"): an approved
 * notice whose cited set must change becomes `Superseded`, its live
 * submission is cancelled, and a replacement draft carries the corrected
 * set — no operator edits an approved notice's contents in place. One
 * transaction holds the whole move: the old citations release their
 * reservations BEFORE the replacement composes (the corrected set may keep
 * most of them), and the composing guards refuse the supersession entire if
 * the corrected set is not composable.
 *
 * Which submissions count as live: `pending` and `failed` — a failed row is
 * still the operator's to re-file, so leaving it standing would let a retry
 * resurrect a pending submission under a superseded notice whose citations
 * the supersession has already released. `delivered` and `acknowledged`
 * never reach the cancellation because the guard below refuses the
 * supersession itself (the recipient owns the process once the notice is
 * filed — the same line withdrawal draws; a wrong notice is corrected by a
 * new notice). `rejected` is terminal and is never re-filed: supersession
 * IS its correction route, and the row stands rejected so the review
 * decision block on its cited set holds until a review answers it.
 */

export interface SupersessionDeps {
  pool: Pool;
  now: () => Date;
}

export type SupersessionRefusal =
  | { status: "absent" }
  | { status: "state_conflict"; currentState: string }
  | { status: "already_filed"; submissionState: "delivered" | "acknowledged" }
  | { status: "empty_set" }
  | { status: "identical_set" }
  | { status: "compose_refused"; outcome: Exclude<ComposeOutcome, { status: "composed" }>["refusal"] };

export type SupersessionOutcome =
  | { status: "superseded"; noticeId: string; replacementNoticeId: string }
  | { status: "refused"; refusal: SupersessionRefusal };

export interface SupersessionInput {
  noticeId: string;
  operatorId: string;
  citedViolationIds: string[];
}

/**
 * Supersedes an approved notice with a replacement draft carrying the
 * corrected citation set.
 */
export async function supersedeNotice(
  deps: SupersessionDeps,
  input: SupersessionInput,
): Promise<SupersessionOutcome> {
  const client = await deps.pool.connect();
  try {
    await client.query("begin");
    const notice = await client.query<{
      state: string;
      recipient: Recipient;
      recipient_profile_id: string;
    }>(
      "select state, recipient, recipient_profile_id from notices where id = $1 for update",
      [input.noticeId],
    );
    const row = notice.rows[0];
    if (row === undefined) {
      await client.query("rollback");
      return { status: "refused", refusal: { status: "absent" } };
    }
    if (row.state !== "approved") {
      await client.query("rollback");
      return {
        status: "refused",
        refusal: { status: "state_conflict", currentState: row.state },
      };
    }

    // A filed notice is beyond supersession: once the submission is
    // delivered or acknowledged the recipient owns the process, and a wrong
    // notice is corrected by a NEW notice — the same line withdrawal draws.
    // (Rejected is the other shape entirely: it is terminal, never
    // re-filed, and supersession is its correction route, so it passes
    // here and its row stands.) The row is locked so a delivery committing
    // beside this transaction cannot slip past the guard and then dodge the
    // cancellation below.
    const submission = await client.query<{ state: string }>(
      "select state from submissions where notice_id = $1 for update",
      [input.noticeId],
    );
    const submissionState = submission.rows[0]?.state;
    if (submissionState === "delivered" || submissionState === "acknowledged") {
      await client.query("rollback");
      return {
        status: "refused",
        refusal: { status: "already_filed", submissionState },
      };
    }

    // The corrected set must cite at least one violation — an empty
    // replacement is a withdrawal's job, not a supersession's.
    const replacementSet = new Set(input.citedViolationIds);
    if (replacementSet.size === 0) {
      await client.query("rollback");
      return { status: "refused", refusal: { status: "empty_set" } };
    }

    // The corrected set must differ from the superseded notice's set.
    const current = await client.query<{ violation_id: string }>(
      "select violation_id from notice_citations where notice_id = $1",
      [input.noticeId],
    );
    const currentSet = new Set(current.rows.map((citation) => citation.violation_id));
    if (
      currentSet.size === replacementSet.size &&
      [...currentSet].every((id) => replacementSet.has(id))
    ) {
      await client.query("rollback");
      return { status: "refused", refusal: { status: "identical_set" } };
    }

    // Release the old reservations and cancel the live submission BEFORE
    // the replacement composes, in the same transaction. Live means pending
    // or failed: a failed row is still retryable, and a retry under a
    // superseded notice would stand pending with no reservation behind it
    // (the citation release above has already ended it). Delivered and
    // acknowledged never reach here — the guard above refused them — and a
    // rejected row is terminal, so it is left standing for the review
    // block that keys on it. The state-only citation mirror write is what
    // the freeze trigger sanctions; the notice's own state flips only once
    // the replacement exists, because the superseded CHECK demands the
    // replacement's id on the same row.
    await client.query(
      "update notice_citations set state = 'superseded' where notice_id = $1",
      [input.noticeId],
    );
    await client.query(
      "update submissions set cancelled_at = $2 where notice_id = $1 and state in ('pending', 'failed') and cancelled_at is null",
      [input.noticeId, deps.now().toISOString()],
    );
    // The cancellation kills the reminder's alert with it: a cancelled row
    // is dead, and the replacement draft starts a submission of its own.
    await clearSubmissionAlertByNotice(client, input.noticeId);

    // The replacement draft, composed through the shared composer inside
    // this transaction. Its guards (open violations, grouping, eligibility)
    // refuse the supersession entire when the corrected set will not fly.
    const composed = await composeInTransaction(client, deps.now, {
      recipient: row.recipient,
      recipientProfileId: row.recipient_profile_id,
      violationIds: input.citedViolationIds,
      trigger: "on_demand",
      composedBy: input.operatorId,
    });
    if (composed.status === "refused") {
      await client.query("rollback");
      return { status: "refused", refusal: { status: "compose_refused", outcome: composed.refusal } };
    }
    const replacement = composed.notices[0];
    if (replacement === undefined) {
      // The corrected set resolved to nothing composable — treat it as the
      // same refusal rather than superseding into a vacuum.
      await client.query("rollback");
      return { status: "refused", refusal: { status: "identical_set" } };
    }

    // The superseded state lands with its replacement's id in the same
    // write, as the row's CHECK demands.
    await client.query(
      `update notices set
          state = 'superseded',
          superseded_at = $2,
          superseded_by = $3,
          superseded_by_notice_id = $4,
          updated_at = $2
        where id = $1`,
      [input.noticeId, deps.now().toISOString(), input.operatorId, replacement.noticeId],
    );
    await client.query("commit");
    return { status: "superseded", noticeId: input.noticeId, replacementNoticeId: replacement.noticeId };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
