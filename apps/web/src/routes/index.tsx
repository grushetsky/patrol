import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { interpolate, t, type MessageKey } from "@patrol/i18n";
import { axisStep } from "../lib/chart";
import { api } from "../lib/api/client";
import { useSession } from "../lib/session";

/**
 * The dashboard (docs/design/dashboard-ui.md "Dashboard" and "Title chart"):
 * the screen that answers what is open, what needs a decision, and how the
 * tracked catalogue is trending. Four counters lead the page; the engine row
 * shows each engine's quota independently — an exhausted badge on one never
 * hides its neighbours; the five-entry activity feed lists the latest scans,
 * review decisions, approvals, and acknowledgements with a relative time and
 * the link to Notices; and the title chart occupies the main panel with its
 * metric tabs, window and grouping selectors, the resolved basis toggle, the
 * four-tick axis, the day inspector, and the tiles.
 *
 * The chart's degraded states follow the design's States section: loading
 * renders skeleton rows and a skeleton panel, an empty window renders the
 * chart's empty explanation, and an inapplicable grouping renders the
 * fallback hint beside the total the server applied.
 */

interface SummaryCounters {
  openViolations: number;
  candidatesToReview: number;
  noticesOnFile: number;
  draftNotices: number;
  acknowledgedSubmissions: number;
}

interface EngineQuota {
  engine: "google" | "bing" | "yandex";
  allowanceUnits: number;
  scanReserved: number;
  scanCommitted: number;
  recheckReserved: number;
  recheckCommitted: number;
  percentUsed: number;
  alertLevel: "normal" | "warning" | "critical";
  exhausted: boolean;
  routeDisabled: boolean;
}

interface ActivityEntry {
  id: string;
  kind: string;
  occurredAt: string;
  summary: string;
  scanId?: string;
  candidateId?: string;
  noticeId?: string;
  submissionId?: string;
}

interface Summary {
  counters: SummaryCounters;
  engines: EngineQuota[];
  activity: ActivityEntry[];
}

interface ChartSeries {
  key: string;
  label: string;
  values: number[];
}

type TrackedTiles = { currentCount: number; pausedCount: number; titleGroupCount: number };
type ViolationsTiles = { countToday: number; groupsAffectedToday: number; peakInWindow: number };
type ResolvedTiles = { totalInWindow: number; removedCount: number; closedCount: number };

interface ChartBodyBase {
  windowDays: number;
  requestedGrouping: string;
  appliedGrouping: string;
  groupingFallback: boolean;
  days: string[];
  series: ChartSeries[];
}

interface TrackedChart extends ChartBodyBase {
  metric: "tracked_titles";
  tiles: TrackedTiles;
}

interface ViolationsChart extends ChartBodyBase {
  metric: "titles_with_violations";
  tiles: ViolationsTiles;
}

interface ResolvedChart extends ChartBodyBase {
  metric: "resolved_violations";
  resolvedBasis: "removed_and_closed" | "closed_only";
  tiles: ResolvedTiles;
}

type ChartBody = TrackedChart | ViolationsChart | ResolvedChart;

type Metric = "tracked_titles" | "titles_with_violations" | "resolved_violations";
type Grouping = "none" | "title_group" | "engine" | "recipient";
type Basis = "removed_and_closed" | "closed_only";

const METRIC_KEYS: Record<Metric, MessageKey> = {
  tracked_titles: "web.dashboard.chart.metric.trackedTitles",
  titles_with_violations: "web.dashboard.chart.metric.titlesWithViolations",
  resolved_violations: "web.dashboard.chart.metric.resolvedViolations",
};

const GROUPING_KEYS: Record<Grouping, MessageKey> = {
  none: "web.dashboard.chart.grouping.none",
  title_group: "web.dashboard.chart.grouping.title_group",
  engine: "web.dashboard.chart.grouping.engine",
  recipient: "web.dashboard.chart.grouping.recipient",
};

const BASIS_KEYS: Record<Basis, MessageKey> = {
  removed_and_closed: "web.dashboard.chart.basis.removed_and_closed",
  closed_only: "web.dashboard.chart.basis.closed_only",
};

const ENGINE_NAME_KEYS: Record<EngineQuota["engine"], MessageKey> = {
  google: "dashboard.chart.engine.google",
  bing: "dashboard.chart.engine.bing",
  yandex: "dashboard.chart.engine.yandex",
};

/** The tiles' (label key, value) pairs, destructured per metric so the
 *  rendering never depends on the tiles object's key order. */
function tileEntries(
  metric: Metric,
  tiles: TrackedTiles | ViolationsTiles | ResolvedTiles,
): Array<[MessageKey, number]> {
  if (metric === "tracked_titles") {
    const { currentCount, pausedCount, titleGroupCount } = tiles as TrackedTiles;
    return [
      ["web.dashboard.chart.tiles.currentCount", currentCount],
      ["web.dashboard.chart.tiles.pausedCount", pausedCount],
      ["web.dashboard.chart.tiles.titleGroupCount", titleGroupCount],
    ];
  }
  if (metric === "titles_with_violations") {
    const { countToday, groupsAffectedToday, peakInWindow } =
      tiles as ViolationsTiles;
    return [
      ["web.dashboard.chart.tiles.countToday", countToday],
      ["web.dashboard.chart.tiles.groupsAffectedToday", groupsAffectedToday],
      ["web.dashboard.chart.tiles.peakInWindow", peakInWindow],
    ];
  }
  const { totalInWindow, removedCount, closedCount } = tiles as ResolvedTiles;
  return [
    ["web.dashboard.chart.tiles.totalInWindow", totalInWindow],
    ["web.dashboard.chart.tiles.removedCount", removedCount],
    ["web.dashboard.chart.tiles.closedCount", closedCount],
  ];
}

/** The stroke palette for a multi-series plot, one colour per series. */
const SERIES_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0d9488"];

/** The plot's geometry, shared by the axis and the series. */
const PLOT = { width: 640, height: 240, left: 48, right: 616, top: 12, bottom: 200 };

export const Route = createFileRoute("/")({
  component: Dashboard,
});

function Dashboard() {
  const { locale } = useSession();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chart, setChart] = useState<ChartBody | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>("tracked_titles");
  const [windowDays, setWindowDays] = useState<7 | 14 | 30>(14);
  const [groupBy, setGroupBy] = useState<Grouping>("none");
  const [basis, setBasis] = useState<Basis>("removed_and_closed");
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  const loadSummary = useCallback(async () => {
    const { data, response } = await api.GET("/dashboard/summary");
    if (response.ok && data) {
      setSummary(data as Summary);
      setError(null);
    } else {
      setError(t(locale, "web.common.error"));
    }
  }, [locale]);

  const loadChart = useCallback(async () => {
    const { data, response } = await api.GET("/dashboard/title-chart", {
      params: {
        query: {
          metric,
          windowDays,
          groupBy,
          ...(metric === "resolved_violations" ? { basis } : {}),
        },
      },
    });
    if (response.ok && data) {
      setChart(data as ChartBody);
      setSelectedDay(null);
      setChartError(null);
    } else {
      setChartError(t(locale, "web.common.error"));
    }
  }, [locale, metric, windowDays, groupBy, basis]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    void loadChart();
  }, [loadChart]);

  const dayLabel = useCallback(
    (index: number, total: number): string => {
      const ago = total - 1 - index;
      if (ago === 0) {
        return t(locale, "web.dashboard.chart.axis.today");
      }
      return interpolate(t(locale, "web.dashboard.chart.axis.daysAgo"), { count: String(ago) });
    },
    [locale],
  );

  const relativeTime = useCallback(
    (iso: string): string => {
      const elapsedMs = Date.now() - new Date(iso).getTime();
      const minutes = Math.floor(elapsedMs / 60_000);
      if (minutes < 1) {
        return t(locale, "web.dashboard.activity.time.now");
      }
      if (minutes < 60) {
        return interpolate(t(locale, "web.dashboard.activity.time.minutesAgo"), { count: String(minutes) });
      }
      const hours = Math.floor(minutes / 60);
      if (hours < 24) {
        return interpolate(t(locale, "web.dashboard.activity.time.hoursAgo"), { count: String(hours) });
      }
      return interpolate(t(locale, "web.dashboard.activity.time.daysAgo"), {
        count: String(Math.floor(hours / 24)),
      });
    },
    [locale],
  );

  const counters = summary?.counters;
  const chartEmpty =
    chart !== null && (chart.series.length === 0 || chart.series.every((series) => series.values.every((value) => value === 0)));
  const dashboardEmpty =
    summary !== null &&
    counters !== undefined &&
    counters.openViolations === 0 &&
    counters.candidatesToReview === 0 &&
    counters.noticesOnFile === 0 &&
    chartEmpty;

  return (
    <main>
      <h1>{t(locale, "web.dashboard.title")}</h1>
      {error !== null && <p role="alert">{error}</p>}

      {dashboardEmpty ? (
        <p>
          {t(locale, "web.dashboard.empty")}{" "}
          <Link to="/review">{t(locale, "web.review.runScans")}</Link>
        </p>
      ) : (
        <>
          <section aria-label={t(locale, "web.dashboard.title")}>
            {summary === null ? (
              <ul aria-busy="true">
                {[0, 1, 2, 3].map((index) => (
                  <li key={index} style={{ opacity: 0.4 }}>
                    {t(locale, "web.common.loading")}
                  </li>
                ))}
              </ul>
            ) : (
              <ul>
                <li>
                  <strong>{summary.counters.openViolations}</strong>{" "}
                  {t(locale, "web.dashboard.counter.openViolations")}
                </li>
                <li>
                  <strong>{summary.counters.candidatesToReview}</strong>{" "}
                  {t(locale, "web.dashboard.counter.candidatesToReview")}
                </li>
                <li>
                  <strong>{summary.counters.noticesOnFile}</strong>{" "}
                  {t(locale, "web.dashboard.counter.noticesOnFile")}
                </li>
                <li>
                  <strong>{summary.counters.acknowledgedSubmissions}</strong>{" "}
                  {t(locale, "web.dashboard.counter.acknowledgedSubmissions")}
                </li>
              </ul>
            )}
          </section>

          <section aria-label={t(locale, "web.dashboard.engines.title")}>
            <h2>{t(locale, "web.dashboard.engines.title")}</h2>
            {summary === null ? (
              <p aria-busy="true" style={{ opacity: 0.4 }}>
                {t(locale, "web.common.loading")}
              </p>
            ) : (
              <ul>
                {summary.engines.map((engine) => {
                  const used =
                    engine.scanReserved + engine.scanCommitted + engine.recheckReserved + engine.recheckCommitted;
                  return (
                    <li key={engine.engine}>
                      <strong>{t(locale, ENGINE_NAME_KEYS[engine.engine])}</strong>{" "}
                      {interpolate(t(locale, "web.dashboard.engines.allowance"), {
                        allowance: String(engine.allowanceUnits),
                      })}{" "}
                      —{" "}
                      {interpolate(t(locale, "web.dashboard.engines.used"), {
                        used: String(used),
                        percent: String(engine.percentUsed),
                      })}
                      {engine.exhausted && (
                        <strong role="status"> · {t(locale, "web.dashboard.engines.exhausted")}</strong>
                      )}
                      {engine.routeDisabled && (
                        <strong role="status"> · {t(locale, "web.dashboard.engines.routeDisabled")}</strong>
                      )}
                      {engine.alertLevel !== "normal" && (
                        <span>
                          {" "}
                          ·{" "}
                          {t(
                            locale,
                            engine.alertLevel === "critical"
                              ? "web.dashboard.engines.alert.critical"
                              : "web.dashboard.engines.alert.warning",
                          )}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-label={t(locale, "web.dashboard.activity.title")}>
            <h2>{t(locale, "web.dashboard.activity.title")}</h2>
            {summary === null ? (
              <ul aria-busy="true">
                {[0, 1, 2].map((index) => (
                  <li key={index} style={{ opacity: 0.4 }}>
                    {t(locale, "web.common.loading")}
                  </li>
                ))}
              </ul>
            ) : summary.activity.length === 0 ? (
              <p>{t(locale, "web.dashboard.empty")}</p>
            ) : (
              <ul>
                {summary.activity.map((entry) => (
                  <li key={entry.id}>
                    {entry.summary} · {relativeTime(entry.occurredAt)}{" "}
                    {/* The design gives every feed entry the link to Notices;
                        an entry that concerns a notice deep-links to it. */}
                    {entry.noticeId !== undefined ? (
                      <Link params={{ noticeId: entry.noticeId }} to="/notices/$noticeId">
                        {t(locale, "web.dashboard.activity.goToNotices")}
                      </Link>
                    ) : (
                      <Link to="/notices">{t(locale, "web.dashboard.activity.goToNotices")}</Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <section aria-label={t(locale, "web.dashboard.chart.title")}>
        <h2>{t(locale, "web.dashboard.chart.title")}</h2>
        {/* The metric selector is a segmented filter over one shared panel
            (the plot, tiles, and inspector below), not one tab panel per
            metric — so it renders as a labelled group of pressed-state
            buttons rather than an ARIA tablist it cannot honour. */}
        <p role="group" aria-label={t(locale, "web.dashboard.chart.metric")}>
          {(Object.keys(METRIC_KEYS) as Metric[]).map((value) => (
            <button
              key={value}
              aria-pressed={metric === value}
              onClick={() => setMetric(value)}
            >
              {t(locale, METRIC_KEYS[value])}
            </button>
          ))}
        </p>
        <p>
          <label>
            {t(locale, "web.dashboard.chart.window")}:{" "}
            <select
              value={windowDays}
              onChange={(event) => setWindowDays(Number(event.target.value) as 7 | 14 | 30)}
            >
              {[7, 14, 30].map((value) => (
                <option key={value} value={value}>
                  {interpolate(t(locale, "web.dashboard.chart.window.days"), { count: String(value) })}
                </option>
              ))}
            </select>
          </label>{" "}
          <label>
            {t(locale, "web.dashboard.chart.groupBy")}:{" "}
            <select
              value={groupBy}
              onChange={(event) => setGroupBy(event.target.value as Grouping)}
            >
              {(Object.keys(GROUPING_KEYS) as Grouping[]).map((value) => (
                <option key={value} value={value}>
                  {t(locale, GROUPING_KEYS[value])}
                </option>
              ))}
            </select>
          </label>
          {metric === "resolved_violations" && (
            <label>
              {" "}
              {t(locale, "web.dashboard.chart.basis")}:{" "}
              <select value={basis} onChange={(event) => setBasis(event.target.value as Basis)}>
                {(Object.keys(BASIS_KEYS) as Basis[]).map((value) => (
                  <option key={value} value={value}>
                    {t(locale, BASIS_KEYS[value])}
                  </option>
                ))}
              </select>
            </label>
          )}
        </p>

        {chartError !== null && <p role="alert">{chartError}</p>}
        {chart === null ? (
          <div aria-busy="true" style={{ opacity: 0.4, height: PLOT.height }}>
            {t(locale, "web.common.loading")}
          </div>
        ) : (
          <>
            <TitlePlot
              body={chart}
              selectedDay={selectedDay}
              onSelectDay={setSelectedDay}
              dayLabel={dayLabel}
              locale={locale}
            />
            {chart.groupingFallback && (
              <p role="note">{t(locale, "web.dashboard.chart.fallbackHint")}</p>
            )}
            {chartEmpty ? (
              <p>{t(locale, "web.dashboard.chart.empty")}</p>
            ) : (
              <Tiles metric={chart.metric} tiles={chart.tiles} locale={locale} />
            )}
            {selectedDay !== null && chart.days[selectedDay] !== undefined && (
              <div>
                <h3>{dayLabel(selectedDay, chart.days.length)}</h3>
                <ul>
                  {chart.series.map((series) => (
                    <li key={series.key}>
                      {series.label}: <strong>{series.values[selectedDay]}</strong>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}

/** The chart's three tiles, whatever the metric. */
function Tiles(props: {
  metric: Metric;
  tiles: TrackedTiles | ViolationsTiles | ResolvedTiles;
  locale: "en" | "ru";
}) {
  const { metric, tiles, locale } = props;
  return (
    <ul>
      {tileEntries(metric, tiles).map(([key, value]) => (
        <li key={key}>
          <strong>{value}</strong> {t(locale, key)}
        </li>
      ))}
    </ul>
  );
}

/** The plot itself: axis, series, guide, and the clickable day columns. */
function TitlePlot(props: {
  body: ChartBody;
  selectedDay: number | null;
  onSelectDay: (day: number | null) => void;
  dayLabel: (index: number, total: number) => string;
  locale: "en" | "ru";
}) {
  const { body, selectedDay, onSelectDay, dayLabel, locale } = props;
  const series = useMemo(() => body.series, [body]);
  const max = useMemo(
    () => Math.max(0, ...series.flatMap((entry) => entry.values)),
    [series],
  );
  const step = axisStep(max);
  const top = 4 * step;
  const { left, right, top: topEdge, bottom, width, height } = PLOT;
  const plotWidth = right - left;
  const plotHeight = bottom - topEdge;
  const days = body.days.length;
  const x = (index: number): number =>
    days <= 1 ? left + plotWidth / 2 : left + (index / (days - 1)) * plotWidth;
  const y = (value: number): number => bottom - (value / top) * plotHeight;

  // The X labels: the first day, the middle day, and the last day (Today).
  const labelIndexes =
    days <= 2
      ? Array.from({ length: days }, (_, index) => index)
      : [0, Math.floor((days - 1) / 2), days - 1];

  const singleSeries = series.length === 1;
  const areaPath =
    singleSeries && series[0] !== undefined
      ? [
          `M ${x(0)} ${bottom}`,
          ...series[0].values.map((value, index) => `L ${x(index)} ${y(value)}`),
          `L ${x(days - 1)} ${bottom}`,
          "Z",
        ].join(" ")
      : null;

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="group"
        aria-label={t(locale, "web.dashboard.chart.title")}
      >
        {/* The four equal Y ticks on the chosen step, gridlines to the plot. */}
        {[1, 2, 3, 4].map((tick) => (
          <g key={tick}>
            <line
              x1={left}
              x2={right}
              y1={y(tick * step)}
              y2={y(tick * step)}
              stroke="#d1d5db"
              strokeWidth={1}
            />
            <text x={left - 6} y={y(tick * step) + 4} textAnchor="end" fontSize={11}>
              {tick * step}
            </text>
          </g>
        ))}
        <line x1={left} x2={right} y1={bottom} y2={bottom} stroke="#9ca3af" strokeWidth={1} />
        {/* The X labels: first, middle, last — the last reads Today. */}
        {labelIndexes.map((index) => (
          <text key={index} x={x(index)} y={bottom + 18} textAnchor="middle" fontSize={11}>
            {dayLabel(index, days)}
          </text>
        ))}
        {/* The selected day's vertical guide. */}
        {selectedDay !== null && (
          <line
            x1={x(selectedDay)}
            x2={x(selectedDay)}
            y1={topEdge}
            y2={bottom}
            stroke="#6b7280"
            strokeWidth={1}
            strokeDasharray="4 3"
          />
        )}
        {/* A single series fills its area; several series are lines. */}
        {areaPath !== null ? (
          <path d={areaPath} fill="#93c5fd" stroke={SERIES_COLORS[0]} strokeWidth={2} />
        ) : (
          series.map((entry, seriesIndex) => (
            <polyline
              key={entry.key}
              fill="none"
              stroke={SERIES_COLORS[seriesIndex % SERIES_COLORS.length]}
              strokeWidth={2}
              points={entry.values.map((value, index) => `${x(index)},${y(value)}`).join(" ")}
            />
          ))
        )}
        {/* One invisible column per day: the day inspector's handle. The
            columns are focusable buttons, so the inspector is reachable
            from the keyboard and named by the day it selects. */}
        {body.days.map((day, index) => (
          <rect
            key={day}
            x={x(index) - plotWidth / (2 * Math.max(1, days - 1))}
            y={topEdge}
            width={Math.max(6, plotWidth / Math.max(1, days - 1))}
            height={plotHeight}
            fill="transparent"
            role="button"
            tabIndex={0}
            aria-label={dayLabel(index, days)}
            aria-pressed={selectedDay === index}
            onClick={() => onSelectDay(selectedDay === index ? null : index)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectDay(selectedDay === index ? null : index);
              }
            }}
          />
        ))}
      </svg>
      {!singleSeries && (
        <figcaption>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {series.map((entry, seriesIndex) => (
              <li key={entry.key} style={{ display: "inline-block", marginRight: "1rem" }}>
                <span
                  aria-hidden="true"
                  style={{
                    display: "inline-block",
                    width: "0.75rem",
                    height: "0.75rem",
                    background: SERIES_COLORS[seriesIndex % SERIES_COLORS.length],
                    marginRight: "0.25rem",
                  }}
                />
                {entry.label}
              </li>
            ))}
          </ul>
        </figcaption>
      )}
    </figure>
  );
}
