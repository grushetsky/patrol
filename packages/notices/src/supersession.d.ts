import type { Pool } from "pg";
import { type ComposeOutcome } from "./compose.js";
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
export type SupersessionRefusal = {
    status: "absent";
} | {
    status: "state_conflict";
    currentState: string;
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
