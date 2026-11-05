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
export type WithdrawalRefusal = {
    status: "absent";
} | {
    status: "state_conflict";
    currentState: string;
} | {
    status: "not_withdrawable";
    submissionState: string;
};
export type WithdrawalOutcome = {
    status: "withdrawn";
    noticeId: string;
} | {
    status: "refused";
    refusal: WithdrawalRefusal;
};
export interface WithdrawalInput {
    noticeId: string;
    operatorId: string;
    reason?: string;
}
/** Withdraws a draft, or an approved notice whose submission is pending. */
export declare function withdrawNotice(deps: WithdrawalDeps, input: WithdrawalInput): Promise<WithdrawalOutcome>;
