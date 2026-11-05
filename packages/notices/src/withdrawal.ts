import type { Pool } from "pg";

/**
 * Withdrawal (docs/design/notice-composition.md "Approval"): a draft may be
 * withdrawn while it is still a draft, and an approved notice while its
 * submission is still `Pending`. Withdrawal releases the cited violations
 * for a later draft (the citations' state mirror moves, which the freeze
 * trigger sanctions), cancels the pending submission, and refuses once the
 * submission has been delivered or acknowledged — a wrong notice is
 * corrected by a new notice, and the recipient's process handles the old
 * one.
 */

export interface WithdrawalDeps {
  pool: Pool;
  now: () => Date;
}

export type WithdrawalRefusal =
  | { status: "absent" }
  | { status: "state_conflict"; currentState: string }
  | { status: "not_withdrawable"; submissionState: string };

export type WithdrawalOutcome =
  | { status: "withdrawn"; noticeId: string }
  | { status: "refused"; refusal: WithdrawalRefusal };

export interface WithdrawalInput {
  noticeId: string;
  operatorId: string;
  reason?: string;
}

/** Withdraws a draft, or an approved notice whose submission is pending. */
export async function withdrawNotice(
  deps: WithdrawalDeps,
  input: WithdrawalInput,
): Promise<WithdrawalOutcome> {
  const client = await deps.pool.connect();
  try {
    await client.query("begin");
    const notice = await client.query<{ state: string }>(
      "select state from notices where id = $1 for update",
      [input.noticeId],
    );
    const row = notice.rows[0];
    if (row === undefined) {
      await client.query("rollback");
      return { status: "refused", refusal: { status: "absent" } };
    }
    if (row.state === "withdrawn" || row.state === "superseded") {
      await client.query("rollback");
      return {
        status: "refused",
        refusal: { status: "state_conflict", currentState: row.state },
      };
    }
    if (row.state === "approved") {
      // Only while the submission is still pending (or has not settled yet).
      const submission = await client.query<{ id: string; state: string }>(
        "select id, state from submissions where notice_id = $1 for update",
        [input.noticeId],
      );
      const submissionRow = submission.rows[0];
      if (submissionRow !== undefined && submissionRow.state !== "pending") {
        await client.query("rollback");
        return {
          status: "refused",
          refusal: { status: "not_withdrawable", submissionState: submissionRow.state },
        };
      }
      if (submissionRow !== undefined) {
        await client.query(
          "update submissions set cancelled_at = $2 where id = $1",
          [submissionRow.id, deps.now().toISOString()],
        );
      }
    }

    await client.query(
      `update notices set
          state = 'withdrawn',
          withdrawn_by = $2,
          withdrawn_at = $3,
          withdrawal_reason = $4,
          updated_at = $3
        where id = $1`,
      [input.noticeId, input.operatorId, deps.now().toISOString(), input.reason ?? null],
    );
    // The release: the citations leave the active set, so both the
    // reservation and the recipient-level dedup free the violations. The
    // state-only mirror write is exactly what the freeze trigger permits.
    await client.query(
      "update notice_citations set state = 'withdrawn' where notice_id = $1",
      [input.noticeId],
    );
    await client.query("commit");
    return { status: "withdrawn", noticeId: input.noticeId };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
