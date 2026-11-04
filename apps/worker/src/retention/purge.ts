import type { Connectable } from "../db.js";

const FIVE_YEARS = 5;
const TWELVE_MONTHS = 12;
const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
const LIVE_NOTICE_STATES = new Set(["draft", "approved"]);
const COMPLETED_SUBMISSION_STATES = new Set([
  "acknowledged",
  "rejected",
  "failed",
]);

export interface RetentionStore {
  delete?(key: string, version: string | null): Promise<void>;
}

export interface RetentionReport {
  evidencePurged: number;
  blobsDeleted: number;
  payloadsDeleted: number;
  heldSkipped: number;
}

interface EvidenceRow {
  id: string;
  observedAt: Date;
}

/**
 * Purges expired evidence bytes and raw payloads.
 *
 * The metadata marker is written before any bytes are deleted, so an
 * interrupted run leaves orphaned bytes rather than a citation that points at
 * a deleted object. Legal holds outrank every window.
 */
export async function purgeExpired(
  db: Connectable,
  store: RetentionStore | undefined,
  now: Date = new Date(),
): Promise<RetentionReport> {
  const evidenceRows = (
    await db.query(
      "SELECT id, observed_at FROM evidence WHERE purged_at IS NULL",
    )
  ).rows.map((row) => ({
    id: String(row.id),
    observedAt: asDate(row.observed_at),
  })) satisfies EvidenceRow[];
  const violationRows = (
    await db.query("SELECT id, state, closed_at FROM violation")
  ).rows;
  const violationEvidenceRows = (
    await db.query("SELECT violation_id, evidence_id FROM violation_evidence")
  ).rows;
  const noticeRows = (
    await db.query(
      `SELECT c.notice_id, c.violation_id, c.evidence_ids,
              n.state AS notice_state, n.created_at AS notice_created_at,
              n.updated_at AS notice_updated_at,
              s.state AS submission_state, s.cancelled_at,
              s.created_at AS submission_created_at,
              s.delivered_at AS submission_delivered_at,
              s.updated_at AS submission_updated_at
         FROM notice_citation c
         JOIN notice n ON n.id = c.notice_id
         LEFT JOIN submission s ON s.notice_id = n.id`,
    )
  ).rows;
  const decisionRows = (
    await db.query("SELECT evidence_ids, decided_at FROM review_decision")
  ).rows;

  const held = await heldEvidence(db, noticeRows, violationEvidenceRows);
  const live = new Set<string>();
  const closedAt = new Map<string, Date>();
  const lastDecision = new Map<string, Date>();

  const violationById = new Map(
    violationRows.map((row) => [String(row.id), row]),
  );
  for (const row of violationEvidenceRows) {
    const violation = violationById.get(String(row.violation_id));
    if (!violation) {
      continue;
    }
    if (String(violation.state) === "open") {
      live.add(String(row.evidence_id));
    } else {
      addClosed(closedAt, String(row.evidence_id), violation.closed_at ?? now);
    }
  }

  for (const row of noticeRows) {
    const evidenceIds = parseEvidenceIds(row.evidence_ids);
    const violation = violationById.get(String(row.violation_id));
    const violationLive = violation && String(violation.state) === "open";
    const violationClosed =
      violation && String(violation.state) !== "open"
        ? (violation.closed_at ?? now)
        : undefined;
    const noticeLive = LIVE_NOTICE_STATES.has(String(row.notice_state));
    const submissionLive =
      !row.submission_state ||
      !COMPLETED_SUBMISSION_STATES.has(String(row.submission_state));
    const cancelled = row.cancelled_at !== null && row.cancelled_at !== undefined;
    if (violationLive || (noticeLive && submissionLive && !cancelled)) {
      for (const id of evidenceIds) {
        live.add(id);
      }
      continue;
    }
    const closed =
      latestDate([
        violationClosed,
        row.submission_delivered_at,
        row.submission_updated_at,
        row.submission_created_at,
        row.notice_updated_at,
        row.notice_created_at,
      ]) ?? now;
    for (const id of evidenceIds) {
      addClosed(closedAt, id, closed);
    }
  }

  for (const row of decisionRows) {
    const decidedAt = asDate(row.decided_at);
    for (const id of parseEvidenceIds(row.evidence_ids)) {
      const current = lastDecision.get(id);
      if (!current || decidedAt > current) {
        lastDecision.set(id, decidedAt);
      }
    }
  }

  const expired: Array<{ id: string; reason: string }> = [];
  let heldSkipped = 0;
  for (const evidence of evidenceRows) {
    if (held.has(evidence.id)) {
      heldSkipped += 1;
      continue;
    }
    if (live.has(evidence.id)) {
      continue;
    }
    const closed = closedAt.get(evidence.id);
    const reason = closed ? "closed_citation_retention" : "uncited_retention";
    const deadline = closed
      ? addYears(closed, FIVE_YEARS)
      : addMonths(lastDecision.get(evidence.id) ?? evidence.observedAt, TWELVE_MONTHS);
    if (now >= deadline) {
      expired.push({ id: evidence.id, reason });
    }
  }

  for (const item of expired) {
    await db.query(
      `UPDATE evidence
          SET purged_at = $2, purge_reason = $3
        WHERE id = $1 AND purged_at IS NULL`,
      [item.id, now, item.reason],
    );
  }

  const blobsDeleted = await deleteUnreferencedBlobs(db, store);

  const payloadCutoff = new Date(now.getTime() - NINETY_DAYS);
  const payloadCount = (
    await db.query(
      "SELECT count(*) AS count FROM serp_payload WHERE created_at < $1",
      [payloadCutoff],
    )
  ).rows[0];
  await db.query("DELETE FROM serp_payload WHERE created_at < $1", [
    payloadCutoff,
  ]);

  return {
    evidencePurged: expired.length,
    blobsDeleted,
    payloadsDeleted: Number(payloadCount?.count ?? 0),
    heldSkipped,
  };
}

async function heldEvidence(
  db: Connectable,
  noticeRows: Array<Record<string, unknown>>,
  violationEvidenceRows: Array<Record<string, unknown>>,
) {
  const holds = (
    await db.query("SELECT * FROM legal_hold WHERE released_at IS NULL")
  ).rows;
  const held = new Set<string>();
  for (const hold of holds) {
    const evidenceIds = parseEvidenceIds(hold.evidence_ids);
    const violationIds = new Set(parseEvidenceIds(hold.violation_ids));
    const noticeIds = new Set(parseEvidenceIds(hold.notice_ids));
    for (const id of evidenceIds) {
      held.add(id);
    }
    for (const row of violationEvidenceRows) {
      if (violationIds.has(String(row.violation_id))) {
        held.add(String(row.evidence_id));
      }
    }
    for (const row of noticeRows) {
      if (
        violationIds.has(String(row.violation_id)) ||
        noticeIds.has(String(row.notice_id))
      ) {
        for (const id of parseEvidenceIds(row.evidence_ids)) {
          held.add(id);
        }
      }
    }
  }
  return held;
}

async function deleteUnreferencedBlobs(
  db: Connectable,
  store: RetentionStore | undefined,
) {
  if (!store?.delete) {
    return 0;
  }
  const purged = (
    await db.query(
      `SELECT a.sha256, a.object_key, a.object_version
         FROM evidence_artifact a
         JOIN evidence e ON e.id = a.evidence_id
        WHERE e.purged_at IS NOT NULL`,
    )
  ).rows;
  const candidates = new Map(
    purged.map((row) => [
      `${String(row.sha256)}|${String(row.object_key)}|${String(row.object_version)}`,
      row,
    ]),
  );
  let deleted = 0;
  for (const row of candidates.values()) {
    const live = (
      await db.query(
        `SELECT count(*) AS count
           FROM evidence_artifact a
           JOIN evidence e ON e.id = a.evidence_id
          WHERE a.sha256 = $1 AND e.purged_at IS NULL`,
        [String(row.sha256)],
      )
    ).rows[0];
    if (Number(live?.count ?? 0) > 0) {
      continue;
    }
    await store.delete(
      String(row.object_key),
      (row.object_version as string | null) ?? null,
    );
    deleted += 1;
  }
  return deleted;
}

function parseEvidenceIds(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) =>
        typeof item === "string"
          ? item
          : String((item as { evidenceId?: unknown } | null)?.evidenceId ?? ""),
      )
      .filter((id) => id.length > 0);
  } catch {
    return [];
  }
}

function addClosed(
  closedAt: Map<string, Date>,
  id: string,
  value: unknown,
) {
  const date = asDate(value);
  const current = closedAt.get(id);
  if (!current || date > current) {
    closedAt.set(id, date);
  }
}

function latestDate(values: unknown[]): Date | undefined {
  let latest: Date | undefined;
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }
    const date = asDate(value);
    if (!latest || date > latest) {
      latest = date;
    }
  }
  return latest;
}

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function addYears(value: Date, years: number) {
  const result = new Date(value);
  result.setUTCFullYear(result.getUTCFullYear() + years);
  return result;
}

function addMonths(value: Date, months: number) {
  const result = new Date(value);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}
