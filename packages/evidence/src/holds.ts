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

function holdRow(row: Record<string, unknown>): LegalHoldRow {
  return {
    id: row.id as string,
    reason: row.reason as string,
    evidenceIds: (row.evidence_ids ?? []) as string[],
    violationIds: (row.violation_ids ?? []) as string[],
    noticeIds: (row.notice_ids ?? []) as string[],
    createdBy: row.created_by as string,
    createdAt: row.created_at as Date,
    releasedAt: (row.released_at ?? null) as Date | null,
    releasedBy: (row.released_by ?? null) as string | null,
    releaseReason: (row.release_reason ?? null) as string | null,
  };
}

/**
 * Places a hold. The scopes are the contract's: at least one of the three
 * id lists must be non-empty (the database CHECK enforces the same), and
 * the ids are recorded verbatim — a hold naming an unknown id still stands,
 * because the operator's instruction is the fact and the id may name a row
 * a concurrent purge had already marked.
 */
export async function placeLegalHold(
  pool: Pool,
  now: () => Date,
  input: {
    reason: string;
    evidenceIds?: readonly string[];
    violationIds?: readonly string[];
    noticeIds?: readonly string[];
    createdBy: string;
  },
): Promise<LegalHoldRow> {
  const result = await pool.query(
    `insert into legal_holds
       (reason, evidence_ids, violation_ids, notice_ids, created_by, created_at)
     values ($1, $2::uuid[], $3::uuid[], $4::uuid[], $5, $6)
     returning *`,
    [
      input.reason,
      (input.evidenceIds ?? []) as string[],
      (input.violationIds ?? []) as string[],
      (input.noticeIds ?? []) as string[],
      input.createdBy,
      now(),
    ],
  );
  return holdRow(result.rows[0]);
}

/** One page of holds, newest first. */
export async function listLegalHolds(
  pool: Pool,
  paging: { limit: number; offset: number },
): Promise<{ rows: LegalHoldRow[]; total: number }> {
  const rows = await pool.query(
    `select * from legal_holds
      order by created_at desc, id
      limit $1 offset $2`,
    [paging.limit, paging.offset],
  );
  const total = await pool.query<{ count: string }>(
    "select count(*) as count from legal_holds",
  );
  return { rows: rows.rows.map(holdRow), total: Number(total.rows[0].count) };
}

/** What releasing a hold produced. */
export type ReleaseHoldResult =
  | { status: "released"; row: LegalHoldRow }
  | { status: "already_released"; row: LegalHoldRow }
  | { status: "absent" };

/**
 * An administrator's explicit release. The release trio (who, when, why) is
 * recorded on the row; the hold's scope is frozen at placement. The next
 * retention run after the release purges whatever the hold suspended.
 */
export async function releaseLegalHold(
  pool: Pool,
  now: () => Date,
  input: { legalHoldId: string; operatorId: string; reason: string },
): Promise<ReleaseHoldResult> {
  const result = await pool.query(
    `update legal_holds
       set released_at = $2, released_by = $3, release_reason = $4
     where id = $1 and released_at is null
     returning *`,
    [input.legalHoldId, now(), input.operatorId, input.reason],
  );
  if (result.rows.length === 0) {
    const existing = await pool.query("select * from legal_holds where id = $1", [
      input.legalHoldId,
    ]);
    if (existing.rows.length === 0) {
      return { status: "absent" };
    }
    return { status: "already_released", row: holdRow(existing.rows[0]) };
  }
  return { status: "released", row: holdRow(result.rows[0]) };
}

/**
 * The active-hold coverage over one evidence row, as a SQL boolean
 * expression referencing the aliases the retention query provides
 * (`e` the evidence row, `ve` a citation_evidence join it may use). A hold
 * covers a capture directly (its id), through any violation that cites it,
 * or through any notice whose pinned citations name it. Only ACTIVE holds
 * (`released_at is null`) cover anything — a released hold suspends
 * nothing, which is the point of releasing it.
 */
export const ACTIVE_HOLD_COVERS_EVIDENCE = `exists (
  select 1 from legal_holds h
   where h.released_at is null
     and (
       e.id = any (h.evidence_ids)
       or exists (
         select 1 from violation_evidence ve
          where ve.evidence_id = e.id and ve.violation_id = any (h.violation_ids)
       )
       or exists (
         select 1 from notice_citations nc
          where nc.evidence @> jsonb_build_array(
                  jsonb_build_object('evidenceId', e.id)
                )
            and nc.notice_id = any (h.notice_ids)
       )
     )
)`;
