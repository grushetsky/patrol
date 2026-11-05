import type { Pool } from "pg";
import type { EvidenceArtifactKind, EvidenceStore, PackArtifactKind } from "./store.js";
import { RAW_SERP_PREFIX } from "./store.js";
import { ACTIVE_HOLD_COVERS_EVIDENCE } from "./holds.js";

/**
 * The retention purge (docs/design/evidence-capture.md "Retention"; ADR
 * 0017; implementation rules "Evidence capture and retention"). One pass of
 * the daily `retention.purge` job:
 *
 * 1. **Select** the evidence rows past their window. A row is due only when
 *    NOTHING still keeps it: an open violation's citation, a live notice's
 *    pinned citation (a notice that is drafted, approved, or awaiting
 *    acknowledgement), or an ACTIVE legal hold covering it directly,
 *    through a citing violation, or through a citing notice. The two
 *    windows then apply: closed citations five years after the later of
 *    the violation's closure and the last submission citing the capture;
 *    never-cited captures twelve months after the last review decision, or
 *    after capture where no decision was recorded.
 * 2. **Mark** each due row's purge marker, one committed transaction per
 *    row, BEFORE any byte is touched, and only after the marking UPDATE
 *    itself re-checked the hold coverage under its row lock — a hold that
 *    committed after the selection still wins. An interrupted run leaves
 *    orphaned bytes — never a dangling citation, which is the only one of
 *    the two failure modes that destroys defence material.
 * 3. **Delete bytes**: for every purged row whose cleanup has not
 *    completed, delete the object versions of the artifact hashes NO
 *    unpurged artifact row still references (one blob serves many
 *    records), then record bytes_purged_at. A crash between the delete and
 *    the completion marker costs one idempotent re-delete on the next run.
 * 4. **Raw SERP payloads**: the objects under `serp/` older than ninety
 *    days. The RESULT rows stay in PostgreSQL permanently as provenance;
 *    only the owned raw payload bytes carry the window. The v1 adapters
 *    store no such objects (raw_payload_ref names the provider's own
 *    retained response), so the step lists an empty prefix and deletes
 *    nothing — the path exists and is tested against the store port, so
 *    the day an adapter keeps its payload the window is already enforced.
 */

/**
 * The two evidence windows are measured in calendar intervals PostgreSQL
 * itself counts — `make_interval(years => 5)` and `make_interval(months => 12)`
 * in selectDueEvidence's SQL below — so their single home is that query's
 * literals, not constants here that would drift from it. Only the raw SERP
 * window is a clock offset the runner computes a cutoff with.
 *
 * Ninety days for the raw SERP payloads Patrol owns.
 */
export const RAW_SERP_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** The purge reasons the evidence row's marker carries. */
export type PurgeReason = "closed_citations_window" | "never_cited_window";

/** One evidence row the analysis found past its window. */
export interface DueEvidence {
  id: string;
  reason: PurgeReason;
}

/** A hash whose object version the cleanup owes a delete. */
export interface OrphanArtifactVersion {
  evidenceId: string;
  kind: string;
  sha256: string;
  objectVersion: string | null;
}

/**
 * A citation from an OPEN violation: the strongest keeper, it suspends
 * every window. `removed` and `closed` are the closed citations the
 * five-year window measures from.
 */
const OPEN_VIOLATION_CITES = `exists (
  select 1 from violation_evidence ve
    join violations v on v.id = ve.violation_id
   where ve.evidence_id = e.id and v.state = 'open'
)`;

/**
 * A pinned citation from a LIVE notice: a notice that is drafted, or
 * approved and not yet acknowledged — "drafted, approved, or awaiting
 * acknowledgement" (the submission states that end the wait are
 * acknowledged and rejected; a cancelled submission belongs to a withdrawn
 * or superseded notice, which is not live either). A notice whose approval
 * has not yet produced its submission is live: nothing about it is done.
 */
const LIVE_NOTICE_CITES = `exists (
  select 1 from notice_citations nc
    join notices n on n.id = nc.notice_id
    left join submissions s on s.notice_id = n.id
   where nc.evidence @> jsonb_build_array(jsonb_build_object('evidenceId', e.id))
     and (
       n.state = 'draft'
       or (n.state = 'approved'
           and (s.id is null or s.state in ('pending', 'delivered')))
     )
)`;

/** Any citation from a violation, open or closed. */
const ANY_VIOLATION_CITES = `exists (
  select 1 from violation_evidence ve where ve.evidence_id = e.id
)`;

/** The latest closure among the citing violations (null while none closed). */
const LATEST_CLOSURE = `(
  select max(v.closed_at) from violation_evidence ve
    join violations v on v.id = ve.violation_id
   where ve.evidence_id = e.id
)`;

/**
 * The last citing submission's own last moment: the greatest of the
 * timestamps its lifecycle wrote. "Five years after … the last submission
 * citing it" counts the submission's final act, so a submission
 * acknowledged after the violation closed keeps the window running from
 * the acknowledgement.
 */
const LAST_CITING_SUBMISSION = `(
  select max(greatest(
           s.created_at,
           coalesce(s.delivered_at, s.created_at),
           coalesce(s.acknowledged_at, s.created_at),
           coalesce(s.failed_at, s.created_at),
           coalesce(s.cancelled_at, s.created_at)
         ))
    from submissions s
    join notice_citations nc on nc.notice_id = s.notice_id
   where nc.evidence @> jsonb_build_array(jsonb_build_object('evidenceId', e.id))
)`;

/** The last review decision that pinned the capture (null when none did). */
const LAST_REVIEW_DECISION = `(
  select max(rd.decided_at) from review_decisions rd
   where rd.evidence_ids @> array[e.id]
)`;

/**
 * The evidence rows past their window. Every keeper is a NOT in the WHERE;
 * the two windows are the two deadline comparisons. The clock is the
 * caller's, so tests freeze it.
 */
export async function selectDueEvidence(
  pool: Pool,
  now: () => Date,
): Promise<DueEvidence[]> {
  const result = await pool.query<{ id: string; reason: PurgeReason }>(
    `select e.id,
            case when ${ANY_VIOLATION_CITES}
                 then 'closed_citations_window' else 'never_cited_window'
            end as reason
       from evidence e
      where e.purged_at is null
        and not ${OPEN_VIOLATION_CITES}
        and not ${LIVE_NOTICE_CITES}
        and not ${ACTIVE_HOLD_COVERS_EVIDENCE}
        and (
          (${ANY_VIOLATION_CITES} and $1::timestamptz >=
            (greatest(${LATEST_CLOSURE}, coalesce(${LAST_CITING_SUBMISSION}, ${LATEST_CLOSURE}))
             + make_interval(years => 5)))
          or
          (not ${ANY_VIOLATION_CITES} and $1::timestamptz >=
            (coalesce(${LAST_REVIEW_DECISION}, e.observed_at) + make_interval(months => 12)))
        )`,
    [now()],
  );
  return result.rows.map((row) => ({ id: row.id, reason: row.reason }));
}

/**
 * Sets one due row's purge marker. One row, one statement, one committed
 * transaction — the marker is durable BEFORE the run touches bytes, and a
 * row another concurrent run already marked is left alone. The statement
 * re-checks the hold coverage under its own row lock: a hold committed
 * between the selection and this mark outranks the window (ADR 0017), so
 * the UPDATE answers 0 rows and the row stays with its bytes.
 */
export async function markEvidencePurged(
  pool: Pool,
  now: () => Date,
  evidenceId: string,
  reason: PurgeReason,
): Promise<boolean> {
  const result = await pool.query(
    `update evidence e
        set purged_at = $2, purge_reason = $3
      where e.id = $1 and e.purged_at is null
        and not ${ACTIVE_HOLD_COVERS_EVIDENCE}`,
    [evidenceId, now(), reason],
  );
  return result.rowCount === 1;
}

/**
 * The orphan object versions the cleanup owes: every artifact of a purged
 * row whose byte cleanup has not completed, whose hash no unpurged
 * artifact row still references. Content addressing makes one blob serve
 * many records, so a blob is deleted only when the last unpurged referent
 * is gone. This query is also the recovery path: it re-finds the hashes an
 * interrupted run left behind, which is what makes the re-run complete.
 */
export async function selectOrphanArtifactVersions(
  pool: Pool,
): Promise<OrphanArtifactVersion[]> {
  const result = await pool.query<{
    evidence_id: string;
    kind: string;
    sha256: string;
    object_version: string | null;
  }>(
    `select distinct ea.evidence_id, ea.kind, ea.sha256, ea.object_version
       from evidence_artifacts ea
       join evidence e on e.id = ea.evidence_id
      where e.purged_at is not null
        and e.bytes_purged_at is null
        and not exists (
          select 1 from evidence_artifacts ea2
            join evidence e2 on e2.id = ea2.evidence_id
           where ea2.sha256 = ea.sha256 and e2.purged_at is null
        )
      order by ea.evidence_id, ea.kind`,
  );
  return result.rows.map((row) => ({
    evidenceId: row.evidence_id,
    kind: row.kind,
    sha256: row.sha256,
    objectVersion: row.object_version,
  }));
}

/** Records that a purged row's owed deletes completed. */
export async function markBytesPurged(
  pool: Pool,
  now: () => Date,
  evidenceId: string,
): Promise<void> {
  await pool.query(
    `update evidence set bytes_purged_at = $2
      where id = $1 and purged_at is not null and bytes_purged_at is null`,
    [evidenceId, now()],
  );
}

/** What one retention pass did. */
export interface RetentionPurgeSummary {
  /** Rows the analysis found due. */
  due: number;
  /** Rows this run marked (already-marked rows are not re-counted). */
  marked: number;
  /** Object versions this run deleted. */
  versionsDeleted: number;
  /** Purged rows whose cleanup completed. */
  bytesCompleted: number;
  /** Raw SERP payload keys deleted. */
  rawSerpKeysDeleted: number;
}

/** The store surface the retention job needs: the purge path alone. */
export type RetentionStore = Pick<
  EvidenceStore,
  "deleteArtifactVersion" | "purgeRawSerpPayloadsOlderThan"
>;

/**
 * One full retention pass, in the design's order: select, mark, delete
 * bytes, then the raw payload window. A store failure during the byte
 * phase leaves the markers standing and the run reports the error after
 * completing what it could — the next run's orphan query re-finds the
 * leftovers, so the failure mode is a slower cleanup, never a wrong one.
 */
export async function runRetentionPurge(
  deps: {
    pool: Pool;
    now: () => Date;
    store: RetentionStore;
    log?: (message: string, extra?: Record<string, unknown>) => void;
  },
): Promise<RetentionPurgeSummary> {
  const { pool, now, store, log } = deps;
  const summary: RetentionPurgeSummary = {
    due: 0,
    marked: 0,
    versionsDeleted: 0,
    bytesCompleted: 0,
    rawSerpKeysDeleted: 0,
  };

  const due = await selectDueEvidence(pool, now);
  summary.due = due.length;
  for (const row of due) {
    if (await markEvidencePurged(pool, now, row.id, row.reason)) {
      summary.marked += 1;
    }
  }
  if (summary.marked > 0) {
    log?.("retention.purge marked evidence past its window", {
      marked: summary.marked,
      due: summary.due,
    });
  }

  // Byte cleanup: the deletes a row owes, then the row's completion
  // marker. A delete that throws leaves the marker unset and the run
  // carries on with the next row — the orphan query on the next run is
  // the retry. One hash shared by several purged rows is deleted ONCE:
  // the first success retires the key for every row that references it.
  const orphans = await selectOrphanArtifactVersions(pool);
  const completed = new Set<string>();
  const failed = new Set<string>();
  const retiredKeys = new Set<string>();
  for (const orphan of orphans) {
    const key = `${orphan.kind}:${orphan.sha256}:${orphan.objectVersion ?? ""}`;
    if (retiredKeys.has(key)) {
      completed.add(orphan.evidenceId);
      continue;
    }
    try {
      await store.deleteArtifactVersion({
        kind: orphan.kind as EvidenceArtifactKind | PackArtifactKind,
        sha256: orphan.sha256,
        objectVersion: orphan.objectVersion,
      });
      retiredKeys.add(key);
      summary.versionsDeleted += 1;
      completed.add(orphan.evidenceId);
    } catch (error) {
      failed.add(orphan.evidenceId);
      log?.("retention.purge could not delete an object version; the next run retries", {
        evidenceId: orphan.evidenceId,
        sha256: orphan.sha256,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const evidenceId of completed) {
    if (failed.has(evidenceId)) {
      // One row with one failed delete keeps its completion marker unset:
      // the marker means every owed delete for the row succeeded.
      continue;
    }
    await markBytesPurged(pool, now, evidenceId);
    summary.bytesCompleted += 1;
  }
  if (summary.versionsDeleted > 0 || failed.size > 0) {
    log?.("retention.purge deleted object versions", {
      versionsDeleted: summary.versionsDeleted,
      rowsCompleted: summary.bytesCompleted,
      rowsWithFailures: failed.size,
    });
  }

  // The raw SERP window. See the module comment: today's adapters store
  // no raw payload objects, so this lists an empty prefix; the window is
  // enforced against the prefix the storage layout fixes regardless.
  const cutoff = new Date(now().getTime() - RAW_SERP_RETENTION_MS);
  const deleted = await store.purgeRawSerpPayloadsOlderThan(cutoff);
  summary.rawSerpKeysDeleted = deleted.length;
  if (deleted.length > 0) {
    log?.("retention.purge deleted raw SERP payload objects", {
      keys: deleted.length,
      prefix: RAW_SERP_PREFIX,
    });
  }

  return summary;
}
