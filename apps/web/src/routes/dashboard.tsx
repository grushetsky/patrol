import { useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  dashboardSummaryFn,
  sessionFn,
  titleChartFn,
  type ChartGrouping,
  type ChartInput,
  type ChartMetric,
  type ChartWindow,
  type DashboardSummary,
  type ResolvedBasis,
  type TitleChart,
} from "../api/server";
import { translate, useLanguage, type MessageKey } from "../i18n";
import { Badge, Button, Card, CardHeader, EmptyState, Spinner, cn } from "../components/ui";

const DEFAULT_INPUT: ChartInput = {
  metric: "tracked_titles",
  windowDays: 14,
  groupBy: "none",
};

export const Route = createFileRoute("/dashboard")({
  loader: async () => {
    const session = await sessionFn();
    if (!session) {
      return null;
    }
    const [summary, chart] = await Promise.all([
      dashboardSummaryFn(),
      titleChartFn({ data: DEFAULT_INPUT }),
    ]);
    return { summary, chart };
  },
  component: DashboardPage,
});

const METRICS: Array<{ value: ChartMetric; key: MessageKey }> = [
  { value: "tracked_titles", key: "dashTrackedTitles" },
  { value: "titles_with_violations", key: "dashTitlesWithViolations" },
  { value: "resolved_violations", key: "dashResolvedViolations" },
];

const GROUPINGS: Array<{ value: ChartGrouping; key: MessageKey }> = [
  { value: "none", key: "dashGroupNone" },
  { value: "title_group", key: "dashGroupTitleGroup" },
  { value: "engine", key: "dashGroupEngine" },
  { value: "recipient", key: "dashGroupRecipient" },
];

const WINDOWS: Array<{ value: ChartWindow; key: MessageKey }> = [
  { value: 7, key: "dashSevenDays" },
  { value: 14, key: "dashFourteenDays" },
  { value: 30, key: "dashThirtyDays" },
];

const BASES: Array<{ value: ResolvedBasis; key: MessageKey }> = [
  { value: "removed_and_closed", key: "dashRemovedAndClosed" },
  { value: "closed_only", key: "dashClosedOnly" },
];

function DashboardPage() {
  const data = Route.useLoaderData();
  if (!data) {
    return null;
  }
  const { summary: initialSummary, chart: initialChart } = data;
  const language = useLanguage();
  const router = useRouter();
  const t = (key: MessageKey, values?: Record<string, string | number>) =>
    translate(language, key, values);
  const [input, setInput] = useState<ChartInput>(DEFAULT_INPUT);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const isDefault =
    input.metric === DEFAULT_INPUT.metric &&
    input.windowDays === DEFAULT_INPUT.windowDays &&
    (input.groupBy ?? "none") === "none" &&
    !input.basis;

  const chartQuery = useQuery({
    queryKey: ["dashboard", "chart", input],
    queryFn: () => titleChartFn({ data: input }),
    placeholderData: keepPreviousData,
    initialData: isDefault ? initialChart : undefined,
  });
  const chart = chartQuery.data ?? initialChart;
  const summary: DashboardSummary = initialSummary;

  async function refresh() {
    setRefreshing(true);
    try {
      await router.invalidate();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
            {t("appTitle")} · {t("dashboard")}
          </p>
          <h1 className="page-title mt-1 text-4xl md:text-5xl">{t("dashboard")}</h1>
        </div>
        <Button variant="secondary" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? <Spinner label={t("loading")} /> : t("dashRefresh")}
        </Button>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <CounterCard value={summary.counters.openViolations} label={t("dashOpenViolations")} tone="error" />
        <CounterCard value={summary.counters.candidatesToReview} label={t("dashToReview")} tone="warning" />
        <CounterCard value={summary.counters.noticesOnFile} label={t("dashNoticesOnFile")} tone="accent" />
        <CounterCard value={summary.counters.acknowledgedSubmissions} label={t("dashAcknowledged")} tone="success" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.05fr_1.2fr]">
        <Card>
          <CardHeader
            title={t("dashEngines")}
            action={<Badge tone="neutral">{summary.engines.length}</Badge>}
          />
          <div className="space-y-3 p-4 md:p-5">
            {summary.engines.map((engine) => (
              <EngineRow key={engine.engine} engine={engine} t={t} />
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader
            title={t("dashActivity")}
            action={<Badge tone="accent">{summary.counters.draftNotices} {t("dashDraftNotices")}</Badge>}
          />
          <div className="divide-y divide-[var(--border)]">
            {summary.activity.length === 0 ? (
              <p className="px-5 py-8 text-sm text-[var(--muted)]">{t("dashNoActivity")}</p>
            ) : (
              summary.activity.map((entry) => (
                <div key={`${entry.kind}-${entry.id}`} className="flex items-start gap-3 px-5 py-3">
                  <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-[var(--fg)]">{entry.summary}</p>
                    <p className="mt-0.5 text-xs text-[var(--muted)]">{relativeTime(entry.occurredAt)}</p>
                  </div>
                  {entry.noticeId ? (
                    <a
                      href="/notices"
                      className="text-xs text-[var(--accent)] hover:underline"
                    >
                      {t("notices")}
                    </a>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          title={t("dashChart")}
          subtitle={
            chart.groupingFallback
              ? `${t("dashFallback")} ${chart.requestedGrouping} → ${chart.appliedGrouping}`
              : `${t(`dash${metricKey(chart.metric)}`)} · ${chart.windowDays} d`
          }
          action={
            <div className="flex flex-wrap items-center gap-2">
              {chartQuery.isFetching ? <Spinner /> : null}
              <Badge tone={chart.groupingFallback ? "warning" : "accent"}>
                {chart.groupingFallback ? t("dashFallbackBadge") : t(`dashGroup${groupKey(chart.appliedGrouping)}`)}
              </Badge>
            </div>
          }
        />
        <div className="space-y-5 p-4 md:p-5">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Control label={t("dashMetric")}>
              <select
                value={input.metric}
                onChange={(event) =>
                  setInput((current) => ({
                    ...current,
                    metric: event.target.value as ChartMetric,
                  }))
                }
                className="glass-select w-full px-3 py-2 text-sm"
              >
                {METRICS.map((metric) => (
                  <option key={metric.value} value={metric.value}>
                    {t(metric.key)}
                  </option>
                ))}
              </select>
            </Control>
            <Control label={t("dashWindow")}>
              <select
                value={input.windowDays}
                onChange={(event) =>
                  setInput((current) => ({
                    ...current,
                    windowDays: Number(event.target.value) as ChartWindow,
                  }))
                }
                className="glass-select w-full px-3 py-2 text-sm"
              >
                {WINDOWS.map((window) => (
                  <option key={window.value} value={window.value}>
                    {t(window.key)}
                  </option>
                ))}
              </select>
            </Control>
            <Control label={t("dashGrouping")}>
              <select
                value={input.groupBy ?? "none"}
                onChange={(event) =>
                  setInput((current) => ({
                    ...current,
                    groupBy: event.target.value as ChartGrouping,
                  }))
                }
                className="glass-select w-full px-3 py-2 text-sm"
              >
                {GROUPINGS.map((grouping) => (
                  <option key={grouping.value} value={grouping.value}>
                    {t(grouping.key)}
                  </option>
                ))}
              </select>
            </Control>
            {input.metric === "resolved_violations" ? (
              <Control label={t("dashBasis")}>
                <select
                  value={input.basis ?? "removed_and_closed"}
                  onChange={(event) =>
                    setInput((current) => ({
                      ...current,
                      basis: event.target.value as ResolvedBasis,
                    }))
                  }
                  className="glass-select w-full px-3 py-2 text-sm"
                >
                  {BASES.map((basis) => (
                    <option key={basis.value} value={basis.value}>
                      {t(basis.key)}
                    </option>
                  ))}
                </select>
              </Control>
            ) : null}
          </div>

          {chart.series.length === 0 ? (
            <EmptyState title={t("dashNoData")} />
          ) : (
            <>
              <ChartPlot
                chart={chart}
                language={language}
                selectedDay={selectedDay}
                onSelectDay={setSelectedDay}
              />
              <TileRow chart={chart} t={t} />
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

function CounterCard({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone: "accent" | "success" | "warning" | "error";
}) {
  const colors = {
    accent: "var(--accent)",
    success: "var(--success)",
    warning: "var(--warning)",
    error: "var(--error)",
  };
  return (
    <Card className={cn("p-5", `glass-${tone}`)}>
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-[0.1em] text-[var(--muted)]">{label}</span>
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: colors[tone] }} />
      </div>
      <p className="mt-4 text-4xl font-semibold tabular-nums">{value}</p>
    </Card>
  );
}

function EngineRow({
  engine,
  t,
}: {
  engine: DashboardSummary["engines"][number];
  t: (key: MessageKey) => string;
}) {
  const tone =
    engine.alertLevel === "critical"
      ? "error"
      : engine.alertLevel === "warning"
        ? "warning"
        : "success";
  const width = Math.min(100, Math.max(0, engine.percentUsed));
  return (
    <div className="glass-inset p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium capitalize">{engine.engine}</span>
          <Badge tone={tone}>
            {engine.exhausted
              ? t("dashExhausted")
              : engine.alertLevel === "critical"
                ? t("dashCritical")
                : engine.alertLevel === "warning"
                  ? t("dashWarning")
                  : t("dashHealthy")}
          </Badge>
          {engine.routeDisabled ? <Badge tone="error">{t("dashRouteDisabled")}</Badge> : null}
        </div>
        <span className="text-xs tabular-nums text-[var(--muted)]">
          {engine.percentUsed.toFixed(1)}% {t("dashQuotaUsed")}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
        <div
          className="h-full rounded-full transition-[width]"
          style={{
            width: `${width}%`,
            background:
              tone === "error" ? "var(--error)" : tone === "warning" ? "var(--warning)" : "var(--success)",
          }}
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--muted)]">
        <span>scan {engine.scanReserved + engine.scanCommitted}/{engine.allowanceUnits}</span>
        <span>recheck {engine.recheckReserved + engine.recheckCommitted}</span>
      </div>
    </div>
  );
}

function Control({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1 text-xs text-[var(--muted)]">
      <span className="block font-medium uppercase tracking-wide">{label}</span>
      {children}
    </label>
  );
}

function ChartPlot({
  chart,
  language,
  selectedDay,
  onSelectDay,
}: {
  chart: TitleChart;
  language: "en" | "ru";
  selectedDay: number | null;
  onSelectDay: (index: number | null) => void;
}) {
  const t = (key: MessageKey, values?: Record<string, string | number>) =>
    translate(language, key, values);
  const width = 760;
  const height = 250;
  const pad = { left: 42, right: 18, top: 16, bottom: 34 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const days = chart.days;
  const maxValue = Math.max(1, ...chart.series.flatMap((series) => series.values));
  const step = Math.max(1, Math.ceil(maxValue / 4));
  const top = step * 4;
  const x = (index: number) =>
    pad.left + (days.length === 1 ? plotWidth / 2 : (index / (days.length - 1)) * plotWidth);
  const y = (value: number) => pad.top + plotHeight - (value / top) * plotHeight;
  const colors = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)"];
  const labelIndexes = [0, Math.floor((days.length - 1) / 2), days.length - 1];

  return (
    <div className="space-y-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img">
        {[0, 1, 2, 3, 4].map((tick) => (
          <g key={tick}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(tick * step)}
              y2={y(tick * step)}
              stroke="var(--border)"
              strokeDasharray="2 4"
            />
            <text
              x={pad.left - 8}
              y={y(tick * step) + 4}
              textAnchor="end"
              fill="var(--muted)"
              fontSize="10"
            >
              {tick * step}
            </text>
          </g>
        ))}
        {chart.series.map((series, seriesIndex) => {
          const points = series.values
            .map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`)
            .join(" ");
          return (
            <g key={series.key}>
              {chart.series.length === 1 ? (
                <polygon
                  points={`${pad.left},${y(0)} ${points} ${width - pad.right},${y(0)}`}
                  fill={colors[seriesIndex % colors.length]}
                  opacity="0.12"
                />
              ) : null}
              <polyline
                points={points}
                fill="none"
                stroke={colors[seriesIndex % colors.length]}
                strokeWidth="2.2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          );
        })}
        {labelIndexes.map((index) => (
          <text
            key={index}
            x={x(index)}
            y={height - 10}
            textAnchor={index === 0 ? "start" : index === days.length - 1 ? "end" : "middle"}
            fill="var(--muted)"
            fontSize="10"
          >
            {index === days.length - 1 ? t("dashToday") : t("dashDaysAgo", { n: days.length - 1 - index })}
          </text>
        ))}
        {days.map((day, index) => (
          <rect
            key={day}
            x={x(index) - plotWidth / (days.length - 1) / 2}
            y={pad.top}
            width={plotWidth / (days.length - 1)}
            height={plotHeight}
            fill="transparent"
            onClick={() => onSelectDay(selectedDay === index ? null : index)}
            className="cursor-pointer"
          />
        ))}
        {selectedDay !== null && days[selectedDay] ? (
          <line
            x1={x(selectedDay)}
            x2={x(selectedDay)}
            y1={pad.top}
            y2={pad.top + plotHeight}
            stroke="var(--accent)"
            strokeDasharray="3 3"
          />
        ) : null}
      </svg>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        {chart.series.map((series, index) => (
          <span key={series.key} className="inline-flex items-center gap-1.5 text-[var(--muted)]">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: colors[index % colors.length] }}
            />
            {series.label}
          </span>
        ))}
        <span className="ml-auto text-[var(--muted)]">
          {selectedDay === null
            ? t("dashInspector")
            : t("dashValues", {
                date: days[selectedDay] ?? "",
                values: chart.series
                  .map((series) => `${series.label} ${series.values[selectedDay] ?? 0}`)
                  .join(" · "),
              })}
        </span>
      </div>
    </div>
  );
}

function TileRow({
  chart,
  t,
}: {
  chart: TitleChart;
  t: (key: MessageKey) => string;
}) {
  const tiles: Array<{ label: string; value: number }> = [];
  if (chart.metric === "tracked_titles") {
    tiles.push(
      { label: t("dashCurrent"), value: chart.tiles.currentCount },
      { label: t("dashPaused"), value: chart.tiles.pausedCount },
      { label: t("dashGroups"), value: chart.tiles.titleGroupCount },
    );
  } else if (chart.metric === "titles_with_violations") {
    tiles.push(
      { label: t("dashCountToday"), value: chart.tiles.countToday },
      { label: t("dashGroupsAffected"), value: chart.tiles.groupsAffectedToday },
      { label: t("dashPeak"), value: chart.tiles.peakInWindow },
    );
  } else {
    tiles.push(
      { label: t("dashTotalInWindow"), value: chart.tiles.totalInWindow },
      { label: t("dashRemoved"), value: chart.tiles.removedCount },
      { label: t("dashClosed"), value: chart.tiles.closedCount },
    );
  }
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className="glass-inset px-3 py-2"
        >
          <p className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{tile.label}</p>
          <p className="mt-1 text-xl font-semibold tabular-nums">{tile.value}</p>
        </div>
      ))}
    </div>
  );
}

function metricKey(metric: ChartMetric): "TrackedTitles" | "TitlesWithViolations" | "ResolvedViolations" {
  return metric === "tracked_titles"
    ? "TrackedTitles"
    : metric === "titles_with_violations"
      ? "TitlesWithViolations"
      : "ResolvedViolations";
}

function groupKey(grouping: ChartGrouping): "None" | "TitleGroup" | "Engine" | "Recipient" {
  return grouping === "none"
    ? "None"
    : grouping === "title_group"
      ? "TitleGroup"
      : grouping === "engine"
        ? "Engine"
        : "Recipient";
}

function relativeTime(value: string): string {
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.round(diff / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
