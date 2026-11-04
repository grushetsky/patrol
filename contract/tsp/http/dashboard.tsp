namespace Patrol.Http;

using TypeSpec.Http;
using TypeSpec.OpenAPI;
using Patrol.Domain;

// The dashboard: four counters, the engine quota row, the five-entry activity
// feed, and the title chart with its three metrics.

@doc("The four counters that lead the dashboard.")
model DashboardCounters {
  @doc("Violations currently open.")
  openViolations: int32;

  @doc("Candidates awaiting a review decision.")
  candidatesToReview: int32;

  @doc("Notices on file, from draft onward.")
  noticesOnFile: int32;

  @doc("Draft notices awaiting approval, the Notices section badge.")
  draftNotices: int32;

  @doc("Submissions the recipients have acknowledged.")
  acknowledgedSubmissions: int32;
}

@doc("How loudly an engine's allowance is warning.")
enum QuotaAlertLevel {
  Normal: "normal",
  Warning: "warning",
  Critical: "critical",
}

@doc("One engine's allowance and route state, as the dashboard's engine row renders it.")
model EngineQuotaStatus {
  @doc("The engine.")
  engine: Engine;

  @doc("The month's billable units.")
  allowanceUnits: int32;

  @doc("Units reserved by scans and not yet settled.")
  scanReserved: int32;

  @doc("Units committed by scans.")
  scanCommitted: int32;

  @doc("Units reserved by re-checks and not yet settled.")
  recheckReserved: int32;

  @doc("Units committed by re-checks.")
  recheckCommitted: int32;

  @doc("The share of the allowance reserved or spent, as a percentage.")
  percentUsed: float32;

  @doc("The highest alert level the engine's buckets have reached this month.")
  alertLevel: QuotaAlertLevel;

  @doc("Whether a bucket is fully spent, so new work in it queues.")
  exhausted: boolean;

  @doc("Whether the route is disabled after an authentication failure or an empty provider balance.")
  routeDisabled: boolean;
}

@doc("The kinds of event the activity feed lists.")
enum ActivityKind {
  ScanSucceeded: "scan_succeeded",
  ScanPartial: "scan_partial",
  ScanFailed: "scan_failed",
  ReviewDecision: "review_decision",
  NoticeApproved: "notice_approved",
  SubmissionAcknowledged: "submission_acknowledged",
}

@doc("One entry in the dashboard's five-item activity feed.")
model ActivityEntry {
  @doc("The event's identifier.")
  id: string;

  @doc("What happened.")
  kind: ActivityKind;

  @doc("When it happened.")
  occurredAt: utcDateTime;

  @doc("A one-line description for the feed.")
  summary: string;

  @doc("The scan the event concerns, when it concerns one.")
  scanId?: ScanId;

  @doc("The candidate the event concerns, when it concerns one.")
  candidateId?: CandidateId;

  @doc("The notice the event concerns, when it concerns one.")
  noticeId?: NoticeId;

  @doc("The submission the event concerns, when it concerns one.")
  submissionId?: SubmissionId;
}

@doc("The dashboard's counters, engine row, and activity feed.")
model DashboardSummary {
  @doc("The four counters.")
  counters: DashboardCounters;

  @doc("One entry per engine, in Google, Bing, Yandex order.")
  engines: EngineQuotaStatus[];

  @doc("The five most recent events, newest first.")
  activity: ActivityEntry[];
}

@doc("The metric the chart plots. Exactly one is plotted at a time.")
enum ChartMetric {
  TrackedTitles: "tracked_titles",
  TitlesWithViolations: "titles_with_violations",
  ResolvedViolations: "resolved_violations",
}

@doc("The series dimension. Some metrics accept only a subset, and an inapplicable choice falls back to the total.")
enum ChartGrouping {
  None: "none",
  TitleGroup: "title_group",
  Engine: "engine",
  Recipient: "recipient",
}

@doc("Which closures count as resolved. Removed plus closed is the default.")
enum ResolvedBasis {
  RemovedAndClosed: "removed_and_closed",
  ClosedOnly: "closed_only",
}

@doc("The chart's window, in days ending today.")
enum ChartWindow {
  SevenDays: 7,
  FourteenDays: 14,
  ThirtyDays: 30,
}

@doc("One series of daily values, aligned with the response's days.")
model ChartSeries {
  @doc("The stable key for the series, such as a group identifier or an engine value.")
  key: string;

  @doc("The label the legend renders.")
  label: string;

  @doc("One value per day, in the same order as the response's days.")
  values: int32[];
}

@doc("The tiles under the tracked-titles chart.")
model TrackedTitlesTiles {
  @doc("Tracked titles that are not paused today.")
  currentCount: int32;

  @doc("Tracked titles that are paused today.")
  pausedCount: int32;

  @doc("How many title groups exist.")
  titleGroupCount: int32;
}

@doc("The tiles under the titles-with-violations chart.")
model TitlesWithViolationsTiles {
  @doc("Titles with at least one open violation today.")
  countToday: int32;

  @doc("How many title groups those titles span today.")
  groupsAffectedToday: int32;

  @doc("The highest daily count inside the window.")
  peakInWindow: int32;
}

@doc("The tiles under the resolved-violations chart.")
model ResolvedViolationsTiles {
  @doc("Violations that left the open state inside the window.")
  totalInWindow: int32;

  @doc("How many of them left because the URL stopped serving the copy.")
  removedCount: int32;

  @doc("How many of them were closed by an operator.")
  closedCount: int32;
}

@doc("The chart when the metric is tracked titles.")
model TrackedTitlesChart {
  @doc("The metric, which selects this shape.")
  metric: "tracked_titles";

  @doc("The window in days.")
  windowDays: int32;

  @doc("The grouping the request asked for.")
  requestedGrouping: ChartGrouping;

  @doc("The grouping the chart actually applied.")
  appliedGrouping: ChartGrouping;

  @doc("Whether the requested grouping was inapplicable and the total was plotted instead.")
  groupingFallback: boolean;

  @doc("The days the series are plotted over, oldest first.")
  days: plainDate[];

  @doc("One series per applied grouping value, or a single total.")
  series: ChartSeries[];

  @doc("The tiles the chart's header renders.")
  tiles: TrackedTitlesTiles;
}

@doc("The chart when the metric is titles with violations.")
model TitlesWithViolationsChart {
  @doc("The metric, which selects this shape.")
  metric: "titles_with_violations";

  @doc("The window in days.")
  windowDays: int32;

  @doc("The grouping the request asked for.")
  requestedGrouping: ChartGrouping;

  @doc("The grouping the chart actually applied.")
  appliedGrouping: ChartGrouping;

  @doc("Whether the requested grouping was inapplicable and the total was plotted instead.")
  groupingFallback: boolean;

  @doc("The days the series are plotted over, oldest first.")
  days: plainDate[];

  @doc("One series per applied grouping value, or a single total.")
  series: ChartSeries[];

  @doc("The tiles the chart's header renders.")
  tiles: TitlesWithViolationsTiles;
}

@doc("The chart when the metric is resolved violations.")
model ResolvedViolationsChart {
  @doc("The metric, which selects this shape.")
  metric: "resolved_violations";

  @doc("The window in days.")
  windowDays: int32;

  @doc("The grouping the request asked for.")
  requestedGrouping: ChartGrouping;

  @doc("The grouping the chart actually applied.")
  appliedGrouping: ChartGrouping;

  @doc("Whether the requested grouping was inapplicable and the total was plotted instead.")
  groupingFallback: boolean;

  @doc("The basis counted as resolved: removed plus closed, or closed only.")
  resolvedBasis: ResolvedBasis;

  @doc("The days the series are plotted over, oldest first.")
  days: plainDate[];

  @doc("One series per applied grouping value, or a single total.")
  series: ChartSeries[];

  @doc("The tiles the chart's header renders.")
  tiles: ResolvedViolationsTiles;
}

@doc("The chart's shape follows its metric.")
union TitleChartResponse {
  @doc("Tracked titles over the window.")
  TrackedTitles: TrackedTitlesChart,

  @doc("Titles with violations over the window.")
  TitlesWithViolations: TitlesWithViolationsChart,

  @doc("Resolved violations over the window.")
  ResolvedViolations: ResolvedViolationsChart,
}

@doc("The dashboard summary, activity feed, and title chart.")
@tag("Dashboard")
@useAuth(SessionCookie)
@route("/dashboard")
interface Dashboard {
  @doc("The four counters, the engine quota row, and the five most recent events.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/summary")
  op summary(): DashboardSummary | ReadErrors;

  @doc("The title chart for one metric and window. An inapplicable grouping falls back to the total rather than plotting an empty chart.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/title-chart")
  op titleChart(@query metric: ChartMetric, @query windowDays?: ChartWindow, @query groupBy?: ChartGrouping, @query basis?: ResolvedBasis): TitleChartResponse | ReadErrors | BadRequest;
}
