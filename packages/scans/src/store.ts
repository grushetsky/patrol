import type { Pool } from "pg";
import {
  DEFAULT_INTENT_PHRASES,
  hostForUrl,
  normalizeTitleText,
  normalizeUrlKey,
  orderQueue,
  registrableDomainForUrl,
  utcDate,
  type IntentPhraseConfig,
  type PlanTitle,
  type QueueEntry,
} from "@patrol/domain";

/**
 * The scan store: the SQL beneath the scans table's lifecycle. One scan is
 * idempotent on (title group, engine, due date) — the scheduler's insert
 * and the API's manual insert both ride the unique index, so a duplicate
 * wake-up or a manual scan after the scheduler returns the row that
 * already stands. The queue's dequeue order is computed by the shared
 * `orderQueue` function over the queued rows, so the SQL never reimplements
 * the design's ordering.
 */

/** The engines the scheduler drives; Bing buys no route in v1. */
export const SCHEDULED_ENGINES = ["google", "yandex"] as const;

export interface ScanRow {
  id: string;
  titleGroupId: string;
  trackedTitleId: string | null;
  engine: "google" | "bing" | "yandex";
  dueDate: string;
  triggerKind: "scheduled" | "manual" | "recheck" | "manual_recheck";
  state: "queued" | "running" | "succeeded" | "partial" | "failed";
  failureReason: string | null;
  plannedQueries: number;
  issuedQueries: number;
  reservationId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** The operator who requested a manual row, when the row records one. */
  createdBy: string | null;
}

const SCAN_COLUMNS = `id, title_group_id, tracked_title_id, engine, due_date::text as due_date,
  trigger_kind, state, failure_reason, planned_queries, issued_queries,
  reservation_id, created_at, started_at, finished_at, created_by`;

type RawScanRow = {
  id: string;
  title_group_id: string;
  tracked_title_id: string | null;
  engine: string;
  due_date: string;
  trigger_kind: string;
  state: string;
  failure_reason: string | null;
  planned_queries: number;
  issued_queries: number;
  reservation_id: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  created_by: string | null;
};

function mapScan(row: RawScanRow): ScanRow {
  return {
    id: row.id,
    titleGroupId: row.title_group_id,
    trackedTitleId: row.tracked_title_id,
    engine: row.engine as ScanRow["engine"],
    dueDate: row.due_date,
    triggerKind: row.trigger_kind as ScanRow["triggerKind"],
    state: row.state as ScanRow["state"],
    failureReason: row.failure_reason,
    plannedQueries: Number(row.planned_queries),
    issuedQueries: Number(row.issued_queries),
    reservationId: row.reservation_id,
    createdAt: new Date(row.created_at),
    startedAt: row.started_at === null ? null : new Date(row.started_at),
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at),
    createdBy: row.created_by,
  };
}

/** Reads one scan by id; null when absent. */
export async function readScan(pool: Pool, scanId: string): Promise<ScanRow | null> {
  const result = await pool.query<RawScanRow>(
    `select ${SCAN_COLUMNS} from scans where id = $1`,
    [scanId],
  );
  return result.rows.length === 0 ? null : mapScan(result.rows[0]);
}

/**
 * One page of the scan history, newest first, with the filters the Scans
 * interface serves. The listing reads its rows in one query — `created_by`
 * included — so a page costs a fixed number of statements whatever its
 * size; the per-scan detail (plan, failures) stays with `readScan` and
 * `loadScanFailures`. Returns the page's rows and the filter's total.
 */
export async function listScanPage(
  pool: Pool,
  input: {
    titleGroupId?: string;
    engine?: string;
    state?: string;
    trigger?: string;
    dueDate?: string;
    limit: number;
    offset: number;
  },
): Promise<{ rows: ScanRow[]; total: number }> {
  const filters: string[] = [];
  const values: unknown[] = [];
  const addFilter = (column: string, value: string): void => {
    values.push(value);
    filters.push(`${column} = $${values.length}`);
  };
  if (input.titleGroupId !== undefined) {
    addFilter("title_group_id", input.titleGroupId);
  }
  if (input.engine !== undefined) {
    addFilter("engine", input.engine);
  }
  if (input.state !== undefined) {
    addFilter("state", input.state);
  }
  if (input.trigger !== undefined) {
    addFilter("trigger_kind", input.trigger);
  }
  if (input.dueDate !== undefined) {
    addFilter("due_date", input.dueDate);
  }
  const where = filters.length === 0 ? "" : `where ${filters.join(" and ")}`;
  const result = await pool.query<RawScanRow>(
    `select ${SCAN_COLUMNS} from scans ${where}
      order by created_at desc, id desc
      limit $${values.length + 1} offset $${values.length + 2}`,
    [...values, input.limit, input.offset],
  );
  const total = await pool.query<{ count: string }>(
    `select count(*) as count from scans ${where}`,
    values,
  );
  return {
    rows: result.rows.map(mapScan),
    total: Number(total.rows[0].count),
  };
}

/**
 * Creates (or finds) the manual scan rows for a request: one per targeted
 * engine, idempotent on the day. A scan that already stands for the group,
 * engine, and due date is returned unchanged — a manual scan after the
 * scheduler, or a second identical request, never produces a second scan,
 * and the manual row marks the group scanned for the day.
 */
export async function insertManualScans(
  pool: Pool,
  now: () => Date,
  input: {
    titleGroupId: string;
    trackedTitleId?: string;
    engines: readonly ("google" | "yandex")[];
    trigger: "manual" | "manual_recheck";
    createdBy: string;
  },
): Promise<ScanRow[]> {
  const at = now();
  const dueDate = utcDate(at);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const rows: ScanRow[] = [];
    for (const engine of input.engines) {
      const inserted = await client.query<RawScanRow>(
        `insert into scans
           (title_group_id, tracked_title_id, engine, due_date, trigger_kind,
            scan_time, state, created_by, created_at)
         select g.id, $2, $3, $4, $5, g.scan_time, 'queued', $6, $7
           from title_groups g
          where g.id = $1
            and ($2::uuid is null or exists (
              select 1 from tracked_titles t
               where t.id = $2 and t.title_group_id = $1 and t.merged_into_title_id is null))
         on conflict (title_group_id, engine, due_date) do nothing
         returning ${SCAN_COLUMNS}`,
        [
          input.titleGroupId,
          input.trackedTitleId ?? null,
          engine,
          dueDate,
          input.trigger,
          input.createdBy,
          at.toISOString(),
        ],
      );
      if (inserted.rows.length > 0) {
        rows.push(mapScan(inserted.rows[0]));
        continue;
      }
      const existing = await client.query<RawScanRow>(
        `select ${SCAN_COLUMNS} from scans
          where title_group_id = $1 and engine = $2 and due_date = $3`,
        [input.titleGroupId, engine, dueDate],
      );
      rows.push(mapScan(existing.rows[0]));
    }
    await client.query("commit");
    return rows;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Enqueues the day's due scheduled scans for one engine: every group whose
 * scan_time slot has passed and which has not been scanned today. The
 * unique index makes the pass idempotent across duplicate wake-ups and
 * restarts. Returns how many scans were created.
 */
export async function insertDueScheduledScans(
  pool: Pool,
  now: () => Date,
  engine: "google" | "yandex",
): Promise<number> {
  const at = now();
  const result = await pool.query(
    `insert into scans (title_group_id, engine, due_date, trigger_kind, scan_time, created_at)
     select g.id, $1, $2, 'scheduled', g.scan_time, $3
       from title_groups g
      where g.scan_time <= $4::time
        and not exists (
          select 1 from scans s
           where s.title_group_id = g.id and s.engine = $1 and s.due_date = $2
        )
     on conflict (title_group_id, engine, due_date) do nothing`,
    [engine, utcDate(at), at.toISOString(), at.toISOString().slice(11, 19)],
  );
  return result.rowCount ?? 0;
}

/**
 * Enqueues the recheck scans that fell due: one scan row per active ladder
 * past its next-due time, unless the pair already has a scan for today —
 * the standing scan serves the observation, whichever trigger created it.
 * Returns how many scans were created.
 */
export async function insertDueRecheckScans(
  pool: Pool,
  now: () => Date,
): Promise<number> {
  const at = now();
  const result = await pool.query(
    `insert into scans (title_group_id, engine, due_date, trigger_kind, scan_time, created_at)
     select l.title_group_id, l.engine, $1, 'recheck', g.scan_time, $2
       from recheck_schedules l
       join title_groups g on g.id = l.title_group_id
      where l.active and l.next_due_at <= $3
        and not exists (
          select 1 from scans s
           where s.title_group_id = l.title_group_id
             and s.engine = l.engine and s.due_date = $1
        )
     on conflict (title_group_id, engine, due_date) do nothing`,
    [utcDate(at), at.toISOString(), at.toISOString()],
  );
  return result.rowCount ?? 0;
}

/**
 * The queued scans for one engine, in the order the queue runs them
 * (docs/design/scan-scheduling.md "Order of work"): manual work by request
 * order, then re-checks, then scheduled work by priority and
 * least-recently-scanned. The ordering itself is the shared pure function;
 * this query only gathers the entries it needs.
 */
export async function queuedScanOrder(
  pool: Pool,
  engine: "google" | "bing" | "yandex",
): Promise<QueueEntry[]> {
  const result = await pool.query<{
    scan_id: string;
    trigger_kind: string;
    requested_at: Date;
    priority: string;
    last_scan_at: Date | null;
  }>(
    `select s.id as scan_id, s.trigger_kind, s.created_at as requested_at,
            g.priority,
            (select max(coalesce(s2.finished_at, s2.started_at, s2.created_at))
               from scans s2
              where s2.title_group_id = s.title_group_id
                and s2.engine = s.engine
                and s2.state in ('succeeded', 'partial')) as last_scan_at
       from scans s
       join title_groups g on g.id = s.title_group_id
      where s.engine = $1 and s.state = 'queued'`,
    [engine],
  );
  return orderQueue(
    result.rows.map((row) => ({
      scanId: row.scan_id,
      trigger: row.trigger_kind as QueueEntry["trigger"],
      requestedAt: new Date(row.requested_at),
      priority: row.priority as QueueEntry["priority"],
      lastScanAt:
        row.last_scan_at === null ? null : new Date(row.last_scan_at),
    })),
  );
}

/**
 * Claims one scan for execution: the conditional update is the arbitration
 * between two pickers, a pg-boss retry, and a scheduler wake-up — exactly
 * one lands. Returns null when the scan is no longer queued or already
 * running from this picker's perspective (a running scan continues only
 * through its own holder; a holder that died is swept back to the queue by
 * `requeueCrashedScans`).
 */
export async function claimScan(
  pool: Pool,
  now: () => Date,
  scanId: string,
): Promise<ScanRow | null> {
  const result = await pool.query<RawScanRow>(
    `update scans
        set state = 'running', started_at = $2, failure_reason = null
      where id = $1 and state = 'queued'
      returning ${SCAN_COLUMNS}`,
    [scanId, now().toISOString()],
  );
  return result.rows.length === 0 ? null : mapScan(result.rows[0]);
}

/**
 * The crash sweep (docs/design/scan-scheduling.md "Failure handling",
 * "Worker crash mid-scan"): a scan left `running` by a dead worker returns
 * to the queue with `worker_crash` recorded, and the next picker re-prices
 * the remainder as a new attempt on the same scan. A scan is crashed only
 * when nothing holds it up — no live held reservation stands for it — and
 * it has been running longer than `staleAfterMs` (the reservation TTL the
 * caller passes), so a scan claimed moments ago, still mid-plan before its
 * hold exists, is never torn from a live worker. The sweep never releases
 * a reservation itself: an expired hold was already settled by the
 * reservation expiry sweep. Returns how many scans were requeued.
 */
export async function requeueCrashedScans(
  pool: Pool,
  now: () => Date,
  staleAfterMs: number,
): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `update scans s
        set state = 'queued', started_at = null, failure_reason = 'worker_crash'
      where s.state = 'running'
        and s.started_at < $1::timestamptz - ($2::bigint * interval '1 millisecond')
        and not exists (
          select 1 from budget_reservations r
           where r.scan_id = s.id and r.state = 'held' and r.expires_at > $1
        )
      returning s.id`,
    [now().toISOString(), staleAfterMs],
  );
  return result.rowCount ?? 0;
}

/** Returns a running scan to the queue with the reason it waits. */
export async function requeueScan(
  pool: Pool,
  scanId: string,
  reason: "budget_exhausted" | "route_unavailable",
): Promise<void> {
  await pool.query(
    `update scans
        set state = 'queued', started_at = null, failure_reason = $2
      where id = $1 and state = 'running'`,
    [scanId, reason],
  );
}

/**
 * The plan inputs: the group's locales, its live titles and variants, and
 * the intent phrases as configured. A merged title's variants moved to the
 * survivor, so only unmerged titles plan.
 */
export async function loadPlanInputs(
  pool: Pool,
  input: { titleGroupId: string; trackedTitleId?: string | null },
  now: () => Date = () => new Date(),
): Promise<{ locales: string[]; titles: PlanTitle[]; intentPhrases: Record<string, IntentPhraseConfig[]> }> {
  const group = await pool.query<{ locales: string[] }>(
    "select locales from title_groups where id = $1",
    [input.titleGroupId],
  );
  if (group.rows.length === 0) {
    throw new Error(`title group ${input.titleGroupId} not found`);
  }
  const titles = await pool.query<{
    id: string;
    original_variant_id: string;
  }>(
    `select id, original_variant_id from tracked_titles
      where title_group_id = $1 and merged_into_title_id is null and paused = false
        and ($2::uuid is null or id = $2)
      order by created_at, id`,
    [input.titleGroupId, input.trackedTitleId ?? null],
  );
  const titleIds = titles.rows.map((row) => row.id);
  const variants = titleIds.length
    ? await pool.query<{
        tracked_title_id: string;
        id: string;
        text: string;
        kind: string;
        language: string;
      }>(
        `select tracked_title_id, id, text, kind, language from title_variants
          where tracked_title_id = any($1::uuid[])
          order by added_at, id`,
        [titleIds],
      )
    : { rows: [] as { tracked_title_id: string; id: string; text: string; kind: string; language: string }[] };
  const byTitle = new Map<string, PlanTitle>();
  for (const title of titles.rows) {
    byTitle.set(title.id, {
      id: title.id,
      originalVariant: { id: title.original_variant_id, text: "", kind: "original", language: "" },
      variants: [],
    });
  }
  for (const variant of variants.rows) {
    const title = byTitle.get(variant.tracked_title_id);
    if (title === undefined) {
      continue;
    }
    const planned = {
      id: variant.id,
      text: variant.text,
      kind: variant.kind as PlanTitle["variants"][number]["kind"],
      language: variant.language,
    };
    title.variants.push(planned);
    if (planned.id === title.originalVariant.id) {
      title.originalVariant = planned;
    }
  }
  return {
    locales: group.rows[0].locales,
    titles: [...byTitle.values()],
    intentPhrases: await loadIntentPhrases(pool, now),
  };
}

/**
 * The intent phrases as stored, seeded on first read so a fresh database
 * carries the design's defaults without a migration writing
 * operator-editable configuration. A language with no stored rows falls
 * back to the defaults, so deleting a row cannot silently disable intent
 * queries.
 */
export async function loadIntentPhrases(
  pool: Pool,
  now: () => Date = () => new Date(),
): Promise<Record<string, IntentPhraseConfig[]>> {
  const at = now().toISOString();
  for (const [language, phrases] of Object.entries(DEFAULT_INTENT_PHRASES)) {
    for (const [index, phrase] of phrases.entries()) {
      await pool.query(
        `insert into intent_phrases (language, position, text, version, updated_at)
         values ($1, $2, $3, $4, $5)
         on conflict (language, position) do nothing`,
        [language, index + 1, phrase.text, phrase.version, at],
      );
    }
  }
  const result = await pool.query<{
    language: string;
    text: string;
    version: number;
  }>(
    "select language, text, version from intent_phrases order by language, position",
  );
  const stored: Record<string, IntentPhraseConfig[]> = {};
  for (const row of result.rows) {
    (stored[row.language] ??= []).push({
      text: row.text,
      version: Number(row.version),
    });
  }
  return { ...DEFAULT_INTENT_PHRASES, ...stored };
}

/**
 * Persists a plan: the query_plans row and its ordered search_queries. A
 * scan keeps the plan it started with — a retried run continues the
 * standing plan rather than re-deriving it, because the queries already
 * issued carry results that reference their rows (results are never
 * rewritten). Returns false when the plan already stood.
 */
export async function storePlan(
  pool: Pool,
  now: () => Date,
  input: {
    scanId: string;
    queries: Array<{
      trackedTitleId: string;
      locale: string;
      kind: "variant" | "intent";
      text: string;
      variantId?: string;
      intentPhrase?: IntentPhraseConfig;
    }>;
  },
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const standing = await client.query<{ id: string }>(
      "select id from query_plans where scan_id = $1",
      [input.scanId],
    );
    if (standing.rows.length > 0) {
      await client.query("commit");
      return false;
    }
    const plan = await client.query<{ id: string }>(
      `insert into query_plans (scan_id, generated_at) values ($1, $2) returning id`,
      [input.scanId, now().toISOString()],
    );
    const planId = plan.rows[0].id;
    for (const [position, query] of input.queries.entries()) {
      await client.query(
        `insert into search_queries
           (query_plan_id, tracked_title_id, locale, kind, text, normalized_text,
            variant_id, intent_phrase, intent_phrase_version, position)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          planId,
          query.trackedTitleId,
          query.locale,
          query.kind,
          query.text,
          normalizeTitleText(query.text),
          query.variantId ?? null,
          query.intentPhrase?.text ?? null,
          query.intentPhrase?.version ?? null,
          position,
        ],
      );
    }
    await client.query(
      "update scans set planned_queries = $2 where id = $1",
      [input.scanId, input.queries.length],
    );
    await client.query("commit");
    return true;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** One scan's stored queries, in plan order. */
export async function loadScanQueries(
  pool: Pool,
  scanId: string,
): Promise<
  Array<{
    id: string;
    trackedTitleId: string;
    locale: string;
    kind: "variant" | "intent";
    text: string;
    issued: boolean;
    position: number;
  }>
> {
  const result = await pool.query<{
    id: string;
    tracked_title_id: string;
    locale: string;
    kind: string;
    text: string;
    issued: boolean;
    position: number;
  }>(
    `select q.id, q.tracked_title_id, q.locale, q.kind, q.text, q.issued, q.position
       from search_queries q
       join query_plans p on p.id = q.query_plan_id
      where p.scan_id = $1
      order by q.position`,
    [scanId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    trackedTitleId: row.tracked_title_id,
    locale: row.locale,
    kind: row.kind as "variant" | "intent",
    text: row.text,
    issued: row.issued,
    position: Number(row.position),
  }));
}

/**
 * Stores the rows one query returned, as provenance: the raw URL verbatim,
 * the normalized key, the host, the registrable domain, and the query's
 * locale and territory. Results are only ever inserted — the table's
 * trigger refuses updates.
 */
export async function storeResults(
  pool: Pool,
  input: {
    scanId: string;
    engine: "google" | "bing" | "yandex";
    queryId: string;
    locale: string;
    territory?: string;
    observedAt: string;
    rawPayloadRef: string;
    rows: Array<{ url: string; title: string; snippet: string; rank: number }>;
  },
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const row of input.rows) {
      await client.query(
        `insert into search_results
           (scan_id, query_id, url, normalized_url, rank, title, snippet,
            locale, territory, observed_at, raw_payload_ref, host, registrable_domain)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          input.scanId,
          input.queryId,
          row.url,
          normalizeUrlKey(row.url),
          row.rank,
          row.title,
          row.snippet,
          input.locale,
          input.territory ?? null,
          input.observedAt,
          input.rawPayloadRef,
          hostForUrl(row.url),
          registrableDomainForUrl(row.url),
        ],
      );
    }
    await client.query(
      "update search_queries set issued = true, issued_at = $2 where id = $1",
      [input.queryId, input.observedAt],
    );
    await client.query(
      "update scans set issued_queries = issued_queries + 1 where id = $1",
      [input.scanId],
    );
    await client.query("commit");
    return input.rows.length;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Marks a query issued-and-failed and records its attempts. */
export async function storeQueryFailure(
  pool: Pool,
  now: () => Date,
  input: {
    scanId: string;
    queryId: string;
    reason: string;
    attempts: number;
    attemptLog: unknown;
  },
): Promise<void> {
  const at = now().toISOString();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into query_failures
         (scan_id, query_id, reason, attempts, attempt_log, created_at)
       values ($1, $2, $3, $4, $5::jsonb, $6)
       on conflict (scan_id, query_id) do update
         set reason = excluded.reason,
             attempts = excluded.attempts,
             attempt_log = excluded.attempt_log`,
      [
        input.scanId,
        input.queryId,
        input.reason,
        input.attempts,
        JSON.stringify(input.attemptLog),
        at,
      ],
    );
    await client.query(
      "update search_queries set issued = true, issued_at = $2 where id = $1",
      [input.queryId, at],
    );
    await client.query(
      "update scans set issued_queries = issued_queries + 1 where id = $1",
      [input.scanId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The failure rows a scan recorded, in plan order. */
export async function loadScanFailures(
  pool: Pool,
  scanId: string,
): Promise<Array<{ queryId: string; reason: string; attempts: number }>> {
  const result = await pool.query<{
    query_id: string;
    reason: string;
    attempts: number;
  }>(
    "select query_id, reason, attempts from query_failures where scan_id = $1",
    [scanId],
  );
  return result.rows.map((row) => ({
    queryId: row.query_id,
    reason: row.reason,
    attempts: Number(row.attempts),
  }));
}

/**
 * Closes a scan out: the terminal state, the finish time, the units the
 * reservation settled for, and the reservation link. `state` must already
 * be one of the terminal states the executor computed.
 */
export async function finishScan(
  pool: Pool,
  now: () => Date,
  input: {
    scanId: string;
    state: "succeeded" | "partial" | "failed";
    failureReason?: string;
    reservationId?: string | null;
    reservedUnits?: number | null;
    committedUnits?: number | null;
  },
): Promise<void> {
  await pool.query(
    `update scans
        set state = $2,
            failure_reason = $3,
            finished_at = $4,
            reservation_id = $5,
            reserved_units = $6,
            committed_units = $7
      where id = $1`,
    [
      input.scanId,
      input.state,
      input.failureReason ?? null,
      now().toISOString(),
      input.reservationId ?? null,
      input.reservedUnits ?? null,
      input.committedUnits ?? null,
    ],
  );
}

/** Links the reservation the scan holds, before the queries run. */
export async function attachReservation(
  pool: Pool,
  scanId: string,
  reservation: { id: string; units: number },
): Promise<void> {
  await pool.query(
    "update scans set reservation_id = $2, reserved_units = $3 where id = $1",
    [scanId, reservation.id, reservation.units],
  );
}

/** Whether the scan still holds its reservation (a crash recovery check). */
export async function heldReservationFor(
  pool: Pool,
  scanId: string,
): Promise<{ id: string; units: number } | null> {
  const result = await pool.query<{ id: string; units: number }>(
    `select id, units from budget_reservations
      where scan_id = $1 and state = 'held'`,
    [scanId],
  );
  return result.rows.length === 0
    ? null
    : { id: result.rows[0].id, units: Number(result.rows[0].units) };
}
