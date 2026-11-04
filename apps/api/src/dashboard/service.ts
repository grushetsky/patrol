import type { Connectable } from "../db/migrations.js";
import { ApiError } from "../errors.js";
import { ENGINES, type SettingsService } from "../settings/service.js";

const RECIPIENTS = ["google", "bing", "yandex"] as const;
const LABELS: Record<string, string> = {
  google: "Google",
  bing: "Bing",
  yandex: "Yandex",
  unassigned: "No notice",
};
const DEFAULT_WINDOW_DAYS = 14;
const WINDOW_DAYS = new Set([7, 14, 30]);
const METRICS = new Set([
  "tracked_titles",
  "titles_with_violations",
  "resolved_violations",
]);
const GROUPINGS = new Set(["none", "title_group", "engine", "recipient"]);
const BASES = new Set(["removed_and_closed", "closed_only"]);
const ACTIVITY_LIMIT = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const APPLICABLE_GROUPINGS: Record<string, readonly string[]> = {
  tracked_titles: ["none", "title_group"],
  titles_with_violations: ["none", "title_group", "engine"],
  resolved_violations: ["none", "title_group", "engine", "recipient"],
};

export interface ChartQuery {
  metric: string;
  windowDays?: number;
  groupBy?: string;
  basis?: string;
}

interface DayWindow {
  start: Date;
  endExclusive: Date;
  days: string[];
}

interface Series {
  key: string;
  label: string;
  values: number[];
}

interface Bucket {
  label: string;
  days: Map<string, Set<string>>;
}

/** The dashboard counters, engine quota row, activity feed, and title chart. */
export class DashboardService {
  constructor(
    private readonly db: Connectable,
    private readonly settings: SettingsService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async summary(operatorId: string) {
    const counters = {
      openViolations: await this.count("violation", "state = 'open'"),
      candidatesToReview: await this.count("candidate", "state = 'pending'"),
      noticesOnFile: await this.count("notice", "1 = 1"),
      draftNotices: await this.count("notice", "state = 'draft'"),
      acknowledgedSubmissions: await this.count(
        "submission",
        "state = 'acknowledged'",
      ),
    };
    const budget = await this.settings.readBudget(operatorId);
    const alertLevels = new Map<string, AlertLevel>();
    for (const alert of budget.alerts) {
      if (alert.level === "critical") {
        alertLevels.set(alert.engine, "critical");
      } else if (
        alert.level === "warning" &&
        alertLevels.get(alert.engine) !== "critical"
      ) {
        alertLevels.set(alert.engine, "warning");
      }
    }
    const statusByEngine = new Map(
      budget.engines.map((status) => [status.engine, status]),
    );
    const engines = budget.ledger
      .map((row) => {
        const status = statusByEngine.get(row.engine);
        const scanUsed = row.scanReserved + row.scanCommitted;
        const recheckUsed = row.recheckReserved + row.recheckCommitted;
        const used = scanUsed + recheckUsed;
        const scanShare = status?.scanShareUnits ?? row.allowanceUnits;
        const recheckShare = status?.recheckShareUnits ?? 0;
        const computed = quotaAlertLevel({
          allowance: row.allowanceUnits,
          overall: row.allowanceUnits === 0 ? 0 : (used / row.allowanceUnits) * 100,
          scan: scanShare === 0 ? 0 : (scanUsed / scanShare) * 100,
          recheck: recheckShare === 0 ? 0 : (recheckUsed / recheckShare) * 100,
        });
        return {
          engine: row.engine,
          allowanceUnits: row.allowanceUnits,
          scanReserved: row.scanReserved,
          scanCommitted: row.scanCommitted,
          recheckReserved: row.recheckReserved,
          recheckCommitted: row.recheckCommitted,
          percentUsed:
            row.allowanceUnits === 0 ? 0 : (used / row.allowanceUnits) * 100,
          alertLevel: higherAlert(
            alertLevels.get(row.engine) ?? "normal",
            computed,
          ),
          exhausted: status?.exhausted ?? false,
          routeDisabled: status?.routeDisabled ?? false,
        };
      })
      .sort((left, right) => rank(ENGINES, left.engine) - rank(ENGINES, right.engine));
    return {
      counters,
      engines,
      activity: await this.activity(),
    };
  }

  async chart(input: ChartQuery) {
    if (!METRICS.has(input.metric)) {
      throw badRequest(
        "/metric",
        "The metric must be tracked_titles, titles_with_violations, or resolved_violations.",
      );
    }
    const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
    if (!WINDOW_DAYS.has(windowDays)) {
      throw badRequest("/windowDays", "The window must be 7, 14, or 30 days.");
    }
    const requestedGrouping = input.groupBy ?? "none";
    if (!GROUPINGS.has(requestedGrouping)) {
      throw badRequest("/groupBy", "The grouping is not one of the declared values.");
    }
    const basis = input.basis ?? "removed_and_closed";
    if (!BASES.has(basis)) {
      throw badRequest("/basis", "The basis is not one of the declared values.");
    }
    const window = dayWindow(this.clock(), windowDays);
    const appliedGrouping = APPLICABLE_GROUPINGS[input.metric].includes(
      requestedGrouping,
    )
      ? requestedGrouping
      : "none";
    const base = {
      windowDays,
      requestedGrouping,
      appliedGrouping,
      groupingFallback: appliedGrouping !== requestedGrouping,
      days: window.days,
    };
    if (input.metric === "tracked_titles") {
      return {
        metric: "tracked_titles",
        ...base,
        ...(await this.trackedTitles(window, appliedGrouping)),
      };
    }
    if (input.metric === "titles_with_violations") {
      return {
        metric: "titles_with_violations",
        ...base,
        ...(await this.titlesWithViolations(window, appliedGrouping)),
      };
    }
    return {
      metric: "resolved_violations",
      ...base,
      resolvedBasis: basis,
      ...(await this.resolvedViolations(window, appliedGrouping, basis)),
    };
  }

  private async count(table: string, where: string): Promise<number> {
    const row = (
      await this.db.query(`SELECT count(*) AS count FROM ${table} WHERE ${where}`)
    ).rows[0];
    return Number(row?.count ?? 0);
  }

  private async activity() {
    const [scans, decisions, notices, acknowledgements] = await Promise.all([
      this.db.query(
        `SELECT s.id, s.state, s.engine, s.finished_at, g.name AS group_name
           FROM scan s
           LEFT JOIN title_group g ON g.id = s.title_group_id
          WHERE s.finished_at IS NOT NULL
            AND s.state IN ('succeeded', 'partial', 'failed')
          ORDER BY s.finished_at DESC
          LIMIT $1`,
        [ACTIVITY_LIMIT],
      ),
      this.db.query(
        `SELECT d.id, d.action, d.candidate_id, d.decided_at
           FROM review_decision d
          ORDER BY d.decided_at DESC
          LIMIT $1`,
        [ACTIVITY_LIMIT],
      ),
      this.db.query(
        `SELECT id, recipient, approved_at
           FROM notice
          WHERE approved_at IS NOT NULL
          ORDER BY approved_at DESC
          LIMIT $1`,
        [ACTIVITY_LIMIT],
      ),
      this.db.query(
        `SELECT s.id, s.notice_id, s.updated_at, n.recipient
           FROM submission s
           JOIN notice n ON n.id = s.notice_id
          WHERE s.state = 'acknowledged'
          ORDER BY s.updated_at DESC
          LIMIT $1`,
        [ACTIVITY_LIMIT],
      ),
    ]);
    const entries: Array<Record<string, unknown>> = [];
    for (const row of scans.rows) {
      const engine = String(row.engine);
      entries.push({
        id: String(row.id),
        kind: `scan_${String(row.state)}`,
        occurredAt: iso(row.finished_at),
        summary: `${label(engine)} scan ${String(row.state)}${
          row.group_name ? ` for ${String(row.group_name)}` : ""
        }.`,
        scanId: String(row.id),
      });
    }
    for (const row of decisions.rows) {
      entries.push({
        id: String(row.id),
        kind: "review_decision",
        occurredAt: iso(row.decided_at),
        summary: `Review decision: ${String(row.action)}.`,
        candidateId: String(row.candidate_id),
      });
    }
    for (const row of notices.rows) {
      entries.push({
        id: String(row.id),
        kind: "notice_approved",
        occurredAt: iso(row.approved_at),
        summary: `${label(String(row.recipient))} notice approved.`,
        noticeId: String(row.id),
      });
    }
    for (const row of acknowledgements.rows) {
      entries.push({
        id: String(row.id),
        kind: "submission_acknowledged",
        occurredAt: iso(row.updated_at),
        summary: `${label(String(row.recipient))} submission acknowledged.`,
        noticeId: String(row.notice_id),
        submissionId: String(row.id),
      });
    }
    return entries
      .sort(
        (left, right) =>
          new Date(String(right.occurredAt)).getTime() -
          new Date(String(left.occurredAt)).getTime(),
      )
      .slice(0, ACTIVITY_LIMIT);
  }

  private async trackedTitles(window: DayWindow, grouping: string) {
    const titles = (
      await this.db.query(
        `SELECT t.id, t.title_group_id, t.paused
           FROM tracked_title t
          WHERE t.merged_into_title_id IS NULL`,
      )
    ).rows;
    const groups = (
      await this.db.query("SELECT id, name FROM title_group ORDER BY name ASC")
    ).rows;
    const active = titles.filter((row) => !row.paused);
    const series: Series[] = [];
    if (grouping === "title_group") {
      for (const group of groups) {
        const id = String(group.id);
        const count = active.filter((row) => String(row.title_group_id) === id).length;
        if (count === 0) {
          continue;
        }
        series.push({
          key: id,
          label: String(group.name),
          values: window.days.map(() => count),
        });
      }
    } else {
      series.push({
        key: "total",
        label: "All tracked titles",
        values: window.days.map(() => active.length),
      });
    }
    return {
      series,
      tiles: {
        currentCount: active.length,
        pausedCount: titles.length - active.length,
        titleGroupCount: groups.length,
      },
    };
  }

  private async titlesWithViolations(window: DayWindow, grouping: string) {
    const rows = (
      await this.db.query(
        `SELECT v.tracked_title_id, v.engine, v.detected_at, v.closed_at,
                t.title_group_id AS group_id, g.name AS group_name
           FROM violation v
           JOIN tracked_title t ON t.id = v.tracked_title_id
           JOIN title_group g ON g.id = t.title_group_id
          WHERE v.detected_at < $1
            AND (v.closed_at IS NULL OR v.closed_at >= $2)`,
        [window.endExclusive, window.start],
      )
    ).rows;
    const total = newDaySets();
    const groups = new Map<string, Bucket>();
    const engines = new Map<string, Bucket>();
    const titleGroup = new Map<string, string>();
    for (const row of rows) {
      const titleId = String(row.tracked_title_id);
      const groupId = String(row.group_id ?? "");
      if (groupId) {
        titleGroup.set(titleId, groupId);
      }
      const first = openStart(window.days, isoDate(row.detected_at));
      const last = openEnd(window.days, row.closed_at);
      for (let index = first; index < last; index += 1) {
        const day = window.days[index];
        addTitle(total, day, titleId);
        if (groupId) {
          addBucket(groups, groupId, String(row.group_name ?? groupId), day, titleId);
        }
        if (row.engine) {
          addBucket(engines, String(row.engine), label(String(row.engine)), day, titleId);
        }
      }
    }
    const today = window.days[window.days.length - 1];
    const todayTitles = total.get(today) ?? new Set<string>();
    const groupsToday = new Set<string>();
    for (const titleId of todayTitles) {
      const groupId = titleGroup.get(titleId);
      if (groupId) {
        groupsToday.add(groupId);
      }
    }
    return {
      series: groupedSeries(
        grouping,
        window.days,
        {
          key: "total",
          label: "All titles",
          values: totalValues(total, window.days),
        },
        { titleGroup: groups, engine: engines },
      ),
      tiles: {
        countToday: todayTitles.size,
        groupsAffectedToday: groupsToday.size,
        peakInWindow: Math.max(
          0,
          ...window.days.map((day) => (total.get(day) ?? new Set()).size),
        ),
      },
    };
  }

  private async resolvedViolations(
    window: DayWindow,
    grouping: string,
    basis: string,
  ) {
    const states = basis === "closed_only" ? ["closed"] : ["removed", "closed"];
    const placeholders = states.map((_, index) => `$${index + 3}`).join(", ");
    const rows = (
      await this.db.query(
        `SELECT v.id, v.engine, v.state, v.closed_at,
                COALESCE(v.title_group_id, t.title_group_id) AS group_id,
                g.name AS group_name
           FROM violation v
           JOIN tracked_title t ON t.id = v.tracked_title_id
           LEFT JOIN title_group g
             ON g.id = COALESCE(v.title_group_id, t.title_group_id)
          WHERE v.closed_at >= $1 AND v.closed_at < $2
            AND v.state IN (${placeholders})`,
        [window.start, window.endExclusive, ...states],
      )
    ).rows;
    const recipients = await this.recipientsFor(rows.map((row) => String(row.id)));
    const total = newDaySets();
    const groups = new Map<string, Bucket>();
    const engines = new Map<string, Bucket>();
    const byRecipient = new Map<string, Bucket>();
    let removedCount = 0;
    let closedCount = 0;
    for (const row of rows) {
      const index = window.days.indexOf(isoDate(row.closed_at));
      if (index < 0) {
        continue;
      }
      const day = window.days[index];
      const id = String(row.id);
      addTitle(total, day, id);
      if (row.group_id) {
        addBucket(groups, String(row.group_id), String(row.group_name ?? row.group_id), day, id);
      }
      if (row.engine) {
        addBucket(engines, String(row.engine), label(String(row.engine)), day, id);
      }
      const recipient = recipients.get(id) ?? "unassigned";
      addBucket(byRecipient, recipient, label(recipient), day, id);
      if (String(row.state) === "removed") {
        removedCount += 1;
      } else {
        closedCount += 1;
      }
    }
    return {
      series: groupedSeries(
        grouping,
        window.days,
        {
          key: "total",
          label: "All resolved violations",
          values: totalValues(total, window.days),
        },
        { titleGroup: groups, engine: engines, recipient: byRecipient },
      ),
      tiles: {
        totalInWindow: rows.length,
        removedCount,
        closedCount,
      },
    };
  }

  private async recipientsFor(violationIds: string[]) {
    const result = new Map<string, string>();
    if (violationIds.length === 0) {
      return result;
    }
    const placeholders = violationIds.map((_, index) => `$${index + 1}`).join(", ");
    const rows = (
      await this.db.query(
        `SELECT c.violation_id, n.recipient, n.created_at
           FROM notice_citation c
           JOIN notice n ON n.id = c.notice_id
          WHERE c.violation_id IN (${placeholders})
          ORDER BY n.created_at DESC`,
        violationIds,
      )
    ).rows;
    for (const row of rows) {
      const id = String(row.violation_id);
      if (!result.has(id)) {
        result.set(id, String(row.recipient));
      }
    }
    return result;
  }
}

function badRequest(path: string, message: string) {
  return new ApiError(400, "validation_failed", message, undefined, {
    fieldErrors: [{ path, message }],
  });
}

type AlertLevel = "normal" | "warning" | "critical";

function quotaAlertLevel(percent: {
  allowance: number;
  overall: number;
  scan: number;
  recheck: number;
}): AlertLevel {
  if (percent.allowance === 0) {
    return "normal";
  }
  if (percent.scan >= 90 || percent.recheck >= 90) {
    return "critical";
  }
  return percent.overall >= 75 ? "warning" : "normal";
}

function higherAlert(left: AlertLevel, right: AlertLevel): AlertLevel {
  const order: Record<AlertLevel, number> = {
    normal: 0,
    warning: 1,
    critical: 2,
  };
  return order[right] > order[left] ? right : left;
}

function newDaySets() {
  return new Map<string, Set<string>>();
}

function addTitle(
  sets: Map<string, Set<string>>,
  day: string,
  key: string,
) {
  const values = sets.get(day) ?? new Set<string>();
  values.add(key);
  sets.set(day, values);
}

function addBucket(
  buckets: Map<string, Bucket>,
  key: string,
  bucketLabel: string,
  day: string,
  titleId: string,
) {
  const bucket = buckets.get(key) ?? { label: bucketLabel, days: newDaySets() };
  addTitle(bucket.days, day, titleId);
  buckets.set(key, bucket);
}

function totalValues(
  sets: Map<string, Set<string>>,
  days: string[],
): number[] {
  return days.map((day) => (sets.get(day) ?? new Set()).size);
}

function bucketSeries(
  buckets: Map<string, Bucket>,
  days: string[],
  order: (left: string, right: string) => number,
): Series[] {
  return [...buckets.entries()]
    .filter(([, bucket]) => days.some((day) => (bucket.days.get(day) ?? new Set()).size > 0))
    .sort(([left], [right]) => order(left, right))
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      values: totalValues(bucket.days, days),
    }));
}

function groupedSeries(
  grouping: string,
  days: string[],
  total: Series,
  buckets: {
    titleGroup?: Map<string, Bucket>;
    engine?: Map<string, Bucket>;
    recipient?: Map<string, Bucket>;
  },
): Series[] {
  if (grouping === "title_group" && buckets.titleGroup) {
    return bucketSeries(buckets.titleGroup, days, (left, right) =>
      left.localeCompare(right),
    );
  }
  if (grouping === "engine" && buckets.engine) {
    return bucketSeries(buckets.engine, days, (left, right) =>
      rank(ENGINES, left) - rank(ENGINES, right),
    );
  }
  if (grouping === "recipient" && buckets.recipient) {
    return bucketSeries(buckets.recipient, days, (left, right) =>
      rank(RECIPIENTS, left) - rank(RECIPIENTS, right),
    );
  }
  return [total];
}

function dayWindow(now: Date, windowDays: number): DayWindow {
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const start = new Date(today.getTime() - (windowDays - 1) * DAY_MS);
  const endExclusive = new Date(today.getTime() + DAY_MS);
  return {
    start,
    endExclusive,
    days: Array.from({ length: windowDays }, (_, index) =>
      isoDate(new Date(start.getTime() + index * DAY_MS)),
    ),
  };
}

function openStart(days: string[], detected: string) {
  if (detected < days[0]) {
    return 0;
  }
  const index = days.indexOf(detected);
  return index < 0 ? days.length : index;
}

function openEnd(days: string[], closedAt: unknown) {
  if (!closedAt) {
    return days.length;
  }
  const closed = isoDate(closedAt);
  if (closed > days[days.length - 1]) {
    return days.length;
  }
  const index = days.indexOf(closed);
  return index < 0 ? 0 : index + 1;
}

function iso(value: unknown) {
  return new Date(value as string | Date).toISOString();
}

function isoDate(value: unknown) {
  return iso(value).slice(0, 10);
}

function label(key: string) {
  return LABELS[key] ?? key;
}

function rank(values: readonly string[], key: string) {
  const index = values.indexOf(key);
  return index === -1 ? values.length : index;
}
