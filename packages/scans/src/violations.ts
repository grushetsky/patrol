import type { Pool, PoolClient } from "pg";

/**
 * The violation store (docs/design/matching-and-classification-rules.md
 * "Review decisions"; contract Patrol.Domain.Violation / ViolationEvidence;
 * INVARIANTS.md "Violations"). A violation is created only from a candidate
 * a review decision confirmed, is keyed by (normalized URL, tracked title)
 * with at most one open row per pair, and cites at least one pinned capture.
 * Neither the identity columns nor a citation is ever rewritten; a lifecycle
 * update is the one forward step out of open, and a reappearing URL starts a
 * new row linked to its predecessor.
 *
 * The store lives in this shared package because both processes write it:
 * the API creates violations inside the decision transaction, and the
 * worker records removals when a capture shows a URL gone.
 */

/** The violation lifecycle states (the contract's ViolationState). */
export type ViolationState = "open" | "removed" | "closed";

/** Why a violation left the open state (the contract's ViolationClosureReason). */
export type ViolationClosureReason = "url_removed" | "operator_closed";

/** One violations-table row. */
export interface ViolationRow {
  id: string;
  trackedTitleId: string;
  candidateId: string;
  reviewDecisionId: string;
  url: string;
  normalizedUrl: string;
  host: string;
  hostSource: "landing_page" | "submitted_url";
  registrableDomain: string;
  detectedAt: Date;
  confirmedAt: Date;
  confirmedBy: string;
  predecessorViolationId: string | null;
  state: ViolationState;
  openedAt: Date;
  closedAt: Date | null;
  closureReason: ViolationClosureReason | null;
  closureNote: string | null;
  closureEvidenceId: string | null;
  closedBy: string | null;
}

const VIOLATION_COLUMNS = `id, tracked_title_id, candidate_id, review_decision_id, url,
  normalized_url, host, host_source, registrable_domain, detected_at, confirmed_at,
  confirmed_by, predecessor_violation_id, state, opened_at, closed_at, closure_reason,
  closure_note, closure_evidence_id, closed_by`;

type RawViolationRow = {
  id: string;
  tracked_title_id: string;
  candidate_id: string;
  review_decision_id: string;
  url: string;
  normalized_url: string;
  host: string;
  host_source: "landing_page" | "submitted_url";
  registrable_domain: string;
  detected_at: Date;
  confirmed_at: Date;
  confirmed_by: string;
  predecessor_violation_id: string | null;
  state: ViolationState;
  opened_at: Date;
  closed_at: Date | null;
  closure_reason: ViolationClosureReason | null;
  closure_note: string | null;
  closure_evidence_id: string | null;
  closed_by: string | null;
};

export function mapViolation(row: RawViolationRow): ViolationRow {
  return {
    id: row.id,
    trackedTitleId: row.tracked_title_id,
    candidateId: row.candidate_id,
    reviewDecisionId: row.review_decision_id,
    url: row.url,
    normalizedUrl: row.normalized_url,
    host: row.host,
    hostSource: row.host_source,
    registrableDomain: row.registrable_domain,
    detectedAt: new Date(row.detected_at),
    confirmedAt: new Date(row.confirmed_at),
    confirmedBy: row.confirmed_by,
    predecessorViolationId: row.predecessor_violation_id,
    state: row.state,
    openedAt: new Date(row.opened_at),
    closedAt: row.closed_at === null ? null : new Date(row.closed_at),
    closureReason: row.closure_reason,
    closureNote: row.closure_note,
    closureEvidenceId: row.closure_evidence_id,
    closedBy: row.closed_by,
  };
}

/** A violation ready to insert, inside the caller's decision transaction. */
export interface NewViolation {
  /**
   * The violation's id, pre-generated so the decision row can name it
   * before the violation row lands (the two foreign keys point at each
   * other; one id must come first, and both land in one transaction).
   */
  id: string;
  trackedTitleId: string;
  candidateId: string;
  reviewDecisionId: string;
  url: string;
  normalizedUrl: string;
  host: string;
  hostSource: "landing_page" | "submitted_url";
  registrableDomain: string;
  detectedAt: Date;
  confirmedAt: Date;
  confirmedBy: string;
  predecessorViolationId: string | null;
}

/**
 * Inserts one violation as open. The caller runs inside the decision
 * transaction, after the decision row it names; the partial unique index on
 * (normalized_url, tracked_title_id) WHERE state = 'open' refuses a second
 * open row for the pair, which the caller maps onto its conflict answer.
 * Returns the inserted row.
 */
export async function insertViolation(
  client: PoolClient,
  violation: NewViolation,
): Promise<ViolationRow> {
  const result = await client.query<RawViolationRow>(
    `insert into violations
       (id, tracked_title_id, candidate_id, review_decision_id, url, normalized_url, host,
        host_source, registrable_domain, detected_at, confirmed_at, confirmed_by,
        predecessor_violation_id, state, opened_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'open', $11)
     returning ${VIOLATION_COLUMNS}`,
    [
      violation.id,
      violation.trackedTitleId,
      violation.candidateId,
      violation.reviewDecisionId,
      violation.url,
      violation.normalizedUrl,
      violation.host,
      violation.hostSource,
      violation.registrableDomain,
      violation.detectedAt,
      violation.confirmedAt,
      violation.confirmedBy,
      violation.predecessorViolationId,
    ],
  );
  return mapViolation(result.rows[0]);
}

/** Reads one violation by id; null when absent. */
export async function readViolation(
  pool: Pool,
  violationId: string,
): Promise<ViolationRow | null> {
  const result = await pool.query<RawViolationRow>(
    `select ${VIOLATION_COLUMNS} from violations where id = $1`,
    [violationId],
  );
  return result.rows.length === 0 ? null : mapViolation(result.rows[0]);
}

/** The open violation for one (URL, tracked title) pair, when one stands. */
export async function openViolationForPair(
  client: Pool | PoolClient,
  input: { normalizedUrl: string; trackedTitleId: string },
): Promise<ViolationRow | null> {
  const result = await client.query<RawViolationRow>(
    `select ${VIOLATION_COLUMNS} from violations
      where normalized_url = $1 and tracked_title_id = $2 and state = 'open'`,
    [input.normalizedUrl, input.trackedTitleId],
  );
  return result.rows.length === 0 ? null : mapViolation(result.rows[0]);
}

/**
 * The most recent violation of the pair that left the open state, when one
 * exists — the predecessor a reappearance's confirm links to. The closed
 * record is never reopened; a new row carries the chain.
 */
export async function latestTerminalViolationForPair(
  client: Pool | PoolClient,
  input: { normalizedUrl: string; trackedTitleId: string },
): Promise<ViolationRow | null> {
  const result = await client.query<RawViolationRow>(
    `select ${VIOLATION_COLUMNS} from violations
      where normalized_url = $1 and tracked_title_id = $2 and state <> 'open'
      order by closed_at desc, id
      limit 1`,
    [input.normalizedUrl, input.trackedTitleId],
  );
  return result.rows.length === 0 ? null : mapViolation(result.rows[0]);
}

/** Every open violation whose URL is one normalized URL. */
export async function openViolationsForUrl(
  pool: Pool,
  normalizedUrl: string,
): Promise<ViolationRow[]> {
  const result = await pool.query<RawViolationRow>(
    `select ${VIOLATION_COLUMNS} from violations
      where normalized_url = $1 and state = 'open'
      order by id`,
    [normalizedUrl],
  );
  return result.rows.map(mapViolation);
}

/** What one closure attempt produced. */
export type ViolationClosureResult =
  | { status: "closed"; violation: ViolationRow }
  | { status: "not_open"; violation: ViolationRow }
  | { status: "absent" };

/**
 * The one forward lifecycle step out of open, guarded to run exactly once:
 * an update that matches only an open row. A worker-recorded removal names
 * no operator; an operator-recorded removal or closure names the operator,
 * and an operator closure carries its note (the table's CHECKs hold the
 * rest). The trigger refuses anything but this step.
 */
async function closeOpenViolation(
  pool: Pool,
  now: () => Date,
  input: {
    violationId: string;
    reason: ViolationClosureReason;
    note: string | null;
    evidenceId: string | null;
    operatorId: string | null;
  },
): Promise<ViolationClosureResult> {
  // The reason names the cause; the state it leaves the violation in is
  // derived from it (url_removed -> removed, operator_closed -> closed).
  const nextState = input.reason === "url_removed" ? "removed" : "closed";
  const result = await pool.query<RawViolationRow>(
    `update violations
        set state = $2, closed_at = $3, closure_reason = $4,
            closure_note = $5, closure_evidence_id = $6, closed_by = $7
      where id = $1 and state = 'open'
      returning ${VIOLATION_COLUMNS}`,
    [
      input.violationId,
      nextState,
      now(),
      input.reason,
      input.note,
      input.evidenceId,
      input.operatorId,
    ],
  );
  if (result.rows.length > 0) {
    return { status: "closed", violation: mapViolation(result.rows[0]) };
  }
  const standing = await readViolation(pool, input.violationId);
  if (standing === null) {
    return { status: "absent" };
  }
  return { status: "not_open", violation: standing };
}

/**
 * Records that a capture showed a URL gone: every open violation of the URL
 * leaves the open state as `removed`, with the capture that showed it (the
 * newest capture, retained) and the reason frozen on the row. Removal is
 * terminal; a reappearance starts a new violation. Idempotent per capture:
 * a violation already removed stays exactly as it was.
 */
export async function recordRemovalsForDeadCapture(
  pool: Pool,
  now: () => Date,
  input: { normalizedUrl: string; evidenceId: string },
): Promise<ViolationRow[]> {
  const open = await openViolationsForUrl(pool, input.normalizedUrl);
  const removed: ViolationRow[] = [];
  for (const violation of open) {
    const outcome = await closeOpenViolation(pool, now, {
      violationId: violation.id,
      reason: "url_removed",
      note: null,
      evidenceId: input.evidenceId,
      operatorId: null,
    });
    if (outcome.status === "closed") {
      removed.push(outcome.violation);
    }
  }
  return removed;
}

/** Closes an open violation an operator recorded, by either reason. */
export async function recordOperatorClosure(
  pool: Pool,
  now: () => Date,
  input: {
    violationId: string;
    operatorId: string;
    reason: ViolationClosureReason;
    note: string | null;
    evidenceId: string | null;
  },
): Promise<ViolationClosureResult> {
  return closeOpenViolation(pool, now, {
    violationId: input.violationId,
    reason: input.reason,
    note: input.note ?? null,
    evidenceId: input.evidenceId,
    operatorId: input.operatorId,
  });
}

/** One pinned citation (the violation_evidence table). */
export interface ViolationCitation {
  violationId: string;
  evidenceId: string;
  role: "detection" | "review" | "pre_handoff";
  citedAt: Date;
  pinnedVersions: Array<{ kind: string; sha256: string; objectVersion: string | null }>;
}

/**
 * Cites one capture for one violation, pinning the artifact versions as
 * they stand at citation time. The insert is idempotent on the pair: a
 * second citation of the same capture keeps the first pin, because a pin is
 * the fact at citation, not a pointer that follows the store.
 */
export async function citeViolationEvidence(
  client: PoolClient,
  citation: Omit<ViolationCitation, "pinnedVersions"> & {
    pinnedVersions: ViolationCitation["pinnedVersions"];
  },
): Promise<void> {
  await client.query(
    `insert into violation_evidence (violation_id, evidence_id, role, cited_at, pinned_versions)
     values ($1, $2, $3, $4, $5::jsonb)
     on conflict (violation_id, evidence_id) do nothing`,
    [
      citation.violationId,
      citation.evidenceId,
      citation.role,
      citation.citedAt,
      JSON.stringify(citation.pinnedVersions),
    ],
  );
}

/**
 * The artifact versions a citation pins: one {kind, sha256, objectVersion}
 * per artifact of the capture, read inside the caller's transaction so the
 * pin and the citation land together.
 */
export async function pinnedVersionsForEvidence(
  client: PoolClient,
  evidenceId: string,
): Promise<ViolationCitation["pinnedVersions"]> {
  const result = await client.query<{
    kind: string;
    sha256: string;
    object_version: string | null;
  }>(
    `select kind, sha256, object_version from evidence_artifacts
      where evidence_id = $1 order by kind`,
    [evidenceId],
  );
  return result.rows.map((row) => ({
    kind: row.kind,
    sha256: row.sha256,
    objectVersion: row.object_version,
  }));
}

/** The citations of one violation, newest first. */
export async function citationsForViolation(
  pool: Pool,
  violationId: string,
): Promise<ViolationCitation[]> {
  const result = await pool.query<{
    violation_id: string;
    evidence_id: string;
    role: "detection" | "review" | "pre_handoff";
    cited_at: Date;
    pinned_versions: ViolationCitation["pinnedVersions"];
  }>(
    `select violation_id, evidence_id, role, cited_at, pinned_versions
       from violation_evidence
      where violation_id = $1
      order by cited_at desc, evidence_id`,
    [violationId],
  );
  return result.rows.map((row) => ({
    violationId: row.violation_id,
    evidenceId: row.evidence_id,
    role: row.role,
    citedAt: new Date(row.cited_at),
    pinnedVersions: row.pinned_versions ?? [],
  }));
}

/**
 * Whether any violation under one title group is still open — the re-check
 * ladder's continuation question ("every 14 days for as long as any
 * violation from that pair is `Open`"; docs/design/scan-scheduling.md "The
 * re-check ladder"). Documented deviation: the doc keys a re-check by
 * `(title group, engine)` because a scan targets exactly that pair, while
 * a violation is not engine-owned — it records no engine — so the open
 * state is answered at the group level and a group's ladders continue
 * while any of its violations stands open.
 */
export async function anyOpenViolationForGroup(
  pool: Pool,
  titleGroupId: string,
): Promise<boolean> {
  const result = await pool.query(
    `select 1 from violations v
       join tracked_titles t on t.id = v.tracked_title_id
      where t.title_group_id = $1 and v.state = 'open'
      limit 1`,
    [titleGroupId],
  );
  return result.rows.length > 0;
}

/**
 * Whether one completed scan produced a violation for its pair — the
 * ladder's start question. The violation's candidate traces to a search
 * result of a query of the scan's plan, and the candidate's title belongs
 * to the group. Called only while no ladder stands for the pair, so any
 * violation the scan produced is the pair's first.
 */
export async function scanProducedViolation(
  pool: Pool,
  input: { scanId: string; titleGroupId: string },
): Promise<boolean> {
  const result = await pool.query(
    `select 1
       from violations v
       join candidates c on c.id = v.candidate_id
       join tracked_titles t on t.id = c.tracked_title_id
      where t.title_group_id = $1
        and exists (
          select 1 from search_results r
            join search_queries q on q.id = r.query_id
            join query_plans p on p.id = q.query_plan_id
           where r.candidate_id = c.id and p.scan_id = $2
        )
      limit 1`,
    [input.titleGroupId, input.scanId],
  );
  return result.rows.length > 0;
}
