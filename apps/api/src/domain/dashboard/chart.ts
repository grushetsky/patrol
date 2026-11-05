import type { Pool } from "pg";
import type { Locale, MessageKey } from "@patrol/i18n";
import { t } from "@patrol/i18n";

/**
 * The title chart (docs/design/dashboard-ui.md "Title chart"; contract
 * Patrol.Http.Dashboard /title-chart): three metrics over a 7, 14, or 30-day
 * window ending today (UTC), one grouping at a time, with the tiles under
 * the plot. An inapplicable grouping falls back to the total and reports
 * the request, what was applied, and the fallback flag.
 *
 * Day semantics, fixed by the design and held here:
 *
 * - Tracked titles is a step count: a title counts on a day when it existed
 *   (created on or before the day) and was neither archived by a merge nor
 *   paused on that day. A pause period (0010's title_pause_periods) covers
 *   the days from its pause day through the day before the resume day, so a
 *   paused title drops out from its pause day on and a resumed one returns
 *   on its resume day -- resuming never rewrites the paused days.
 *
 * - A violation is open on a day when it was detected on or before the day
 *   and not resolved on or before it — the resolution day is the first day
 *   it stops counting — except that a violation detected and resolved on the
 *   same day counts in both the open and the resolved series that day
 *   (docs/plan/build-slices.md "Slice 8" acceptance). In interval terms a
 *   violation counts on the days from its detection date through
 *   max(detection date, resolution date - 1).
 *
 * - Resolved counts the violations that left the open state on that day, on
 *   one of two bases: removed plus closed (the default) or closed only.
 *
 * Engine attribution comes from the candidate's `engines` array — every
 * engine that surfaced the pair, so a title counts once per engine and the
 * series can sum above the total; a manual pair surfaced by no engine
 * counts in no engine series. A value outside the fixed engine order is
 * never dropped: it renders as its own bucket, keyed and labelled by the
 * raw value, so the series keep every counted title and their sums
 * reconcile. Recipient attribution comes from the most
 * recent notice that cites the violation, so an uncited resolution counts
 * in no recipient series — the mirror image of summing above the total, and
 * the total (no grouping) stays the exact count either way.
 */

/**
 * The tracked-titles series: one row per (day, live title) pair. A period
 * covers a day when it opened before the day ended and had not resumed by
 * then (an open period covers every day from its pause day on), which makes
 * the pause interval the days [pause day, resume day).
 */
export const TRACKED_TITLES_SERIES_SQL = `select ((d.day)::date)::text as day,
       tt.title_group_id::text as group_id
  from generate_series($1::date, $2::date, interval '1 day') as d(day)
  join tracked_titles tt
    on tt.created_at < ((d.day + interval '1 day') at time zone 'UTC')
   and tt.merged_into_title_id is null
   and not exists (
         select 1
           from title_pause_periods pp
          where pp.tracked_title_id = tt.id
            and pp.paused_at < ((d.day + interval '1 day') at time zone 'UTC')
            and (pp.resumed_at is null
                 or pp.resumed_at >= ((d.day + interval '1 day') at time zone 'UTC'))
       )`;

/**
 * The titles-with-violations series: one row per (day, open violation)
 * pair, with each violation's open interval of days expanded in the
 * database. The same-day rule lands in the CASE: a resolution on the
 * detection day keeps that day, a later resolution counts through the day
 * before it.
 */
export const OPEN_VIOLATIONS_SERIES_SQL = `select ((d.day)::date)::text as day,
       v.tracked_title_id::text as title_id,
       tt.title_group_id::text as group_id,
       c.engines as engines
  from violations v
  join tracked_titles tt on tt.id = v.tracked_title_id
  join candidates c on c.id = v.candidate_id
  cross join lateral generate_series(
      greatest((v.detected_at at time zone 'UTC')::date, $1::date),
      least(case
              when v.closed_at is null then $2::date
              when (v.closed_at at time zone 'UTC')::date
                   <= (v.detected_at at time zone 'UTC')::date
                then (v.closed_at at time zone 'UTC')::date
              else (v.closed_at at time zone 'UTC')::date - 1
            end,
            $2::date),
      interval '1 day') as d(day)
 where v.detected_at < (($2::date + interval '1 day') at time zone 'UTC')`;

/**
 * The resolved series: one row per violation that left open inside the
 * window, with the state split the tiles read and the citing notice's
 * recipient when one exists.
 */
export const RESOLVED_VIOLATIONS_SERIES_SQL = `select ((v.closed_at at time zone 'UTC')::date)::text as day,
       v.tracked_title_id::text as title_id,
       tt.title_group_id::text as group_id,
       c.engines as engines,
       v.state as state,
       cite.recipient as recipient
  from violations v
  join tracked_titles tt on tt.id = v.tracked_title_id
  join candidates c on c.id = v.candidate_id
  left join lateral (
    select n.recipient
      from notice_citations nc
      join notices n on n.id = nc.notice_id
     where nc.violation_id = v.id
     order by n.composed_at desc, n.id
     limit 1
  ) cite on true
 where v.closed_at >= ($1::date at time zone 'UTC')
   and v.closed_at < (($2::date + interval '1 day') at time zone 'UTC')
   and v.state = any($3::text[])`;

/** The engines and recipients in their fixed display order. */
const ENGINE_ORDER = ["google", "bing", "yandex"] as const;
type EngineValue = (typeof ENGINE_ORDER)[number];

const ENGINE_LABEL_KEYS: Record<EngineValue, MessageKey> = {
  google: "dashboard.chart.engine.google",
  bing: "dashboard.chart.engine.bing",
  yandex: "dashboard.chart.engine.yandex",
};

const RECIPIENT_LABEL_KEYS: Record<EngineValue, MessageKey> = {
  google: "dashboard.chart.recipient.google",
  bing: "dashboard.chart.recipient.bing",
  yandex: "dashboard.chart.recipient.yandex",
};

/**
 * The grouping values in display order: the fixed engine order first, then
 * any value outside it (a candidate's `engines` array is free text) in its
 * own bucket, so an unknown engine's titles still render and the series
 * sums reconcile against the total.
 */
function groupingOrder(values: Iterable<string>): string[] {
  const present = new Set(values);
  const known = ENGINE_ORDER.filter((engine) => present.has(engine));
  const unknown = [...present]
    .filter((value) => !(ENGINE_ORDER as readonly string[]).includes(value))
    .sort();
  return [...known, ...unknown];
}

/** An engine's display label: localized when known, the raw value when not. */
function engineLabel(value: string, locale: Locale): string {
  const key = ENGINE_LABEL_KEYS[value as EngineValue];
  return key === undefined ? value : t(locale, key);
}

/** A recipient's display label, the same fallback as an engine's. */
function recipientLabel(value: string, locale: Locale): string {
  const key = RECIPIENT_LABEL_KEYS[value as EngineValue];
  return key === undefined ? value : t(locale, key);
}

/** The chart's parsed query (the route validates the raw parameters). */
export interface ChartRequest {
  metric: "tracked_titles" | "titles_with_violations" | "resolved_violations";
  windowDays: 7 | 14 | 30;
  groupBy: "none" | "title_group" | "engine" | "recipient";
  basis: "removed_and_closed" | "closed_only";
}

/** Which groupings each metric accepts (the design's table). */
const APPLICABLE: Record<ChartRequest["metric"], ChartRequest["groupBy"][]> = {
  tracked_titles: ["none", "title_group"],
  titles_with_violations: ["none", "title_group", "engine"],
  resolved_violations: ["none", "title_group", "engine", "recipient"],
};

/** The window's days, oldest first, as YYYY-MM-DD UTC strings. */
function windowDays(now: Date, windowDays: number): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days: string[] = [];
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const day = new Date(today - offset * 86_400_000);
    days.push(
      `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, "0")}-${String(
        day.getUTCDate(),
      ).padStart(2, "0")}`,
    );
  }
  return days;
}

/** One series in the contract's ChartSeries shape. */
interface Series {
  key: string;
  label: string;
  values: number[];
}

/** A zeroed bucket per day, then the counting helper over it. */
function dayBuckets(days: string[]): Map<string, number> {
  return new Map(days.map((day) => [day, 0]));
}

/** The tracked-titles rows the SQL returns. */
interface TrackedRow {
  day: string;
  group_id: string;
}

/** The open-violation rows the SQL returns. */
interface OpenRow {
  day: string;
  title_id: string;
  group_id: string;
  engines: string[];
}

/** The resolved rows the SQL returns. */
interface ResolvedRow extends OpenRow {
  state: "removed" | "closed";
  recipient: string | null;
}

/** Every title group's name, for the series labels. */
async function groupNames(pool: Pool): Promise<Map<string, string>> {
  const groups = await pool.query<{ id: string; name: string }>(
    "select id::text, name from title_groups",
  );
  return new Map(groups.rows.map((group) => [group.id, group.name]));
}

/** Series for the tracked-titles metric. */
function trackedSeries(
  rows: TrackedRow[],
  days: string[],
  grouping: ChartRequest["groupBy"],
  names: Map<string, string>,
  totalLabel: string,
): Series[] {
  if (grouping === "none") {
    const counts = dayBuckets(days);
    for (const row of rows) {
      counts.set(row.day, (counts.get(row.day) ?? 0) + 1);
    }
    return [
      { key: "total", label: totalLabel, values: days.map((day) => counts.get(day) ?? 0) },
    ];
  }
  // One bucket per (group, day); only groups present in the window appear.
  const byGroup = new Map<string, Map<string, number>>();
  for (const row of rows) {
    let counts = byGroup.get(row.group_id);
    if (counts === undefined) {
      counts = dayBuckets(days);
      byGroup.set(row.group_id, counts);
    }
    counts.set(row.day, (counts.get(row.day) ?? 0) + 1);
  }
  return [...byGroup.entries()]
    .map(([groupId, counts]) => ({
      key: groupId,
      label: names.get(groupId) ?? groupId,
      values: days.map((day) => counts.get(day) ?? 0),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Series for the titles-with-violations metric: distinct titles per day. */
function openSeries(
  rows: OpenRow[],
  days: string[],
  grouping: ChartRequest["groupBy"],
  names: Map<string, string>,
  locale: Locale,
  totalLabel: string,
): Series[] {
  if (grouping === "none") {
    const titles = new Map<string, Set<string>>();
    for (const day of days) {
      titles.set(day, new Set());
    }
    for (const row of rows) {
      titles.get(row.day)?.add(row.title_id);
    }
    return [
      {
        key: "total",
        label: totalLabel,
        values: days.map((day) => titles.get(day)?.size ?? 0),
      },
    ];
  }
  if (grouping === "title_group") {
    const byGroup = new Map<string, Map<string, Set<string>>>();
    for (const row of rows) {
      let titles = byGroup.get(row.group_id);
      if (titles === undefined) {
        titles = new Map(days.map((day) => [day, new Set<string>()]));
        byGroup.set(row.group_id, titles);
      }
      titles.get(row.day)?.add(row.title_id);
    }
    return [...byGroup.entries()]
      .map(([groupId, titles]) => ({
        key: groupId,
        label: names.get(groupId) ?? groupId,
        values: days.map((day) => titles.get(day)?.size ?? 0),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  // Engine grouping: a title counts once per engine that surfaced it.
  const byEngine = new Map<string, Map<string, Set<string>>>();
  for (const row of rows) {
    for (const engine of row.engines) {
      let titles = byEngine.get(engine);
      if (titles === undefined) {
        titles = new Map(days.map((day) => [day, new Set<string>()]));
        byEngine.set(engine, titles);
      }
      titles.get(row.day)?.add(row.title_id);
    }
  }
  return groupingOrder(byEngine.keys()).map((engine) => ({
    key: engine,
    label: engineLabel(engine, locale),
    values: days.map((day) => byEngine.get(engine)?.get(day)?.size ?? 0),
  }));
}

/** Series for the resolved metric: one row is one resolution. */
function resolvedSeries(
  rows: ResolvedRow[],
  days: string[],
  grouping: ChartRequest["groupBy"],
  names: Map<string, string>,
  locale: Locale,
  totalLabel: string,
): Series[] {
  if (grouping === "none") {
    const counts = dayBuckets(days);
    for (const row of rows) {
      counts.set(row.day, (counts.get(row.day) ?? 0) + 1);
    }
    return [
      { key: "total", label: totalLabel, values: days.map((day) => counts.get(day) ?? 0) },
    ];
  }
  if (grouping === "title_group" || grouping === "engine" || grouping === "recipient") {
    const buckets = new Map<string, Map<string, number>>();
    const labelFor = (value: string): string =>
      grouping === "title_group"
        ? (names.get(value) ?? value)
        : grouping === "engine"
          ? engineLabel(value, locale)
          : recipientLabel(value, locale);
    for (const row of rows) {
      const values =
        grouping === "title_group" ? [row.group_id]
        : grouping === "engine" ? row.engines
        : row.recipient === null ? []
        : [row.recipient];
      for (const value of values) {
        let counts = buckets.get(value);
        if (counts === undefined) {
          counts = dayBuckets(days);
          buckets.set(value, counts);
        }
        counts.set(row.day, (counts.get(row.day) ?? 0) + 1);
      }
    }
    const ordered =
      grouping === "title_group"
        ? [...buckets.keys()].sort((a, b) =>
            (names.get(a) ?? a).localeCompare(names.get(b) ?? b),
          )
        : groupingOrder(buckets.keys());
    return ordered.map((value) => ({
      key: value,
      label: labelFor(value),
      values: days.map((day) => buckets.get(value)?.get(day) ?? 0),
    }));
  }
  // Unreachable: the caller fell back for any other grouping.
  return [];
}

/** GET /dashboard/title-chart's body: the union member the metric selects. */
export async function readTitleChart(
  pool: Pool,
  now: () => Date,
  locale: Locale,
  request: ChartRequest,
): Promise<Record<string, unknown>> {
  const days = windowDays(now(), request.windowDays);
  const [start, end] = [days[0], days[days.length - 1]];
  const applicable = APPLICABLE[request.metric].includes(request.groupBy);
  const appliedGrouping = applicable ? request.groupBy : "none";
  const groupingFallback = !applicable;
  const names = await groupNames(pool);
  // The "total" series the no-grouping plot (and every fallback) renders.
  const totalLabel = t(locale, "dashboard.chart.series.total");

  if (request.metric === "tracked_titles") {
    const rows = (await pool.query<TrackedRow>(TRACKED_TITLES_SERIES_SQL, [start, end])).rows;
    const series = trackedSeries(rows, days, appliedGrouping, names, totalLabel);
    const tiles = await pool.query<{
      current_count: number;
      paused_count: number;
      group_count: number;
    }>(
      `select count(*) filter (where not paused)::int as current_count,
              count(*) filter (where paused)::int as paused_count,
              (select count(*)::int from title_groups) as group_count
         from tracked_titles
        where merged_into_title_id is null`,
    );
    return {
      metric: "tracked_titles",
      windowDays: request.windowDays,
      requestedGrouping: request.groupBy,
      appliedGrouping,
      groupingFallback,
      days,
      series,
      tiles: {
        currentCount: tiles.rows[0].current_count,
        pausedCount: tiles.rows[0].paused_count,
        titleGroupCount: tiles.rows[0].group_count,
      },
    };
  }

  if (request.metric === "titles_with_violations") {
    const rows = (await pool.query<OpenRow>(OPEN_VIOLATIONS_SERIES_SQL, [start, end])).rows;
    const series = openSeries(rows, days, appliedGrouping, names, locale, totalLabel);
    // The tiles describe today's open set whatever the grouping. Today is
    // the window's last day, so its rows are the interval query's rows for
    // that day — no second round trip recomputes the window.
    const todayRows = rows.filter((row) => row.day === end);
    const titlesToday = new Set(todayRows.map((row) => row.title_id));
    const groupsToday = new Set(todayRows.map((row) => row.group_id));
    const totalSeries = openSeries(rows, days, "none", names, locale, totalLabel)[0];
    return {
      metric: "titles_with_violations",
      windowDays: request.windowDays,
      requestedGrouping: request.groupBy,
      appliedGrouping,
      groupingFallback,
      days,
      series,
      tiles: {
        countToday: titlesToday.size,
        groupsAffectedToday: groupsToday.size,
        peakInWindow: Math.max(0, ...totalSeries.values),
      },
    };
  }

  const states = request.basis === "closed_only" ? ["closed"] : ["removed", "closed"];
  const rows = (
    await pool.query<ResolvedRow>(RESOLVED_VIOLATIONS_SERIES_SQL, [start, end, states])
  ).rows;
  const series = resolvedSeries(rows, days, appliedGrouping, names, locale, totalLabel);
  return {
    metric: "resolved_violations",
    windowDays: request.windowDays,
    requestedGrouping: request.groupBy,
    appliedGrouping,
    groupingFallback,
    resolvedBasis: request.basis,
    days,
    series,
    tiles: {
      // The tiles describe the counted set: on the closed-only basis no
      // removal is counted, so its tile reads zero.
      totalInWindow: rows.length,
      removedCount: rows.filter((row) => row.state === "removed").length,
      closedCount: rows.filter((row) => row.state === "closed").length,
    },
  };
}
