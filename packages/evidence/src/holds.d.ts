import type { Pool } from "pg";
/**
 * Legal holds (docs/design/evidence-capture.md "Retention"; ADR 0017): a
 * hold — a dispute, a counter-notice, a threatened claim, or an operator's
 * own instruction — outranks every other retention rule and suspends every
 * purge path it covers until released. The release is itself recorded with
 * its operator and its reason, and a released hold row stays in the history.
 *
 * The scopes are evidence ids, violation ids, and notice ids, exactly the
 * contract's CreateLegalHoldRequest: a hold on a violation covers every
 * capture it cites, and a hold on a notice covers every capture its pinned
 * citations name — the coverage joins the retention job runs are the ones
 * the citation tables already answer.
 */
/** One legal hold row (the contract's LegalHold plus the release reason). */
export interface LegalHoldRow {
    id: string;
    reason: string;
    evidenceIds: string[];
    violationIds: string[];
    noticeIds: string[];
    createdBy: string;
    createdAt: Date;
    releasedAt: Date | null;
    releasedBy: string | null;
    releaseReason: string | null;
}
/**
 * Places a hold. The scopes are the contract's: at least one of the three
 * id lists must be non-empty (the database CHECK enforces the same), and
 * the ids are recorded verbatim — a hold naming an unknown id still stands,
 * because the operator's instruction is the fact and the id may name a row
 * a concurrent purge had already marked.
 */
export declare function placeLegalHold(pool: Pool, now: () => Date, input: {
    reason: string;
    evidenceIds?: readonly string[];
    violationIds?: readonly string[];
    noticeIds?: readonly string[];
    createdBy: string;
}): Promise<LegalHoldRow>;
/** One page of holds, newest first. */
export declare function listLegalHolds(pool: Pool, paging: {
    limit: number;
    offset: number;
}): Promise<{
    rows: LegalHoldRow[];
    total: number;
}>;
/** What releasing a hold produced. */
export type ReleaseHoldResult = {
    status: "released";
    row: LegalHoldRow;
} | {
    status: "already_released";
    row: LegalHoldRow;
} | {
    status: "absent";
};
/**
 * An administrator's explicit release. The release trio (who, when, why) is
 * recorded on the row; the hold's scope is frozen at placement. The next
 * retention run after the release purges whatever the hold suspended.
 */
export declare function releaseLegalHold(pool: Pool, now: () => Date, input: {
    legalHoldId: string;
    operatorId: string;
    reason: string;
}): Promise<ReleaseHoldResult>;
/**
 * The active-hold coverage over one evidence row, as a SQL boolean
 * expression referencing the aliases the retention query provides
 * (`e` the evidence row, `ve` a citation_evidence join it may use). A hold
 * covers a capture directly (its id), through any violation that cites it,
 * or through any notice whose pinned citations name it. Only ACTIVE holds
 * (`released_at is null`) cover anything — a released hold suspends
 * nothing, which is the point of releasing it.
 */
export declare const ACTIVE_HOLD_COVERS_EVIDENCE = "exists (\n  select 1 from legal_holds h\n   where h.released_at is null\n     and (\n       e.id = any (h.evidence_ids)\n       or exists (\n         select 1 from violation_evidence ve\n          where ve.evidence_id = e.id and ve.violation_id = any (h.violation_ids)\n       )\n       or exists (\n         select 1 from notice_citations nc\n          where nc.evidence @> jsonb_build_array(\n                  jsonb_build_object('evidenceId', e.id)\n                )\n            and nc.notice_id = any (h.notice_ids)\n       )\n     )\n)";
