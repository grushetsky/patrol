import type { Pool } from "pg";
import type { Locale } from "@patrol/i18n";
import { t } from "@patrol/i18n";
import {
  allowanceUnits,
  bucketShares,
  capFor,
  isBucketExhausted,
  listMonthAlerts,
  monthStartOf,
  readCaps,
  readMonthLedgerRows,
  type BudgetAlertRow,
  type EngineName,
  type QuotaLedgerRow,
} from "@patrol/budget";

/**
 * The dashboard summary (docs/design/dashboard-ui.md "Dashboard"; contract
 * Patrol.Http.Dashboard /summary): the four counters with the draft-notice
 * badge, the engine quota row, and the five-entry activity feed merged from
 * the four event kinds the existing tables already record — scans that
 * finished, review decisions, notice approvals, submission acknowledgements.
 * Nothing here writes: every number is derived from the live rows.
 */

/** The four counters plus the draft badge, one statement. */
export const SUMMARY_COUNTERS_SQL = `select
  (select count(*)::int from violations where state = 'open') as open_violations,
  (select count(*)::int from candidates where state = 'pending' and band <> 'c') as candidates_to_review,
  (select count(*)::int from notices where state in ('draft', 'approved')) as notices_on_file,
  (select count(*)::int from notices where state = 'draft') as draft_notices,
  (select count(*)::int from submissions where state = 'acknowledged') as acknowledged_submissions`;

/**
 * The activity feed's single source: the four event kinds UNIONed, newest
 * first. Every branch selects the same columns so the merge is one sorted
 * stream; the id text keeps the uuidv7 order a stable tie-break. The feeds'
 * indexes (0010) lead with each source's timestamp so the ORDER BY … LIMIT
 * descends an index per branch.
 */
export const ACTIVITY_FEED_SQL = `(select s.id::text as id,
        case s.state
          when 'succeeded' then 'scan_succeeded'
          when 'partial' then 'scan_partial'
          else 'scan_failed' end as kind,
        s.finished_at as occurred_at,
        s.id::text as scan_id,
        null::text as candidate_id,
        null::text as notice_id,
        null::text as submission_id
   from scans s
  where s.state in ('succeeded', 'partial', 'failed'))
union all
(select d.id::text, 'review_decision', d.decided_at,
        null::text, d.candidate_id::text, null::text, null::text
   from review_decisions d)
union all
(select n.id::text, 'notice_approved', n.approved_at,
        null::text, null::text, n.id::text, null::text
   from notices n
  where n.approved_at is not null)
union all
(select sub.id::text, 'submission_acknowledged', sub.acknowledged_at,
        null::text, null::text, sub.notice_id::text, sub.id::text
   from submissions sub
  where sub.acknowledged_at is not null)
order by occurred_at desc, id
limit $1`;

/** The contract's DashboardCounters. */
export interface DashboardCounters {
  openViolations: number;
  candidatesToReview: number;
  noticesOnFile: number;
  draftNotices: number;
  acknowledgedSubmissions: number;
}

export async function readDashboardCounters(
  pool: Pool,
): Promise<DashboardCounters> {
  const result = await pool.query<{
    open_violations: number;
    candidates_to_review: number;
    notices_on_file: number;
    draft_notices: number;
    acknowledged_submissions: number;
  }>(SUMMARY_COUNTERS_SQL);
  const row = result.rows[0];
  return {
    openViolations: row.open_violations,
    candidatesToReview: row.candidates_to_review,
    noticesOnFile: row.notices_on_file,
    draftNotices: row.draft_notices,
    acknowledgedSubmissions: row.acknowledged_submissions,
  };
}

/** One feed row as the union returns it. */
interface ActivityRow {
  id: string;
  kind:
    | "scan_succeeded"
    | "scan_partial"
    | "scan_failed"
    | "review_decision"
    | "notice_approved"
    | "submission_acknowledged";
  occurred_at: Date;
  scan_id: string | null;
  candidate_id: string | null;
  notice_id: string | null;
  submission_id: string | null;
}

/** The catalogue key each activity kind's summary renders through. */
const ACTIVITY_KEYS = {
  scan_succeeded: "dashboard.activity.scan_succeeded",
  scan_partial: "dashboard.activity.scan_partial",
  scan_failed: "dashboard.activity.scan_failed",
  review_decision: "dashboard.activity.review_decision",
  notice_approved: "dashboard.activity.notice_approved",
  submission_acknowledged: "dashboard.activity.submission_acknowledged",
} as const;

/** The five most recent events, newest first, summaries in the locale. */
async function readActivityFeed(
  pool: Pool,
  locale: Locale,
  limit = 5,
): Promise<Record<string, unknown>[]> {
  const rows = await pool.query<ActivityRow>(ACTIVITY_FEED_SQL, [limit]);
  return rows.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    occurredAt: new Date(row.occurred_at).toISOString(),
    summary: t(locale, ACTIVITY_KEYS[row.kind]),
    ...(row.scan_id === null ? {} : { scanId: row.scan_id }),
    ...(row.candidate_id === null ? {} : { candidateId: row.candidate_id }),
    ...(row.notice_id === null ? {} : { noticeId: row.notice_id }),
    ...(row.submission_id === null ? {} : { submissionId: row.submission_id }),
  }));
}

/**
 * One engine's row (contract Patrol.Http.EngineQuotaStatus): the month's
 * ledger counters beside the live allowance, the share spent, the highest
 * alert level its buckets reached this month, whether a bucket is exhausted
 * (new work in it queues — never another engine's business), and whether
 * the route stands disabled.
 */
function engineQuotaRow(
  engine: EngineName,
  monthlyCapMinor: number,
  recheckSharePercent: number,
  row: QuotaLedgerRow | undefined,
  alerts: BudgetAlertRow[],
  disabledRoutes: Set<string>,
): Record<string, unknown> {
  const allowance = allowanceUnits(engine, monthlyCapMinor);
  const { scan: scanShare, recheck: recheckShare } = bucketShares(
    allowance,
    recheckSharePercent,
  );
  const scanReserved = row?.scanReserved ?? 0;
  const scanCommitted = row?.scanCommitted ?? 0;
  const recheckReserved = row?.recheckReserved ?? 0;
  const recheckCommitted = row?.recheckCommitted ?? 0;
  const used = scanReserved + scanCommitted + recheckReserved + recheckCommitted;
  const engineAlerts = alerts.filter((alert) => alert.engine === engine);
  const alertLevel = engineAlerts.some((alert) => alert.level === "critical")
    ? "critical"
    : engineAlerts.some((alert) => alert.level === "warning")
      ? "warning"
      : "normal";
  return {
    engine,
    allowanceUnits: allowance,
    scanReserved,
    scanCommitted,
    recheckReserved,
    recheckCommitted,
    // Rounded to keep the float32 field stable in JSON (0.3 * 100 is not 30
    // in binary floating point).
    percentUsed: allowance > 0 ? Math.round((used / allowance) * 10_000) / 100 : 0,
    alertLevel,
    exhausted:
      isBucketExhausted(scanReserved + scanCommitted, scanShare) ||
      isBucketExhausted(recheckReserved + recheckCommitted, recheckShare),
    routeDisabled: disabledRoutes.has(engine),
  };
}

/** GET /dashboard/summary's body. */
export async function readDashboardSummary(
  pool: Pool,
  now: () => Date,
  locale: Locale,
): Promise<Record<string, unknown>> {
  // Every read the body needs is independent — the counters, the engine
  // row's inputs (the live caps, the month's ledger, the alerts that fired,
  // the route state), and the activity feed — so they issue together.
  const monthStart = monthStartOf(now());
  const [counters, caps, ledgerRows, alerts, disabled, activity] =
    await Promise.all([
      readDashboardCounters(pool),
      readCaps(pool),
      readMonthLedgerRows(pool, monthStart),
      listMonthAlerts(pool, monthStart),
      pool.query<{ engine: string }>(
        "select engine from route_state where disabled",
      ),
      readActivityFeed(pool, locale),
    ]);
  const disabledRoutes = new Set(disabled.rows.map((row) => row.engine));
  const rowFor = (engine: EngineName): QuotaLedgerRow | undefined =>
    ledgerRows.find((ledger) => ledger.engine === engine);
  const engines = (["google", "bing", "yandex"] as const).map((engine) =>
    engineQuotaRow(
      engine,
      capFor(caps, engine),
      caps.budget_recheck_share_percent,
      rowFor(engine),
      alerts,
      disabledRoutes,
    ),
  );

  return { counters, engines, activity };
}
