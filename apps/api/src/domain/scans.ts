import type { Pool } from "pg";
import { ApiError } from "../errors.js";
import type { ScanDispatcher } from "../queue/dispatch.js";
import {
  insertManualScans,
  listScanPage,
  loadScanFailures,
  loadScanQueries,
  resetLadderForManualRequest,
  type ScanRow,
} from "@patrol/scans";

/**
 * The Scans and Rechecks interfaces' domain (Patrol.Http): a manual scan
 * or re-check request, the scan history with its lifecycle, the results a
 * scan recorded as provenance, and the re-check ladders. A manual request
 * queues ahead of scheduled work, preflights the same budget pool, and
 * resets a re-check ladder; it is idempotent on the day — the scan that
 * already stands for the group, engine, and due date is returned
 * unchanged, so neither the scheduler's earlier run nor a duplicate
 * request produces a second scan.
 */

/** The engines a manual request can target. */
const REQUESTABLE_ENGINES = ["google", "yandex"] as const;

/** One engine whose route stands disabled, keyed for a request's dispatching. */
async function disabledEngines(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<{ engine: string }>(
    "select engine from route_state where disabled",
  );
  return new Set(result.rows.map((row) => row.engine));
}

/**
 * Validates and queues a manual scan or manual re-check. The group must
 * exist and a narrowed title must belong to it; beyond that a request
 * queues rather than skips — an engine whose route stands disabled gets
 * its scan row all the same, waiting queued with `route_unavailable`
 * until the hourly probe recovers the engine, exactly as the scheduler's
 * own rows wait. Only a request with nothing that can ever run is
 * refused: naming Bing, which buys no route in v1. Returns the scans the
 * request created or found, one per targeted engine.
 */
export async function requestManualScan(
  pool: Pool,
  now: () => Date,
  input: {
    operatorId: string;
    body: {
      titleGroupId: string;
      trackedTitleId?: string;
      engine?: "google" | "bing" | "yandex";
      trigger: "manual" | "manual_recheck";
    };
  },
  dispatcher: ScanDispatcher,
): Promise<ScanRow[]> {
  const { body } = input;
  const group = await pool.query<{ id: string }>(
    "select id from title_groups where id = $1",
    [body.titleGroupId],
  );
  if (group.rows.length === 0) {
    throw new ApiError(422, "unprocessable");
  }
  if (body.trackedTitleId !== undefined) {
    const title = await pool.query<{ id: string }>(
      "select id from tracked_titles where id = $1 and title_group_id = $2 and merged_into_title_id is null",
      [body.trackedTitleId, body.titleGroupId],
    );
    if (title.rows.length === 0) {
      throw new ApiError(422, "unprocessable");
    }
  }

  if (body.engine === "bing") {
    // Bing buys no route in v1; a request naming it has nothing to run.
    throw new ApiError(422, "unprocessable");
  }
  const engines: ("google" | "yandex")[] =
    body.engine === undefined ? [...REQUESTABLE_ENGINES] : [body.engine];

  const scans = await insertManualScans(pool, now, {
    titleGroupId: body.titleGroupId,
    trackedTitleId: body.trackedTitleId,
    engines,
    trigger: body.trigger,
    createdBy: input.operatorId,
  });

  const disabled = await disabledEngines(pool);
  for (const scan of scans) {
    // A manual request means "look again soon": the pair's ladder resets
    // to rung one anchored here, even when the request returned the day's
    // standing scan and no completion will fire.
    await resetLadderForManualRequest(pool, now, {
      titleGroupId: scan.titleGroupId,
      engine: scan.engine,
      trigger: body.trigger,
      anchorScanId: scan.id,
      anchorFinishedAt: scan.finishedAt,
    });
    if (disabled.has(scan.engine)) {
      // The route is down: the row waits queued with its reason — the
      // probe's recovery wakes the queue — instead of being refused, so
      // the operator's intent survives the outage.
      await pool.query(
        `update scans set failure_reason = 'route_unavailable'
          where id = $1 and state = 'queued' and failure_reason is null`,
        [scan.id],
      );
      scan.failureReason =
        scan.state === "queued" && scan.failureReason === null
          ? "route_unavailable"
          : scan.failureReason;
      continue;
    }
    if (scan.state === "queued" && scan.engine !== "bing") {
      await dispatcher.dispatchScanRun(scan.engine);
    }
  }
  return scans;
}

/** The contract's Scan shape, with its lifecycle union and failures. */
export async function scanJson(
  pool: Pool,
  scan: ScanRow,
  options: { includePlan?: boolean; failures?: ScanFailureRow[] } = {},
): Promise<Record<string, unknown>> {
  const failures = options.failures ?? (await loadScanFailures(pool, scan.id));
  const failureJson = failures.map((failure) => ({
    queryId: failure.queryId,
    reason: failure.reason,
    attempts: failure.attempts,
  }));
  const base = {
    id: scan.id,
    titleGroupId: scan.titleGroupId,
    engine: scan.engine,
    trigger: scan.triggerKind,
    dueDate: scan.dueDate,
    plannedQueries: scan.plannedQueries,
    createdAt: scan.createdAt.toISOString(),
  };
  const withRequester =
    scan.createdBy === null ? {} : { requestedBy: scan.createdBy };

  switch (scan.state) {
    case "queued":
      return {
        ...base,
        ...withRequester,
        lifecycle: {
          state: "queued",
          queuedAt: scan.createdAt.toISOString(),
          ...(scan.failureReason === null
            ? {}
            : { queuedReason: scan.failureReason }),
        },
      };
    case "running":
      return {
        ...base,
        ...withRequester,
        lifecycle: {
          state: "running",
          startedAt: scan.startedAt?.toISOString() ?? scan.createdAt.toISOString(),
        },
      };
    case "succeeded":
      return {
        ...base,
        ...withRequester,
        ...(await planJson(pool, scan, options.includePlan)),
        lifecycle: {
          state: "succeeded",
          startedAt: scan.startedAt?.toISOString() ?? scan.createdAt.toISOString(),
          finishedAt: scan.finishedAt?.toISOString() ?? scan.createdAt.toISOString(),
          issuedQueries: scan.issuedQueries,
        },
      };
    case "partial":
      return {
        ...base,
        ...withRequester,
        ...(await planJson(pool, scan, options.includePlan)),
        lifecycle: {
          state: "partial",
          startedAt: scan.startedAt?.toISOString() ?? scan.createdAt.toISOString(),
          finishedAt: scan.finishedAt?.toISOString() ?? scan.createdAt.toISOString(),
          issuedQueries: scan.issuedQueries,
          failures: failureJson,
        },
      };
    case "failed":
      return {
        ...base,
        ...withRequester,
        ...(await planJson(pool, scan, options.includePlan)),
        lifecycle: {
          state: "failed",
          ...(scan.startedAt === null
            ? {}
            : { startedAt: scan.startedAt.toISOString() }),
          finishedAt: scan.finishedAt?.toISOString() ?? scan.createdAt.toISOString(),
          failureReason: scan.failureReason ?? "provider_error",
          ...(failures.length === 0 ? {} : { failures: failureJson }),
        },
      };
  }
}

/** One failed query inside a scan, as the listing batches them. */
export interface ScanFailureRow {
  queryId: string;
  reason: string;
  attempts: number;
}

/** The plan, when one stands and the caller asked for it. */
async function planJson(
  pool: Pool,
  scan: ScanRow,
  include?: boolean,
): Promise<Record<string, unknown>> {
  if (include !== true) {
    return {};
  }
  const queries = await loadScanQueries(pool, scan.id);
  if (queries.length === 0) {
    return {};
  }
  const variants = await pool.query<{
    query_id: string;
    variant_id: string | null;
    intent_phrase: string | null;
    intent_phrase_version: number | null;
    generated_at: Date;
  }>(
    `select q.id as query_id, q.variant_id, q.intent_phrase, q.intent_phrase_version,
            p.generated_at
       from search_queries q join query_plans p on p.id = q.query_plan_id
      where p.scan_id = $1
      order by q.position`,
    [scan.id],
  );
  const byQuery = new Map(variants.rows.map((row) => [row.query_id, row]));
  return {
    queryPlan: {
      generatedAt: new Date(
        variants.rows[0].generated_at,
      ).toISOString(),
      queries: queries.map((query) => {
        const row = byQuery.get(query.id);
        return {
          id: query.id,
          trackedTitleId: query.trackedTitleId,
          locale: query.locale,
          kind: query.kind,
          text: query.text,
          ...(row?.variant_id == null ? {} : { variantId: row.variant_id }),
          ...(row?.intent_phrase == null
            ? {}
            : {
                intentPhrase: {
                  text: row.intent_phrase,
                  version: Number(row.intent_phrase_version),
                },
              }),
        };
      }),
    },
  };
}

/**
 * One scan's ScanPage row, newest-first listing included. The page reads
 * its rows in one query and batches the failure rows of every listed
 * partial or failed scan into one more, so a page costs three statements
 * whatever its size — the N+1 the per-scan `scanJson` walk would cost is
 * the detail endpoint's shape, not the listing's.
 */
export async function listScans(
  pool: Pool,
  query: Record<string, unknown>,
): Promise<{
  items: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const page = Number.parseInt(String(query.page ?? "1"), 10);
  const pageSize = Number.parseInt(String(query.pageSize ?? "50"), 10);
  const resolvedPage = Number.isInteger(page) && page >= 1 ? page : 1;
  const resolvedSize =
    Number.isInteger(pageSize) && pageSize >= 1 ? Math.min(pageSize, 200) : 50;

  const stringFilter = (value: unknown): string | undefined =>
    typeof value === "string" && value !== "" ? value : undefined;
  const { rows, total } = await listScanPage(pool, {
    titleGroupId: stringFilter(query.titleGroupId),
    engine: stringFilter(query.engine),
    state: stringFilter(query.state),
    trigger: stringFilter(query.trigger),
    dueDate: stringFilter(query.dueDate),
    limit: resolvedSize,
    offset: (resolvedPage - 1) * resolvedSize,
  });

  // The failures of every listed scan that can carry them, in one query;
  // queued, running, and succeeded scans have none to load.
  const withFailures = rows
    .filter((scan) => scan.state === "partial" || scan.state === "failed")
    .map((scan) => scan.id);
  const failuresByScan = new Map<string, ScanFailureRow[]>();
  if (withFailures.length > 0) {
    const failures = await pool.query<{
      scan_id: string;
      query_id: string;
      reason: string;
      attempts: number;
    }>(
      "select scan_id, query_id, reason, attempts from query_failures where scan_id = any($1::uuid[])",
      [withFailures],
    );
    for (const row of failures.rows) {
      const list = failuresByScan.get(row.scan_id) ?? [];
      list.push({
        queryId: row.query_id,
        reason: row.reason,
        attempts: Number(row.attempts),
      });
      failuresByScan.set(row.scan_id, list);
    }
  }

  return {
    items: await Promise.all(
      rows.map((scan) =>
        scanJson(pool, scan, { failures: failuresByScan.get(scan.id) ?? [] }),
      ),
    ),
    total,
    page: resolvedPage,
    pageSize: resolvedSize,
  };
}

/** One scan's results page, as provenance. */
export async function listScanResults(
  pool: Pool,
  scanId: string,
  query: Record<string, unknown>,
): Promise<{
  items: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const page = Number.parseInt(String(query.page ?? "1"), 10);
  const pageSize = Number.parseInt(String(query.pageSize ?? "50"), 10);
  const resolvedPage = Number.isInteger(page) && page >= 1 ? page : 1;
  const resolvedSize =
    Number.isInteger(pageSize) && pageSize >= 1 ? Math.min(pageSize, 200) : 50;
  const result = await pool.query<{
    id: string;
    scan_id: string;
    query_id: string;
    engine: string;
    url: string;
    normalized_url: string;
    rank: number;
    title: string;
    snippet: string;
    locale: string;
    territory: string | null;
    observed_at: Date;
    raw_payload_ref: string;
    host: string;
    registrable_domain: string;
    candidate_id: string | null;
  }>(
    `select r.id, r.scan_id, r.query_id, s.engine, r.url, r.normalized_url,
            r.rank, r.title, r.snippet, r.locale, r.territory, r.observed_at,
            r.raw_payload_ref, r.host, r.registrable_domain, r.candidate_id
       from search_results r
       join scans s on s.id = r.scan_id
      where r.scan_id = $1
      order by r.observed_at, r.rank, r.id
      limit $2 offset $3`,
    [scanId, resolvedSize, (resolvedPage - 1) * resolvedSize],
  );
  const total = await pool.query<{ count: string }>(
    "select count(*) as count from search_results where scan_id = $1",
    [scanId],
  );
  return {
    items: result.rows.map((row) => ({
      id: row.id,
      scanId: row.scan_id,
      queryId: row.query_id,
      engine: row.engine,
      url: row.url,
      normalizedUrl: row.normalized_url,
      rank: Number(row.rank),
      title: row.title,
      snippet: row.snippet,
      locale: row.locale,
      ...(row.territory === null ? {} : { territory: row.territory }),
      observedAt: new Date(row.observed_at).toISOString(),
      rawPayloadRef: row.raw_payload_ref,
      host: row.host,
      registrableDomain: row.registrable_domain,
      // The candidate this row paired into, when the pair has happened and
      // was not dismissed; absent until the matching slice fills the id.
      ...(row.candidate_id === null ? {} : { candidateId: row.candidate_id }),
    })),
    total: Number(total.rows[0].count),
    page: resolvedPage,
    pageSize: resolvedSize,
  };
}

/** The re-check ladders page, by next due time. */
export async function listRechecks(
  pool: Pool,
  query: Record<string, unknown>,
): Promise<{
  items: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const page = Number.parseInt(String(query.page ?? "1"), 10);
  const pageSize = Number.parseInt(String(query.pageSize ?? "50"), 10);
  const resolvedPage = Number.isInteger(page) && page >= 1 ? page : 1;
  const resolvedSize =
    Number.isInteger(pageSize) && pageSize >= 1 ? Math.min(pageSize, 200) : 50;
  const filters: string[] = [];
  const values: unknown[] = [];
  if (typeof query.titleGroupId === "string" && query.titleGroupId !== "") {
    values.push(query.titleGroupId);
    filters.push(`title_group_id = $${values.length}`);
  }
  if (typeof query.engine === "string" && query.engine !== "") {
    values.push(query.engine);
    filters.push(`engine = $${values.length}`);
  }
  const where = filters.length === 0 ? "" : `where ${filters.join(" and ")}`;
  const result = await pool.query<{
    id: string;
    title_group_id: string;
    engine: string;
    rung: number;
    next_due_at: Date;
    active: boolean;
    anchored_scan_id: string;
    updated_at: Date;
  }>(
    `select id, title_group_id, engine, rung, next_due_at, active,
            anchored_scan_id, updated_at
       from recheck_schedules ${where}
      order by next_due_at, id
      limit $${values.length + 1} offset $${values.length + 2}`,
    [...values, resolvedSize, (resolvedPage - 1) * resolvedSize],
  );
  const total = await pool.query<{ count: string }>(
    `select count(*) as count from recheck_schedules ${where}`,
    values,
  );
  return {
    items: result.rows.map((row) => ({
      id: row.id,
      titleGroupId: row.title_group_id,
      engine: row.engine,
      rung: Number(row.rung),
      nextDueAt: new Date(row.next_due_at).toISOString(),
      active: row.active,
      startedByScanId: row.anchored_scan_id,
      updatedAt: new Date(row.updated_at).toISOString(),
    })),
    total: Number(total.rows[0].count),
    page: resolvedPage,
    pageSize: resolvedSize,
  };
}
