import { ApiError, unprocessable } from "../errors.js";
import type { Connectable } from "../db/migrations.js";
import { newId } from "../auth/tokens.js";
import { pageOf, type Page } from "../http.js";
import { iso } from "../catalogue/records.js";

export interface ManualScanInput {
  titleGroupId: string;
  trackedTitleId?: string;
  engine?: string;
  trigger: string;
}

export interface ScanFilters {
  titleGroupId?: string;
  engine?: string;
  state?: string;
  trigger?: string;
  dueDate?: string;
}

export interface RecheckFilters {
  titleGroupId?: string;
  engine?: string;
}

const DISCOVERY_ENGINES = ["google", "yandex"];

/** Scan history and the operator's manual scan requests. */
export class ScanService {
  constructor(
    private readonly db: Connectable,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(filters: ScanFilters, page: Page) {
    const conditions: string[] = [];
    const values: unknown[] = [];
    const filter = (column: string, value: string | undefined) => {
      if (value !== undefined) {
        values.push(value);
        conditions.push(`${column} = $${values.length}`);
      }
    };
    filter("title_group_id", filters.titleGroupId);
    filter("engine", filters.engine);
    filter("state", filters.state);
    filter("trigger", filters.trigger);
    filter("due_date", filters.dueDate);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = (
      await this.db.query(
        `SELECT * FROM scan ${where} ORDER BY created_at DESC`,
        values,
      )
    ).rows;
    return pageOf(rows.map(toScan), page);
  }

  async request(input: ManualScanInput, operatorId: string) {
    const group = (
      await this.db.query("SELECT id FROM title_group WHERE id = $1", [
        input.titleGroupId,
      ])
    ).rows[0];
    if (!group) {
      throw unprocessable([
        { path: "/titleGroupId", message: "No such title group." },
      ]);
    }
    if (input.trackedTitleId) {
      const title = (
        await this.db.query(
          "SELECT id FROM tracked_title WHERE id = $1 AND title_group_id = $2",
          [input.trackedTitleId, input.titleGroupId],
        )
      ).rows[0];
      if (!title) {
        throw unprocessable([
          {
            path: "/trackedTitleId",
            message: "The title does not belong to that group.",
          },
        ]);
      }
    }
    if (input.engine === "bing") {
      throw unprocessable([
        { path: "/engine", message: "Bing is not a discovery engine yet." },
      ]);
    }
    const engines = input.engine
      ? [input.engine]
      : await this.enabledEngines();
    if (engines.length === 0) {
      throw new ApiError(
        422,
        "validation_failed",
        "No discovery engine is enabled.",
      );
    }

    const dueDate = this.today();
    const now = this.clock();
    const scans: Array<Record<string, unknown>> = [];
    for (const engine of engines) {
      const existing = (
        await this.db.query(
          "SELECT * FROM scan WHERE title_group_id = $1 AND engine = $2 AND due_date = $3",
          [input.titleGroupId, engine, dueDate],
        )
      ).rows[0];
      if (existing) {
        scans.push(toScan(existing));
        continue;
      }
      const id = newId();
      try {
        await this.db.query(
          `INSERT INTO scan
            (id, title_group_id, engine, trigger, due_date, requested_by,
             tracked_title_id, planned_queries, query_plan, state, queued_at,
             queued_reason, started_at, finished_at, issued_queries,
             failure_reason, failures, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 0, NULL, 'queued', $8,
                   NULL, NULL, NULL, NULL, NULL, NULL, $8)`,
          [
            id,
            input.titleGroupId,
            engine,
            input.trigger,
            dueDate,
            operatorId,
            input.trackedTitleId ?? null,
            now,
          ],
        );
      } catch {
        const raced = (
          await this.db.query(
            "SELECT * FROM scan WHERE title_group_id = $1 AND engine = $2 AND due_date = $3",
            [input.titleGroupId, engine, dueDate],
          )
        ).rows[0];
        if (raced) {
          scans.push(toScan(raced));
          continue;
        }
        throw new ApiError(409, "state_conflict", "The scan could not be queued.");
      }
      const created = (
        await this.db.query("SELECT * FROM scan WHERE id = $1", [id])
      ).rows[0];
      scans.push(toScan(created));
    }
    return { scans };
  }

  async read(id: string) {
    const row = (
      await this.db.query("SELECT * FROM scan WHERE id = $1", [id])
    ).rows[0];
    if (!row) {
      throw new ApiError(404, "not_found", "The scan does not exist.");
    }
    return toScan(row);
  }

  async results(id: string, page: Page) {
    await this.read(id);
    const rows = (
      await this.db.query(
        `SELECT r.* FROM search_result r
           JOIN scan_query q ON q.id = r.query_id
          WHERE r.scan_id = $1
          ORDER BY q.ordinal ASC, r.rank ASC`,
        [id],
      )
    ).rows;
    return pageOf(rows.map(toSearchResult), page);
  }

  async rechecks(filters: RecheckFilters, page: Page) {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filters.titleGroupId) {
      values.push(filters.titleGroupId);
      conditions.push(`title_group_id = $${values.length}`);
    }
    if (filters.engine) {
      values.push(filters.engine);
      conditions.push(`engine = $${values.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = (
      await this.db.query(
        `SELECT * FROM recheck_schedule ${where} ORDER BY next_due_at ASC`,
        values,
      )
    ).rows;
    return pageOf(
      rows.map((row) => ({
        id: String(row.id),
        titleGroupId: String(row.title_group_id),
        engine: String(row.engine),
        rung: Number(row.rung),
        nextDueAt: iso(row.next_due_at),
        active: Boolean(row.active),
        startedByScanId: String(row.started_by_scan_id ?? ""),
        updatedAt: iso(row.updated_at),
      })),
      page,
    );
  }

  private async enabledEngines(): Promise<string[]> {
    const disabled = (
      await this.db.query(
        "SELECT engine FROM engine_route WHERE disabled_at IS NOT NULL",
      )
    ).rows.map((row) => String(row.engine));
    return DISCOVERY_ENGINES.filter((engine) => !disabled.includes(engine));
  }

  private today(): string {
    const now = this.clock();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  }
}

function toScan(row: Record<string, unknown>) {
  const state = String(row.state);
  const lifecycle: Record<string, unknown> = { state };
  if (state === "queued") {
    lifecycle.queuedAt = iso(row.queued_at);
    if (row.queued_reason) {
      lifecycle.queuedReason = String(row.queued_reason);
    }
  } else if (state === "running") {
    lifecycle.startedAt = iso(row.started_at);
  } else if (state === "succeeded") {
    lifecycle.startedAt = iso(row.started_at);
    lifecycle.finishedAt = iso(row.finished_at);
    lifecycle.issuedQueries = Number(row.issued_queries ?? 0);
  } else if (state === "partial") {
    lifecycle.startedAt = iso(row.started_at);
    lifecycle.finishedAt = iso(row.finished_at);
    lifecycle.issuedQueries = Number(row.issued_queries ?? 0);
    lifecycle.failures = parseFailures(row.failures);
  } else {
    lifecycle.finishedAt = iso(row.finished_at);
    lifecycle.failureReason = String(row.failure_reason ?? "provider_error");
    if (row.started_at) {
      lifecycle.startedAt = iso(row.started_at);
    }
    const failures = parseFailures(row.failures);
    if (failures.length > 0) {
      lifecycle.failures = failures;
    }
  }
  return {
    id: String(row.id),
    titleGroupId: String(row.title_group_id),
    engine: String(row.engine),
    trigger: String(row.trigger),
    dueDate: String(row.due_date),
    requestedBy: (row.requested_by as string | null) ?? undefined,
    plannedQueries: Number(row.planned_queries ?? 0),
    queryPlan: row.query_plan
      ? (JSON.parse(String(row.query_plan)) as unknown)
      : undefined,
    createdAt: iso(row.created_at),
    lifecycle,
  };
}

function parseFailures(value: unknown): Array<Record<string, unknown>> {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

function toSearchResult(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    scanId: String(row.scan_id),
    queryId: String(row.query_id),
    engine: String(row.engine),
    url: String(row.url),
    normalizedUrl: String(row.normalized_url),
    rank: Number(row.rank),
    title: String(row.title),
    snippet: String(row.snippet),
    locale: String(row.locale),
    territory: (row.territory as string | null) ?? undefined,
    observedAt: iso(row.observed_at),
    rawPayloadRef: String(row.raw_payload_ref),
    host: String(row.host),
    registrableDomain: String(row.registrable_domain),
    candidateId: (row.candidate_id as string | null) ?? undefined,
  };
}
