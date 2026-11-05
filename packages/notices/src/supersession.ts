import type { Pool } from "pg";
import { composeInTransaction, type ComposeOutcome } from "./compose.js";
import type { Recipient } from "./statements.js";

/**
 * Supersession (docs/design/notice-composition.md "Approval"): an approved
 * notice whose cited set must change becomes `Superseded`, its pending
 * submission is cancelled, and a replacement draft carries the corrected
 * set — no operator edits an approved notice's contents in place. One
 * transaction holds the whole move: the old citations release their
 * reservations BEFORE the replacement composes (the corrected set may keep
 * most of them), and the composing guards refuse the supersession entire if
 * the corrected set is not composable.
 */

export interface SupersessionDeps {
  pool: Pool;
  now: () => Date;
}

export type SupersessionRefusal =
  | { status: "absent" }
  | { status: "state_conflict"; currentState: string }
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

    // Release the old reservations and cancel the pending submission BEFORE
    // the replacement composes, in the same transaction. The state-only
    // citation mirror write is what the freeze trigger sanctions; the
    // notice's own state flips only once the replacement exists, because
    // the superseded CHECK demands the replacement's id on the same row.
    await client.query(
      "update notice_citations set state = 'superseded' where notice_id = $1",
      [input.noticeId],
    );
    await client.query(
      "update submissions set cancelled_at = $2 where notice_id = $1 and state = 'pending' and cancelled_at is null",
      [input.noticeId, deps.now().toISOString()],
    );

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
