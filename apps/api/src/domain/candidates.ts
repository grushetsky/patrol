import type { Pool } from "pg";
import {
  candidateForPair,
  formManualCandidate,
  loadTitleForMatching,
  mapCandidate,
  readCandidate,
  type CandidateRow,
  type EnqueueDetectionCapture,
  type RawCandidateRow,
} from "@patrol/scans";
import { ApiError } from "../errors.js";
import { pageParams } from "../routes/support.js";

/**
 * The Candidates interface's domain (Patrol.Http): the manual pair creation
 * with its 200-existing / 201-new dedup answer, and the review-queue read
 * models — the list with its fixed order (score descending, SERP rank
 * ascending, observation time descending) and the detail with its
 * provenance, evidence, and decisions. Prior review decisions arrive with
 * slice 5b; the row shapes already carry their places.
 */

/** The contract's Candidate shape, with its lifecycle union. */
export function candidateJson(row: CandidateRow): Record<string, unknown> {
  const base = {
    id: row.id,
    trackedTitleId: row.trackedTitleId,
    url: row.url,
    normalizedUrl: row.normalizedUrl,
    host: row.host,
    registrableDomain: row.registrableDomain,
    matchedVariantId: row.matchedVariantId,
    matchedVariant: row.matchedVariant,
    score: row.score,
    scoreComponents: row.scoreComponents,
    reputation: row.reputation,
    ...(row.allowlistEntryId === null ? {} : { allowlistEntryId: row.allowlistEntryId }),
    firstObservedAt: row.firstSeenAt.toISOString(),
    lastObservedAt: row.lastObservedAt.toISOString(),
    priorDecisionIds: [] as string[],
  };
  switch (row.state) {
    case "pending":
      return { ...base, lifecycle: { state: "pending" } };
    case "confirmed":
      return {
        ...base,
        lifecycle: {
          state: "confirmed",
          reviewDecisionId: row.reviewDecisionId!,
          violationId: row.violationId!,
          confirmedAt: row.confirmedAt!.toISOString(),
        },
      };
    case "dismissed":
      return {
        ...base,
        lifecycle: {
          state: "dismissed",
          reviewDecisionId: row.reviewDecisionId!,
          dismissal: row.dismissal ?? {},
        },
      };
  }
}

/**
 * Pairs a URL an operator typed with one tracked title. The URL must be an
 * absolute HTTP or HTTPS URL and the title must exist and be unmerged; a
 * pair that already stands is returned unchanged (`created: false` — the
 * route answers 200), a new one is formed with the operator as actor
 * (`created: true` — 201). A new pair without an allowlist hit enqueues its
 * detection capture through the injected port.
 */
export async function createManualCandidate(
  pool: Pool,
  now: () => Date,
  input: {
    operatorId: string;
    url: string;
    trackedTitleId: string;
    enqueueCapture?: EnqueueDetectionCapture;
  },
): Promise<{ candidate: CandidateRow; created: boolean }> {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw new ApiError(422, "unprocessable", {
      fieldErrors: [{ path: "/url", message: "not an absolute HTTP or HTTPS URL" }],
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ApiError(422, "unprocessable", {
      fieldErrors: [{ path: "/url", message: "not an absolute HTTP or HTTPS URL" }],
    });
  }
  const title = await loadTitleForMatching(pool, input.trackedTitleId);
  if (title === null) {
    throw new ApiError(422, "unprocessable", {
      fieldErrors: [{ path: "/trackedTitleId", message: "no such tracked title" }],
    });
  }
  // The dedup answer is decided by the same key the store upserts under, so
  // a raced second request can only return the row that already stands.
  const existing = await candidateForPair(pool, {
    url: input.url,
    trackedTitleId: input.trackedTitleId,
  });
  if (existing !== null) {
    return { candidate: existing, created: false };
  }
  const outcome = await formManualCandidate(pool, now, {
    url: input.url,
    trackedTitleId: input.trackedTitleId,
    operatorId: input.operatorId,
    ...(input.enqueueCapture === undefined
      ? {}
      : { enqueueCapture: input.enqueueCapture }),
  });
  return { candidate: outcome.candidate, created: outcome.created };
}

/** One review-queue row's columns, the read model's own shape. */
interface ReviewRowColumns {
  candidate: CandidateRow;
  displayTitle: string;
  releaseYear: number;
  titleType: string;
  allowlistEntry: {
    id: string;
    kind: string;
    value: string;
    scope: string;
    territory: string | null;
  } | null;
}

const REVIEW_SELECT = `select c.*, t.release_year, t.title_type, v.text as display_title,
    a.id as allowlist_id, a.kind as allowlist_kind, a.value as allowlist_value,
    a.scope as allowlist_scope, a.territory as allowlist_territory
  from candidates c
  join tracked_titles t on t.id = c.tracked_title_id
  join title_variants v on v.id = t.original_variant_id
  left join allowlist_entries a on a.id = c.allowlist_entry_id`;

type RawReviewRow = Record<string, unknown> & {
  release_year: number;
  title_type: string;
  display_title: string;
  allowlist_id: string | null;
  allowlist_kind: string | null;
  allowlist_value: string | null;
  allowlist_scope: string | null;
  allowlist_territory: string | null;
};

function mapReviewRow(row: RawReviewRow): ReviewRowColumns {
  const candidate = mapCandidate(row as unknown as RawCandidateRow);
  return {
    candidate,
    displayTitle: row.display_title,
    releaseYear: Number(row.release_year),
    titleType: row.title_type,
    allowlistEntry:
      row.allowlist_id === null
        ? null
        : {
            id: row.allowlist_id,
            kind: row.allowlist_kind!,
            value: row.allowlist_value!,
            scope: row.allowlist_scope!,
            territory: row.allowlist_territory ?? null,
          },
  };
}

/** One EvidenceSummary row, the newest capture of one URL. */
interface NewestEvidence {
  normalizedUrl: string;
  id: string;
  reason: string;
  outcome: string;
  observedAt: Date;
  httpStatus: number | null;
  finalUrl: string | null;
  host: string | null;
  purgedAt: Date | null;
  thumbnail: { sha256: string; contentType: string; byteSize: number; width: number | null; height: number | null; truncated: boolean } | null;
}

/** The thumbnail artifact of each evidence row, by evidence id. */
async function thumbnailsByEvidenceId(
  pool: Pool,
  evidenceIds: string[],
): Promise<Map<string, NewestEvidence["thumbnail"]>> {
  if (evidenceIds.length === 0) {
    return new Map();
  }
  const thumbnails = await pool.query(
    `select evidence_id, sha256, content_type, size_bytes, width, height, truncated
       from evidence_artifacts where kind = 'thumbnail' and evidence_id = any($1::uuid[])`,
    [evidenceIds],
  );
  const map = new Map<string, NewestEvidence["thumbnail"]>();
  for (const artifact of thumbnails.rows as Array<Record<string, unknown>>) {
    map.set(artifact.evidence_id as string, {
      sha256: artifact.sha256 as string,
      contentType: artifact.content_type as string,
      byteSize: Number(artifact.size_bytes),
      width: artifact.width === null ? null : Number(artifact.width),
      height: artifact.height === null ? null : Number(artifact.height),
      truncated: artifact.truncated === true,
    });
  }
  return map;
}

async function newestEvidenceBy(
  pool: Pool,
  normalizedUrls: string[],
): Promise<Map<string, NewestEvidence>> {
  if (normalizedUrls.length === 0) {
    return new Map();
  }
  const evidence = await pool.query(
    `select distinct on (normalized_url) * from evidence
      where normalized_url = any($1::text[])
      order by normalized_url, observed_at desc, id`,
    [normalizedUrls],
  );
  const byEvidence = new Map<string, NewestEvidence>();
  for (const row of evidence.rows as Array<Record<string, unknown>>) {
    byEvidence.set(row.id as string, {
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
    });
  }
  const thumbnails = await thumbnailsByEvidenceId(pool, [...byEvidence.keys()]);
  for (const [id, entry] of byEvidence) {
    entry.thumbnail = thumbnails.get(id) ?? null;
  }
  return new Map([...byEvidence.values()].map((entry) => [entry.normalizedUrl, entry]));
}

function evidenceJson(entry: NewestEvidence): Record<string, unknown> {
  // Contract gap, frozen with slice 5a: EvidenceSummary carries only the
  // thumbnail among artifacts, so the rendered DOM's sha — recorded in
  // evidence_artifacts like every artifact — has no contract field to ride
  // in here. The bytes stay reachable per artifact through the evidence
  // download route; a summary field for the DOM sha is a contract change,
  // not a filler.
  return {
    id: entry.id,
    reason: entry.reason,
    outcome: entry.outcome,
    observedAt: entry.observedAt.toISOString(),
    ...(entry.httpStatus === null ? {} : { httpStatus: entry.httpStatus }),
    ...(entry.finalUrl === null ? {} : { finalUrl: entry.finalUrl }),
    ...(entry.host === null ? {} : { host: entry.host }),
    ...(entry.thumbnail === null
      ? {}
      : {
          thumbnail: {
            kind: "thumbnail",
            sha256: entry.thumbnail.sha256,
            contentType: entry.thumbnail.contentType,
            byteSize: entry.thumbnail.byteSize,
            ...(entry.thumbnail.width === null ? {} : { width: entry.thumbnail.width }),
            ...(entry.thumbnail.height === null ? {} : { height: entry.thumbnail.height }),
            truncated: entry.thumbnail.truncated,
          },
        }),
    purged: entry.purgedAt !== null,
  };
}

/** The contract's CandidateReviewRow for one listed candidate. */
function reviewRowJson(
  columns: ReviewRowColumns,
  newest: NewestEvidence | undefined,
): Record<string, unknown> {
  const { candidate: row } = columns;
  return {
    id: row.id,
    trackedTitleId: row.trackedTitleId,
    displayTitle: columns.displayTitle,
    releaseYear: columns.releaseYear,
    titleType: columns.titleType,
    matchedVariant: row.matchedVariant,
    url: row.url,
    ...(newest?.finalUrl === undefined || newest.finalUrl === null
      ? {}
      : { finalUrl: newest.finalUrl }),
    host: row.host,
    registrableDomain: row.registrableDomain,
    source: row.source,
    ...(row.engine === null ? {} : { engine: row.engine }),
    ...(row.bestRank === null ? {} : { rank: row.bestRank }),
    ...(row.queryText === null ? {} : { queryText: row.queryText }),
    ...(row.locale === null ? {} : { locale: row.locale }),
    ...(row.territory === null ? {} : { territory: row.territory }),
    score: row.score,
    scoreComponents: row.scoreComponents,
    reputation: row.reputation,
    ...(columns.allowlistEntry === null
      ? {}
      : {
          allowlistEntry: {
            id: columns.allowlistEntry.id,
            kind: columns.allowlistEntry.kind,
            value: columns.allowlistEntry.value,
            scope: columns.allowlistEntry.scope,
            ...(columns.allowlistEntry.territory === null
              ? {}
              : { territory: columns.allowlistEntry.territory }),
          },
        }),
    // Slice 5b fills the pair's prior decisions; none can exist yet.
    ...(newest === undefined ? {} : { newestEvidence: evidenceJson(newest) }),
    firstObservedAt: row.firstSeenAt.toISOString(),
    lastObservedAt: row.lastObservedAt.toISOString(),
    lifecycle:
      row.state === "pending"
        ? { state: "pending" }
        : row.state === "confirmed"
          ? { state: "confirmed" }
          : { state: "dismissed" },
  };
}

/** The list filters the contract's GET /candidates declares. */
export interface CandidateListFilter {
  state?: "pending" | "confirmed" | "dismissed";
  titleGroupId?: string;
  engine?: "google" | "bing" | "yandex";
  band?: "a" | "b" | "c";
  allowlistHit?: boolean;
  hostObjectionId?: string;
}

/**
 * The review queue, filtered and ordered exactly as the design fixes it:
 * score descending, then SERP rank ascending, then observation time
 * descending (docs/design/matching-and-classification-rules.md "Review
 * queue"). Manual entries carry no rank and sort after ranked rows.
 */
export async function listCandidates(
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
  const filter: CandidateListFilter = {
    state: enumFilter(query.state, ["pending", "confirmed", "dismissed"] as const),
    titleGroupId: typeof query.titleGroupId === "string" && query.titleGroupId !== "" ? query.titleGroupId : undefined,
    engine: enumFilter(query.engine, ["google", "bing", "yandex"] as const),
    band: enumFilter(query.band, ["a", "b", "c"] as const),
    allowlistHit: query.allowlistHit === "true" ? true : query.allowlistHit === "false" ? false : undefined,
    hostObjectionId: typeof query.hostObjectionId === "string" && query.hostObjectionId !== "" ? query.hostObjectionId : undefined,
  };

  const conditions: string[] = [];
  const values: unknown[] = [];
  /** Pushes one condition whose `?` placeholders take the next parameters in order. */
  const add = (fragment: string, ...bindings: unknown[]): void => {
    let index = 0;
    conditions.push(
      fragment.replace(/\?/g, () => {
        index += 1;
        values.push(bindings[index - 1]);
        return `$${values.length}`;
      }),
    );
  };
  if (filter.state !== undefined) {
    add("c.state = ?", filter.state);
  }
  if (filter.titleGroupId !== undefined) {
    add("t.title_group_id = ?", filter.titleGroupId);
  }
  if (filter.engine !== undefined) {
    // The queue filters by the engines that ever surfaced the pair, which
    // includes the first engine the row names.
    add("? = any(c.engines)", filter.engine);
  }
  if (filter.band === undefined) {
    // Band C is suppressed and never reaches the queue; an explicit band
    // filter is the operator's way to see a suppressed set on purpose.
    conditions.push("c.band <> 'c'");
  } else {
    add("c.band = ?", filter.band);
  }
  if (filter.allowlistHit !== undefined) {
    add("(c.allowlist_entry_id is not null) = ?", filter.allowlistHit);
  }
  if (filter.hostObjectionId !== undefined) {
    add(
      `exists (
         select 1 from host_objections o
          where o.id = ?
            and o.cleared_at is null
            and (c.host = o.host or right(c.host, length(o.host) + 1) = '.' || o.host)
       )`,
      filter.hostObjectionId,
    );
  }
  const where = conditions.length === 0 ? "" : `where ${conditions.join(" and ")}`;

  const rows = await pool.query<RawReviewRow>(
    `${REVIEW_SELECT} ${where}
      order by c.score desc, c.best_rank asc nulls last, c.last_observed_at desc, c.id
      limit $${values.length + 1} offset $${values.length + 2}`,
    [...values, limit, offset],
  );
  const total = await pool.query<{ count: string }>(
    `select count(*) as count from candidates c join tracked_titles t on t.id = c.tracked_title_id ${where}`,
    values,
  );

  const mapped = rows.rows.map(mapReviewRow);
  const evidence = await newestEvidenceBy(
    pool,
    mapped.map((entry) => entry.candidate.normalizedUrl),
  );
  return {
    items: mapped.map((entry) => reviewRowJson(entry, evidence.get(entry.candidate.normalizedUrl))),
    total: Number(total.rows[0].count),
    page,
    pageSize,
  };
}

/** The contract's CandidateDetail, with provenance and evidence. */
export async function readCandidateDetail(
  pool: Pool,
  candidateId: string,
): Promise<Record<string, unknown>> {
  const row = await readCandidate(pool, candidateId);
  if (row === null) {
    throw new ApiError(404, "not_found");
  }
  const title = await pool.query<{
    release_year: number;
    title_type: string;
    original_variant_id: string;
  }>(
    "select release_year, title_type, original_variant_id from tracked_titles where id = $1",
    [row.trackedTitleId],
  );
  const display = await pool.query<{ text: string }>(
    "select text from title_variants where id = $1",
    [title.rows[0].original_variant_id],
  );
  const observations = await pool.query(
    `select r.*, s.engine from search_results r join scans s on s.id = r.scan_id
      where r.candidate_id = $1 order by r.observed_at desc, r.rank`,
    [row.id],
  );
  const allEvidence = await pool.query(
    `select * from evidence where normalized_url = $1 order by observed_at desc, id`,
    [row.normalizedUrl],
  );
  const thumbnails = await thumbnailsByEvidenceId(
    pool,
    (allEvidence.rows as Array<{ id: string }>).map((entry) => entry.id),
  );
  const allowlist = row.allowlistEntryId === null
    ? null
    : await pool.query(`select * from allowlist_entries where id = $1`, [row.allowlistEntryId]);

  return {
    candidate: candidateJson(row),
    displayTitle: display.rows[0].text,
    releaseYear: Number(title.rows[0].release_year),
    titleType: title.rows[0].title_type,
    observations: observations.rows.map((observation) => ({
      id: observation.id,
      scanId: observation.scan_id,
      queryId: observation.query_id,
      engine: observation.engine,
      url: observation.url,
      normalizedUrl: observation.normalized_url,
      rank: Number(observation.rank),
      title: observation.title,
      snippet: observation.snippet,
      locale: observation.locale,
      ...(observation.territory === null ? {} : { territory: observation.territory }),
      observedAt: new Date(observation.observed_at).toISOString(),
      rawPayloadRef: observation.raw_payload_ref,
      host: observation.host,
      registrableDomain: observation.registrable_domain,
    })),
    evidence: (allEvidence.rows as Array<Record<string, unknown>>).map((entry) =>
      evidenceJson({
        normalizedUrl: row.normalizedUrl,
        id: entry.id as string,
        reason: entry.reason as string,
        outcome: entry.outcome as string,
        observedAt: entry.observed_at as Date,
        httpStatus: (entry.http_status ?? null) as number | null,
        finalUrl: (entry.final_url ?? null) as string | null,
        host: (entry.host ?? null) as string | null,
        purgedAt: (entry.purged_at ?? null) as Date | null,
        thumbnail: thumbnails.get(entry.id as string) ?? null,
      }),
    ),
    decisions: [],
    ...(allowlist === null || allowlist.rows.length === 0
      ? {}
      : { allowlistEntry: allowlistEntryDetailJson(allowlist.rows[0]) }),
  };
}

/** One allowlist entry the detail shows in full (the contract's own shape). */
function allowlistEntryDetailJson(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    matchKind: row.match_kind,
    value: row.value,
    scope: row.scope,
    ...(row.title_group_id === null ? {} : { titleGroupId: row.title_group_id }),
    ...(row.tracked_title_id === null ? {} : { trackedTitleId: row.tracked_title_id }),
    ...(row.territory === null ? {} : { territory: row.territory }),
    origin: row.origin,
    ...(row.proposed_by_decision_id === null
      ? {}
      : { proposedByDecisionId: row.proposed_by_decision_id }),
    confirmedBy: row.confirmed_by,
    confirmedAt: new Date(row.confirmed_at as Date).toISOString(),
  };
}
