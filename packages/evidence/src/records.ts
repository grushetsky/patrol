import type { Pool } from "pg";
import {
  entryAppliesInTitleContext,
  findAllowlistHit,
  hostForUrl,
  normalizeUrlKey,
  registrableDomainFor,
  type AllowlistTitleContext,
} from "@patrol/domain";
import type { EvidenceArtifactKind } from "./store.js";

/**
 * The evidence records (docs/design/evidence-capture.md): the captures
 * queue table, the append-only evidence and artifact rows it produces, and
 * host objections with their clearance. The enqueue port here is the seam
 * slice 5 wires into candidate formation, review opens, and notice
 * approval; its guards run in the design's order — the allowlist before
 * any fetch, an individualized objection before any fetch, the freshness
 * window before another row — so a refused or fresh URL never reaches a
 * queue and never costs a fetch.
 */

/** Why a capture was taken (the contract's CaptureReason). */
export type CaptureReason = "detection" | "review" | "pre_handoff";

/** What a capture observed (the contract's CaptureOutcome). */
export type CaptureOutcome = "captured" | "dead" | "blocked" | "error";

/** One hop of a recorded redirect chain (the contract's RedirectHop). */
export interface RedirectHopRow {
  url: string;
  statusCode: number;
  location?: string;
}

/** The browser and extraction settings one capture ran under (CaptureProfile). */
export interface CaptureProfileJson {
  userAgent: string;
  viewportWidth: number;
  viewportHeight: number;
  locale: string;
  timezone: string;
  javascriptEnabled: boolean;
  blockedResourceKinds: string[];
  navigationPolicy: string;
  extractorVersion: string;
}

/**
 * The freshness windows (implementation rules "Capture points"): review
 * captures a URL whose newest live capture is over 24 hours old,
 * pre_handoff one over 7 days old; detection always captures at candidate
 * formation.
 */
export const FRESHNESS_WINDOWS_MS: Readonly<
  Record<Exclude<CaptureReason, "detection">, number>
> = {
  review: 24 * 60 * 60 * 1000,
  pre_handoff: 7 * 24 * 60 * 60 * 1000,
};

/**
 * The default point key, which makes "one fetch per URL per capture point"
 * hold before slice 5 passes the real event identity: a detection enqueue
 * is its own instant (every formation captures), while review and
 * pre_handoff bucket to their freshness window, so a second action inside
 * the window deduplicates onto the capture that already stands.
 */
export function defaultPointKey(reason: CaptureReason, now: () => Date): string {
  if (reason === "detection") {
    return `detection@${now().toISOString()}`;
  }
  const windowMs = FRESHNESS_WINDOWS_MS[reason];
  return `${reason}@${Math.floor(now().getTime() / windowMs)}`;
}

/** One queued evidentiary fetch (the captures table). */
export interface CaptureRow {
  id: string;
  requestedUrl: string;
  normalizedUrl: string;
  reason: CaptureReason;
  pointKey: string;
  state: "pending" | "running" | "done" | "failed" | "skipped";
  skipReason: "allowlist" | "host_objection" | null;
  attemptCount: number;
  requestedAt: Date;
  lastAttemptAt: Date | null;
  nextAttemptAt: Date | null;
  finishedAt: Date | null;
  evidenceId: string | null;
}

function captureRow(row: Record<string, unknown>): CaptureRow {
  return {
    id: row.id as string,
    requestedUrl: row.requested_url as string,
    normalizedUrl: row.normalized_url as string,
    reason: row.reason as CaptureReason,
    pointKey: row.point_key as string,
    state: row.state as CaptureRow["state"],
    skipReason: (row.skip_reason ?? null) as CaptureRow["skipReason"],
    attemptCount: Number(row.attempt_count),
    requestedAt: row.requested_at as Date,
    lastAttemptAt: (row.last_attempt_at ?? null) as Date | null,
    nextAttemptAt: (row.next_attempt_at ?? null) as Date | null,
    finishedAt: (row.finished_at ?? null) as Date | null,
    evidenceId: (row.evidence_id ?? null) as string | null,
  };
}

/** What enqueueing one capture produced. */
export type EnqueueCaptureResult =
  | { status: "queued"; captureId: string }
  | {
      status: "exists";
      captureId: string;
      state: CaptureRow["state"];
      evidenceId: string | null;
    }
  | { status: "skipped_allowlist"; captureId: string }
  | { status: "refused"; hostObjectionId: string }
  | { status: "fresh"; evidenceId: string };

/**
 * Anything that can run a parameterized query — the pool itself or a
 * transaction client. The enqueue port's callers run inside approval
 * transactions (the capture rows join the notice's commit), so the port
 * takes the narrower executor rather than demanding the pool.
 */
export type SqlExecutor = { query: Pool["query"] };

/** The enqueue port's dependencies; slice 5 injects the queue dispatch. */
export interface EnqueueCaptureDeps {
  pool: SqlExecutor;
  now: () => Date;
  /** Wakes the worker's capture queue for one capture. */
  dispatch: (captureId: string) => Promise<void>;
}

/**
 * The capture enqueue port — the one door captures enter through.
 *
 * Guards, in the design's order:
 *
 * 1. **Allowlist before the fetch.** A URL matching a rights-holder-scoped
 *    entry is never fetched: the capture row records the skip and no
 *    evidence row is ever created. When the caller passes the candidate's
 *    title context (formation does), the title-group and tracked-title
 *    entries scoped to that pair join the check, and a licensed destination
 *    additionally needs the observation's territory — the same rule the
 *    formation check applies.
 * 2. **An individualized objection stops capture.** A host under an active
 *    objection refuses the enqueue — the 409 host_objection semantics the
 *    contract carries — until an operator clears it.
 * 3. **Freshness.** A review or pre_handoff capture whose newest live
 *    capture is inside the window is not taken; the caller pins the
 *    existing capture instead.
 *
 * Then the one-per-point insert: UNIQUE (normalized_url, reason,
 * point_key) makes a duplicate wake-up return the row that already stands.
 *
 * Throws on an unparseable URL; the caller decides how that reaches an
 * operator.
 */
export async function enqueueCapture(
  deps: EnqueueCaptureDeps,
  input: {
    url: string;
    reason: CaptureReason;
    pointKey?: string;
    /** The candidate's title context, when the enqueue is a candidate's. */
    context?: AllowlistTitleContext;
  },
): Promise<EnqueueCaptureResult> {
  const normalizedUrl = normalizeUrlKey(input.url);
  const pointKey = input.pointKey ?? defaultPointKey(input.reason, deps.now);

  const allowlisted = await allowlistHitForUrl(deps.pool, input.url, input.context);
  if (allowlisted !== null) {
    const id = await insertCaptureRow(deps, input, normalizedUrl, pointKey, {
      state: "skipped",
      skipReason: "allowlist",
    });
    if (id === null) {
      return existingCapture(deps.pool, normalizedUrl, input.reason, pointKey);
    }
    return { status: "skipped_allowlist", captureId: id };
  }

  const objection = await activeObjectionForUrl(deps.pool, input.url);
  if (objection !== null) {
    return { status: "refused", hostObjectionId: objection.id };
  }

  if (input.reason !== "detection") {
    const newest = await newestLiveEvidence(deps.pool, normalizedUrl);
    if (newest !== null) {
      const age = deps.now().getTime() - newest.observedAt.getTime();
      if (age < FRESHNESS_WINDOWS_MS[input.reason]) {
        return { status: "fresh", evidenceId: newest.id };
      }
    }
  }

  const id = await insertCaptureRow(deps, input, normalizedUrl, pointKey, {
    state: "pending",
    skipReason: null,
  });
  if (id === null) {
    return existingCapture(deps.pool, normalizedUrl, input.reason, pointKey);
  }
  await deps.dispatch(id);
  return { status: "queued", captureId: id };
}

async function existingCapture(
  pool: SqlExecutor,
  normalizedUrl: string,
  reason: CaptureReason,
  pointKey: string,
): Promise<EnqueueCaptureResult> {
  const result = await pool.query(
    "select * from captures where normalized_url = $1 and reason = $2 and point_key = $3",
    [normalizedUrl, reason, pointKey],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("capture insert reported a conflict no row explains");
  }
  return {
    status: "exists",
    captureId: row.id,
    state: row.state,
    evidenceId: (row.evidence_id ?? null) as string | null,
  };
}

async function insertCaptureRow(
  deps: EnqueueCaptureDeps,
  input: { url: string; reason: CaptureReason },
  normalizedUrl: string,
  pointKey: string,
  outcome: { state: "pending" | "skipped"; skipReason: "allowlist" | null },
): Promise<string | null> {
  const result = await deps.pool.query(
    `insert into captures
       (requested_url, normalized_url, reason, point_key, state, skip_reason, requested_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (normalized_url, reason, point_key) do nothing
     returning id`,
    [
      input.url,
      normalizedUrl,
      input.reason,
      pointKey,
      outcome.state,
      outcome.skipReason,
      deps.now(),
    ],
  );
  return result.rows.length === 0 ? null : (result.rows[0].id as string);
}

/**
 * The allowlist guard's answer for a URL: the winning entry among the
 * applicable rows, or null. Without a title context only the rights-holder
 * entries apply; with one — the candidate's, passed by formation — the
 * title-group and tracked-title entries scoped to that pair join, and a
 * licensed destination additionally needs the context's territory, the
 * same rule the candidate store's formation check applies. TODO(slice-5b):
 * the run-time re-check still passes no context — the capture row carries
 * no title pairing — so a scoped entry landing between the enqueue and the
 * fetch is seen only once 5b carries the pair onto the capture itself.
 */
export async function allowlistHitForUrl(
  pool: SqlExecutor | Pool,
  url: string,
  context?: AllowlistTitleContext,
): Promise<{ kind: string; matchKind: string; value: string } | null> {
  const result = await pool.query<{
    kind: "official_domain" | "licensed_destination" | "neutral_source";
    match_kind: "host" | "url_prefix";
    value: string;
    scope: "rights_holder" | "title_group" | "tracked_title";
    title_group_id: string | null;
    tracked_title_id: string | null;
    territory: string | null;
  }>(
    `select kind, match_kind, value, scope, title_group_id, tracked_title_id, territory
       from allowlist_entries
      where scope = 'rights_holder'
         or (scope = 'title_group' and title_group_id = $1)
         or (scope = 'tracked_title' and tracked_title_id = $2)`,
    [context?.titleGroupId ?? null, context?.trackedTitleId ?? null],
  );
  const applicable = result.rows
    .filter((row) =>
      context === undefined
        ? row.scope === "rights_holder"
        : entryAppliesInTitleContext(
            {
              scope: row.scope,
              titleGroupId: row.title_group_id,
              trackedTitleId: row.tracked_title_id,
              kind: row.kind,
              territory: row.territory,
            },
            context,
          ),
    )
    .map((row) => ({ kind: row.kind, matchKind: row.match_kind, value: row.value }));
  return findAllowlistHit(applicable, url);
}

/** One evidence row (the contract's Evidence). */
export interface EvidenceRow {
  id: string;
  captureId: string;
  requestedUrl: string;
  normalizedUrl: string;
  finalUrl: string | null;
  redirectChain: RedirectHopRow[];
  host: string | null;
  hostSource: "landing_page" | "submitted_url" | null;
  reason: CaptureReason;
  outcome: CaptureOutcome;
  httpStatus: number | null;
  failureReason: string | null;
  attemptNumber: number;
  observedAt: Date;
  profile: CaptureProfileJson;
  purgedAt: Date | null;
  purgeReason: string | null;
}

function evidenceRow(row: Record<string, unknown>): EvidenceRow {
  return {
    id: row.id as string,
    captureId: row.capture_id as string,
    requestedUrl: row.requested_url as string,
    normalizedUrl: row.normalized_url as string,
    finalUrl: (row.final_url ?? null) as string | null,
    redirectChain: (row.redirect_chain ?? []) as RedirectHopRow[],
    host: (row.host ?? null) as string | null,
    hostSource: (row.host_source ?? null) as EvidenceRow["hostSource"],
    reason: row.reason as CaptureReason,
    outcome: row.outcome as CaptureOutcome,
    httpStatus: (row.http_status ?? null) as number | null,
    failureReason: (row.failure_reason ?? null) as string | null,
    attemptNumber: Number(row.attempt_number),
    observedAt: row.observed_at as Date,
    profile: row.capture_profile as CaptureProfileJson,
    purgedAt: (row.purged_at ?? null) as Date | null,
    purgeReason: (row.purge_reason ?? null) as string | null,
  };
}

/** One artifact row (the contract's EvidenceArtifact plus the pinned version). */
export interface EvidenceArtifactRow {
  id: string;
  evidenceId: string;
  kind: EvidenceArtifactKind;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  width: number | null;
  height: number | null;
  truncated: boolean;
  objectVersion: string | null;
}

function artifactRow(row: Record<string, unknown>): EvidenceArtifactRow {
  return {
    id: row.id as string,
    evidenceId: row.evidence_id as string,
    kind: row.kind as EvidenceArtifactKind,
    sha256: row.sha256 as string,
    sizeBytes: Number(row.size_bytes),
    contentType: row.content_type as string,
    width: (row.width ?? null) as number | null,
    height: (row.height ?? null) as number | null,
    truncated: row.truncated === true,
    objectVersion: (row.object_version ?? null) as string | null,
  };
}

/** One artifact the capture produced, ready to record. */
export interface NewEvidenceArtifact {
  kind: EvidenceArtifactKind;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  width?: number;
  height?: number;
  truncated: boolean;
  objectVersion: string | null;
}

/** One attempt's complete record, ready to append. */
export interface NewEvidenceRecord {
  captureId: string;
  requestedUrl: string;
  normalizedUrl: string;
  redirectChain: RedirectHopRow[];
  finalUrl: string | null;
  httpStatus: number | null;
  host: string | null;
  hostSource: "landing_page" | null;
  reason: CaptureReason;
  outcome: CaptureOutcome;
  failureReason: string | null;
  attemptNumber: number;
  observedAt: Date;
  profile: CaptureProfileJson;
  artifacts: NewEvidenceArtifact[];
}

/**
 * Appends one attempt's evidence row with its artifact manifest and moves
 * the capture row to its next state, in one transaction: either the record
 * and the queue state land together or neither does. `terminal` carries
 * captured and dead (never retried) and exhausted blocked/error attempts;
 * otherwise the capture returns to pending with the next attempt's time,
 * which the caller also schedules with the queue.
 */
export async function appendEvidence(
  pool: Pool,
  now: () => Date,
  record: NewEvidenceRecord,
  options: { terminal: boolean; nextAttemptAt?: Date },
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const inserted = await client.query<{ id: string }>(
      `insert into evidence
         (capture_id, requested_url, normalized_url, final_url, redirect_chain, host,
          host_source, reason, outcome, http_status, failure_reason, attempt_number,
          observed_at, capture_profile)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
       returning id`,
      [
        record.captureId,
        record.requestedUrl,
        record.normalizedUrl,
        record.finalUrl,
        JSON.stringify(record.redirectChain),
        record.host,
        record.hostSource,
        record.reason,
        record.outcome,
        record.httpStatus,
        record.failureReason,
        record.attemptNumber,
        record.observedAt,
        JSON.stringify(record.profile),
      ],
    );
    const evidenceId = inserted.rows[0].id;
    for (const artifact of record.artifacts) {
      await client.query(
        `insert into evidence_artifacts
           (evidence_id, kind, sha256, size_bytes, content_type, width, height, truncated, object_version)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          evidenceId,
          artifact.kind,
          artifact.sha256,
          artifact.sizeBytes,
          artifact.contentType,
          artifact.width ?? null,
          artifact.height ?? null,
          artifact.truncated,
          artifact.objectVersion,
        ],
      );
    }
    await client.query(
      `update captures
         set evidence_id = $2,
             state = $3,
             next_attempt_at = $4,
             finished_at = $5
       where id = $1`,
      [
        record.captureId,
        evidenceId,
        options.terminal ? "done" : "pending",
        options.terminal ? null : (options.nextAttemptAt ?? null),
        options.terminal ? now() : null,
      ],
    );
    await client.query("commit");
    return evidenceId;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Claims one capture for an attempt: pending → running, attempt count up.
 * Returns the new attempt number, or null when the capture was not pending
 * (already claimed, done, or skipped) — the caller leaves those alone.
 */
export async function beginCaptureAttempt(
  pool: Pool,
  captureId: string,
  now: () => Date,
): Promise<number | null> {
  const result = await pool.query<{ attempt_count: number }>(
    `update captures
       set state = 'running', attempt_count = attempt_count + 1,
           last_attempt_at = $2, next_attempt_at = null
     where id = $1 and state = 'pending'
     returning attempt_count`,
    [captureId, now()],
  );
  return result.rows.length === 0 ? null : Number(result.rows[0].attempt_count);
}

/** Marks a capture finished without an attempt record — the guards' skips. */
export async function markCaptureSkippedAtRun(
  pool: Pool,
  captureId: string,
  skipReason: "allowlist" | "host_objection",
  now: () => Date,
): Promise<void> {
  await pool.query(
    `update captures
       set state = 'done', skip_reason = $2, finished_at = $3
     where id = $1 and state in ('pending', 'running')`,
    [captureId, skipReason, now()],
  );
}

/** Marks a capture failed by capture machinery (storage or database), for ops. */
export async function markCaptureFailed(
  pool: Pool,
  captureId: string,
  now: () => Date,
): Promise<void> {
  await pool.query(
    `update captures set state = 'failed', finished_at = $2 where id = $1`,
    [captureId, now()],
  );
}

/** Reads one capture by id; null when absent. */
export async function readCapture(pool: Pool, captureId: string): Promise<CaptureRow | null> {
  const result = await pool.query("select * from captures where id = $1", [captureId]);
  return result.rows.length === 0 ? null : captureRow(result.rows[0]);
}

/**
 * When a running capture is stale: the runner's budgets end inside a
 * minute and the capture queue expires an unfinished job in five, so a
 * running attempt older than ten minutes belongs to a worker that no
 * longer exists. The sweeper reaps those rows rather than trusting the
 * process that lost them.
 */
export const STALE_RUNNING_CAPTURE_MS = 10 * 60_000;

/**
 * The pending captures whose next attempt has come due: every retry whose
 * scheduled wake-up must exist, whether the runner's own schedule sent it
 * or the sweeper is replacing one that was lost. A pending row waiting for
 * its first attempt carries no next-attempt time and stays out — its
 * enqueue dispatched it.
 */
export async function duePendingCaptureIds(
  pool: Pool,
  now: () => Date,
): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `select id from captures
      where state = 'pending' and next_attempt_at is not null and next_attempt_at <= $1
      order by next_attempt_at, id`,
    [now()],
  );
  return result.rows.map((row) => row.id);
}

/**
 * Reaps the captures a dead worker left running — older than the stale
 * threshold — back to pending with the next attempt due immediately. The
 * attempt a reaped row spent stands (the count is not reset): the retry
 * matrix budgets attempts, not crashes. Returns the reaped ids.
 */
export async function reapStaleRunningCaptures(
  pool: Pool,
  now: () => Date,
  staleMs: number = STALE_RUNNING_CAPTURE_MS,
): Promise<string[]> {
  const cutoff = new Date(now().getTime() - staleMs);
  const result = await pool.query<{ id: string }>(
    `update captures
       set state = 'pending', next_attempt_at = $1
     where state = 'running' and last_attempt_at is not null and last_attempt_at <= $2
     returning id`,
    [now(), cutoff],
  );
  return result.rows.map((row) => row.id);
}

/** Reads one evidence row with its artifacts; null when absent. */
export async function readEvidence(
  pool: Pool,
  evidenceId: string,
): Promise<{ evidence: EvidenceRow; artifacts: EvidenceArtifactRow[] } | null> {
  const result = await pool.query("select * from evidence where id = $1", [evidenceId]);
  if (result.rows.length === 0) {
    return null;
  }
  const artifacts = await pool.query(
    "select * from evidence_artifacts where evidence_id = $1 order by kind",
    [evidenceId],
  );
  return {
    evidence: evidenceRow(result.rows[0]),
    artifacts: artifacts.rows.map(artifactRow),
  };
}

/** The newest live (captured) evidence for a normalized URL; null when none. */
export async function newestLiveEvidence(
  pool: SqlExecutor,
  normalizedUrl: string,
): Promise<EvidenceRow | null> {
  const result = await pool.query(
    `select * from evidence
      where normalized_url = $1 and outcome = 'captured'
      order by observed_at desc
      limit 1`,
    [normalizedUrl],
  );
  return result.rows.length === 0 ? null : evidenceRow(result.rows[0]);
}

/** One recorded host objection (the contract's HostObjection). */
export interface HostObjectionRow {
  id: string;
  host: string;
  registrableDomain: string;
  source: "host_contact" | "operator";
  reason: string;
  recordedAt: Date;
  recordedBy: string | null;
  affectedCandidateCount: number;
  clearedAt: Date | null;
  clearedBy: string | null;
  clearanceReason: string | null;
}

function objectionRow(row: Record<string, unknown>): HostObjectionRow {
  return {
    id: row.id as string,
    host: row.host as string,
    registrableDomain: row.registrable_domain as string,
    source: row.source as HostObjectionRow["source"],
    reason: row.reason as string,
    recordedAt: row.recorded_at as Date,
    recordedBy: (row.recorded_by ?? null) as string | null,
    affectedCandidateCount: Number(row.affected_candidate_count),
    clearedAt: (row.cleared_at ?? null) as Date | null,
    clearedBy: (row.cleared_by ?? null) as string | null,
    clearanceReason: (row.clearance_reason ?? null) as string | null,
  };
}

/**
 * The active objection covering a URL, or null. An objection suspends the
 * host it names and every host under it: a cease-and-desist naming a
 * platform covers the platform's subdomains, and continued access after a
 * personal objection is exactly the conduct the design refuses. It does
 * not reach sideways — an objection on one subdomain of a domain does not
 * suspend its siblings, because the host said what it said and no more.
 */
export async function activeObjectionForUrl(
  pool: SqlExecutor | Pool,
  url: string,
): Promise<HostObjectionRow | null> {
  const host = hostForUrl(url);
  const result = await pool.query(
    `select * from host_objections
      where cleared_at is null and ($1 = host or right($1, length(host) + 1) = '.' || host)
      order by recorded_at desc
      limit 1`,
    [host],
  );
  return result.rows.length === 0 ? null : objectionRow(result.rows[0]);
}

/**
 * Records an objection — the worker's reading of a host's 451 or its page
 * naming Patrol in a cease-and-desist, or (slice 5+ via the operator
 * surface) a letter an operator enters. Idempotent per host while active:
 * a second signal returns the standing objection rather than a second row.
 */
export async function recordHostObjection(
  pool: Pool,
  now: () => Date,
  input: {
    host: string;
    source: "host_contact" | "operator";
    reason: string;
    affectedCandidateCount: number;
    recordedBy?: string;
  },
): Promise<HostObjectionRow> {
  await pool.query(
    `insert into host_objections
       (host, registrable_domain, source, reason, recorded_at, recorded_by, affected_candidate_count)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (host) where cleared_at is null do nothing`,
    [
      input.host,
      registrableDomainFor(input.host),
      input.source,
      input.reason,
      now(),
      input.recordedBy ?? null,
      input.affectedCandidateCount,
    ],
  );
  const result = await pool.query(
    "select * from host_objections where host = $1 and cleared_at is null",
    [input.host],
  );
  return objectionRow(result.rows[0]);
}

/** One page of objections, newest first, filtered by host or active state. */
export async function listHostObjections(
  pool: Pool,
  filter: { host?: string; active?: boolean },
  paging: { limit: number; offset: number },
): Promise<{ rows: HostObjectionRow[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.host !== undefined) {
    params.push(filter.host);
    conditions.push(`host = $${params.length}`);
  }
  if (filter.active !== undefined) {
    params.push(filter.active);
    conditions.push(`(cleared_at is null) = $${params.length}`);
  }
  const where = conditions.length === 0 ? "" : `where ${conditions.join(" and ")}`;
  const rows = await pool.query(
    `select * from host_objections ${where}
      order by recorded_at desc, id
      limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, paging.limit, paging.offset],
  );
  const total = await pool.query<{ count: string }>(
    `select count(*) as count from host_objections ${where}`,
    params,
  );
  return {
    rows: rows.rows.map(objectionRow),
    total: Number(total.rows[0].count),
  };
}

/** What clearing one objection produced. */
export type ClearObjectionResult =
  | { status: "cleared"; row: HostObjectionRow }
  | { status: "already_cleared"; row: HostObjectionRow }
  | { status: "absent" };

/**
 * An operator's explicit decision to reopen a host to capture. The
 * objection is never deleted: the clearance trio (who, when, why) is
 * recorded on the row the guards' update trigger permits, and the row
 * stays in the history the list serves.
 */
export async function clearHostObjection(
  pool: Pool,
  now: () => Date,
  input: { hostObjectionId: string; operatorId: string; reason: string },
): Promise<ClearObjectionResult> {
  const result = await pool.query(
    `update host_objections
       set cleared_at = $2, cleared_by = $3, clearance_reason = $4
     where id = $1 and cleared_at is null
     returning *`,
    [input.hostObjectionId, now(), input.operatorId, input.reason],
  );
  if (result.rows.length === 0) {
    const existing = await pool.query(
      "select * from host_objections where id = $1",
      [input.hostObjectionId],
    );
    if (existing.rows.length === 0) {
      return { status: "absent" };
    }
    return { status: "already_cleared", row: objectionRow(existing.rows[0]) };
  }
  return { status: "cleared", row: objectionRow(result.rows[0]) };
}

/**
 * How many distinct URLs Patrol has surfaced on a host — the objection's
 * affected-candidate count. Candidates arrive with slice 5; until then the
 * search results Patrol already stores are the surfaced set, which is the
 * same population the review queue will form candidates from.
 */
export async function affectedSurfaceCount(pool: Pool, host: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "select count(distinct normalized_url) as count from search_results where host = $1",
    [host],
  );
  return Number(result.rows[0].count);
}
