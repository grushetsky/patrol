import type { Pool } from "pg";
import {
  citationsForViolation,
  mapViolation,
  readViolation,
  recordOperatorClosure,
  type ViolationRow,
} from "@patrol/scans";
import { ApiError } from "../../errors.js";
import { pageParams } from "../../routes/support.js";
import {
  evidenceJson,
  newestEvidenceBy,
  reviewDecisionsFor,
  reviewDecisionJson,
  type NewestEvidence,
} from "../candidates.js";
import { violationJson } from "./serialize.js";

/**
 * The Violations interface's domain (Patrol.Http): the list with its
 * filters (tracked title, state, notice), the detail with its citations
 * and confirming decision, and the operator closure. Removal is the
 * worker's path — a capture that shows the URL gone — and lives in the
 * shared store (`recordRemovalsForDeadCapture`); the closure here and that
 * removal there are the same one forward step out of open, both terminal.
 */

const VIOLATION_LIST_SELECT = `select v.*, t.release_year, t.title_type, ov.text as display_title
  from violations v
  join tracked_titles t on t.id = v.tracked_title_id
  join title_variants ov on ov.id = t.original_variant_id`;

/** The list filters the contract's GET /violations declares. */
export interface ViolationListFilter {
  trackedTitleId?: string;
  state?: "open" | "removed" | "closed";
  noticeId?: string;
}

/**
 * A page of violations, newest first. The `noticeId` filter scopes the
 * page to the violations one notice cites, through the citations the
 * notice composer wrote.
 */
export async function listViolations(
  pool: Pool,
  query: Record<string, unknown>,
): Promise<{
  items: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const { page, pageSize, limit, offset } = pageParams(query);
  const enumFilter = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
    typeof value === "string" && (allowed as readonly string[]).includes(value)
      ? (value as T)
      : undefined;
  const filter: ViolationListFilter = {
    trackedTitleId:
      typeof query.trackedTitleId === "string" && query.trackedTitleId !== ""
        ? query.trackedTitleId
        : undefined,
    state: enumFilter(query.state, ["open", "removed", "closed"] as const),
    noticeId:
      typeof query.noticeId === "string" && query.noticeId !== "" ? query.noticeId : undefined,
  };

  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filter.trackedTitleId !== undefined) {
    values.push(filter.trackedTitleId);
    conditions.push(`v.tracked_title_id = $${values.length}`);
  }
  if (filter.state !== undefined) {
    values.push(filter.state);
    conditions.push(`v.state = $${values.length}`);
  }
  if (filter.noticeId !== undefined) {
    values.push(filter.noticeId);
    conditions.push(
      `exists (select 1 from notice_citations c where c.notice_id = $${values.length} and c.violation_id = v.id)`,
    );
  }
  const where = conditions.length === 0 ? "" : `where ${conditions.join(" and ")}`;

  type RawListRow = Parameters<typeof mapViolation>[0] & {
    release_year: number;
    title_type: string;
    display_title: string;
  };
  const rows = await pool.query<RawListRow>(
    `${VIOLATION_LIST_SELECT} ${where}
      order by v.confirmed_at desc, v.id
      limit $${values.length + 1} offset $${values.length + 2}`,
    [...values, limit, offset],
  );
  const total = await pool.query<{ count: string }>(
    `select count(*) as count from violations v ${where}`,
    values,
  );

  const violations = rows.rows.map(mapViolation);
  const evidence = await newestEvidenceBy(
    pool,
    violations.map((violation) => violation.normalizedUrl),
  );
  return {
    items: violations.map((violation, index) => ({
      violation: violationJson(violation),
      displayTitle: rows.rows[index].display_title,
      releaseYear: Number(rows.rows[index].release_year),
      titleType: rows.rows[index].title_type,
      ...(evidence.get(violation.normalizedUrl) === undefined
        ? {}
        : { newestEvidence: evidenceJson(evidence.get(violation.normalizedUrl)!) }),
    })),
    total: Number(total.rows[0].count),
    page,
    pageSize,
  };
}

/** The contract's ViolationDetail for one violation. */
export async function readViolationDetail(
  pool: Pool,
  violationId: string,
): Promise<Record<string, unknown>> {
  const violation = await readViolation(pool, violationId);
  if (violation === null) {
    throw new ApiError(404, "not_found");
  }
  const title = await pool.query<{
    release_year: number;
    title_type: string;
    original_variant_id: string;
  }>(
    "select release_year, title_type, original_variant_id from tracked_titles where id = $1",
    [violation.trackedTitleId],
  );
  const display = await pool.query<{ text: string }>(
    "select text from title_variants where id = $1",
    [title.rows[0].original_variant_id],
  );

  // The citations, newest first, with each capture's summary joined in.
  const citations = await citationsForViolation(pool, violation.id);
  const citedRows = await pool.query(
    "select * from evidence where id = any($1::uuid[]) order by observed_at desc, id",
    [citations.length === 0 ? [] : citations.map((citation) => citation.evidenceId)],
  );
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of citedRows.rows as Array<Record<string, unknown>>) {
    byId.set(row.id as string, row);
  }
  const evidence = citations
    .filter((citation) => byId.has(citation.evidenceId))
    .map((citation) => {
      const row = byId.get(citation.evidenceId)!;
      return {
        evidence: evidenceJson({
          normalizedUrl: row.normalized_url as string,
          id: row.id as string,
          reason: row.reason as string,
          outcome: row.outcome as string,
          observedAt: row.observed_at as Date,
          httpStatus: (row.http_status ?? null) as number | null,
          finalUrl: (row.final_url ?? null) as string | null,
          host: (row.host ?? null) as string | null,
          purgedAt: (row.purged_at ?? null) as Date | null,
          thumbnail: null,
        }),
        role: citation.role,
        citedAt: citation.citedAt.toISOString(),
      };
    });

  // The confirming decision always exists — the violation row carries its
  // non-null foreign key — so the find cannot miss; the assertion is for
  // the type, not for a case the schema allows. The history read is
  // pair-scoped like every decision history, and the violation's own
  // decision is found within it.
  const decision = (
    await reviewDecisionsFor(pool, {
      normalizedUrl: violation.normalizedUrl,
      trackedTitleId: violation.trackedTitleId,
    })
  ).find((row) => row.id === violation.reviewDecisionId)!;

  // The newest capture of any outcome — the flag that names a dead or
  // blocked page at handoff rather than dropping it.
  const newest = await newestEvidenceBy(pool, [violation.normalizedUrl]);
  const newestCapture: NewestEvidence | undefined = newest.get(violation.normalizedUrl);

  return {
    violation: violationJson(violation),
    displayTitle: display.rows[0].text,
    releaseYear: Number(title.rows[0].release_year),
    titleType: title.rows[0].title_type,
    evidence,
    decision: reviewDecisionJson(decision),
    ...(newestCapture === undefined
      ? {}
      : { newestCaptureOutcome: newestCapture.outcome }),
  };
}

/**
 * An operator's closure of an open violation after a re-check: a note is
 * required when the reason is operator_closed, and a closed or removed
 * violation is terminal — the second attempt answers `state_conflict`.
 * Recording that the URL stopped serving the copy (reason `url_removed`)
 * is the same operator path the design names beside the worker's.
 */
export async function closeViolationRoute(
  pool: Pool,
  now: () => Date,
  operatorId: string,
  violationId: string,
  body: { reason: "url_removed" | "operator_closed"; note?: string; evidenceId?: string },
): Promise<ViolationRow> {
  if (body.reason === "operator_closed" && (body.note ?? "").trim() === "") {
    throw new ApiError(422, "note_required", {
      fieldErrors: [{ path: "/note", message: "required when the reason is operator_closed" }],
    });
  }
  const outcome = await recordOperatorClosure(pool, now, {
    violationId,
    operatorId,
    reason: body.reason,
    note: body.note ?? null,
    evidenceId: body.evidenceId ?? null,
  });
  switch (outcome.status) {
    case "closed":
      return outcome.violation;
    case "not_open":
      throw new ApiError(409, "state_conflict", { currentState: outcome.violation.state });
    case "absent":
      throw new ApiError(404, "not_found");
  }
}
