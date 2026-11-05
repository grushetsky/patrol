import type { Pool } from "pg";
import { type ComposeOutcome } from "./compose.js";
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
export type SupersessionRefusal = {
    status: "absent";
} | {
    status: "state_conflict";
    currentState: string;
} | {
    status: "already_filed";
    submissionState: "delivered" | "acknowledged";
} | {
    status: "empty_set";
} | {
    status: "identical_set";
} | {
    status: "compose_refused";
    outcome: Exclude<ComposeOutcome, {
        status: "composed";
    }>["refusal"];
};
export type SupersessionOutcome = {
    status: "superseded";
    noticeId: string;
    replacementNoticeId: string;
} | {
    status: "refused";
    refusal: SupersessionRefusal;
};
export interface SupersessionInput {
    noticeId: string;
    operatorId: string;
    citedViolationIds: string[];
}
/**
 * Supersedes an approved notice with a replacement draft carrying the
 * corrected citation set.
 */
export declare function supersedeNotice(deps: SupersessionDeps, input: SupersessionInput): Promise<SupersessionOutcome>;
