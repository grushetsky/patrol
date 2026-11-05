import type { Pool, PoolClient } from "pg";
import { registrableDomainFor } from "@patrol/domain";
import {
  CANDIDATE_COLUMNS,
  citeViolationEvidence,
  insertViolation,
  latestTerminalViolationForPair,
  mapCandidate,
  materialSnapshotFrom,
  pinnedVersionsForEvidence,
  type CandidateRow,
  type NewViolation,
  type RawCandidateRow,
  type ViolationRow,
} from "@patrol/scans";
import { ApiError } from "../../errors.js";
import { candidateJson } from "../candidates.js";
import { assertConfirmable } from "./suppression.js";
import { violationJson } from "./serialize.js";

/**
 * The five dispositions (docs/design/matching-and-classification-rules.md
 * "Review decisions"; contract Patrol.Http.ReviewDecisionRequest /
 * ReviewDecisionResult). One decision is one transaction: the immutable
 * decision row, the candidate's transition, and — for a confirm — the
 * violation and its pinned citations, all together or not at all. No score
 * confirms a violation; the operator's action does, and the guards in front
 * of it hold the invariants: an allowlist hit refuses confirmation, every
 * violation cites at least one captured evidence row of its URL, and a
 * wrong-work decision names the title the page copies.
 */

/** The contract's ReviewDecisionRequest, validated by the emitted schema. */
export interface ReviewDecisionInput {
  action: "violation" | "not_a_violation" | "wrong_work" | "authorized_here" | "page_dead";
  note?: string;
  evidenceIds: string[];
  rematchedTrackedTitleId?: string;
  allowlistEntry?: ProposedAllowlistEntryInput;
}

/** The contract's ProposedAllowlistEntry. */
export interface ProposedAllowlistEntryInput {
  kind: "official_domain" | "licensed_destination" | "neutral_source";
  matchKind: "host" | "url_prefix";
  value: string;
  scope: "rights_holder" | "title_group" | "tracked_title";
  titleGroupId?: string;
  trackedTitleId?: string;
  territory?: string;
}

/** What recording one decision produced, serialized per the contract. */
export interface ReviewDecisionOutcome {
  decision: Record<string, unknown>;
  candidate: Record<string, unknown>;
  /** Present only when the action confirms a violation. */
  violation?: Record<string, unknown>;
  /** Present only when the action is authorized here. */
  allowlistEntry?: Record<string, unknown>;
}

/** The enqueue port a decision wakes when it wants a fresh review capture. */
export type EnqueueReviewCapture = (input: {
  url: string;
  reason: "review";
}) => Promise<unknown>;

/**
 * Records one disposition of one candidate. The guards, in order:
 *
 * 1. Only a pending candidate can receive a decision (`state_conflict`).
 * 2. A confirm is refused while an allowlist entry hits the URL
 *    (`allowlist_hit`), whatever the score.
 * 3. A dismissal records a note (`note_required`).
 * 4. The cited evidence must be captures of the pair's URL — every id
 *    resolves there, and a confirm needs at least one captured outcome
 *    (`evidence_required`).
 * 5. A wrong-work decision names the correct, unmerged title
 *    (`wrong_work_requires_title`).
 * 6. An authorized-here decision carries its proposed entry, which lands
 *    with the decision as its origin — nothing is added silently.
 * 7. A confirm inserts the violation — host from the landing page the
 *    newest captured evidence recorded, falling back to the submitted host
 *    with `hostSource` saying so; predecessor linked when the pair has a
 *    terminal history — and cites that evidence with its artifact versions
 *    pinned at citation.
 *
 * After the commit, a review capture is queued for the URL through the
 * injected port (the freshness window inside it decides whether a fetch
 * happens), so the record keeps evidence of what the page served at the
 * moment of the decision. A refused enqueue never unravels the decision.
 */
export async function recordReviewDecision(
  pool: Pool,
  now: () => Date,
  operatorId: string,
  candidateId: string,
  input: ReviewDecisionInput,
  enqueueCapture?: EnqueueReviewCapture,
): Promise<ReviewDecisionOutcome> {
  const decidedAt = now();
  const client = await pool.connect();
  let outcome: ReviewDecisionOutcome;
  try {
    await client.query("begin");
    const recorded = await decideInTransaction(
      client,
      decidedAt,
      operatorId,
      candidateId,
      input,
    );
    await client.query("commit");
    outcome = {
      decision: {
        id: recorded.decisionId,
        candidateId,
        action: input.action,
        operatorId,
        decidedAt: decidedAt.toISOString(),
        ...(input.note === undefined ? {} : { note: input.note }),
        evidenceIds: input.evidenceIds,
        ...(recorded.violation === null ? {} : { violationId: recorded.violation.id }),
        ...(recorded.rematchedTrackedTitleId === null
          ? {}
          : { rematchedTrackedTitleId: recorded.rematchedTrackedTitleId }),
        ...(recorded.proposedAllowlistEntryId === null
          ? {}
          : { proposedAllowlistEntryId: recorded.proposedAllowlistEntryId }),
      },
      candidate: candidateJson(recorded.candidate, recorded.priorDecisionIds),
      // Present only when the decision created one; a null key would break
      // the contract's optional-object shapes.
      ...(recorded.violation === null ? {} : { violation: violationJson(recorded.violation) }),
      ...(recorded.allowlistEntryJson === null
        ? {}
        : { allowlistEntry: recorded.allowlistEntryJson }),
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    client.release();
    throw error;
  }
  client.release();

  if (enqueueCapture !== undefined) {
    try {
      await enqueueCapture({ url: outcome.candidate.url as string, reason: "review" });
    } catch {
      // The next capture point catches up; the decision stands recorded.
    }
  }
  return outcome;
}

/** What the transaction produced before serialization. */
interface RecordedDecision {
  decisionId: string;
  candidate: CandidateRow;
  priorDecisionIds: string[];
  violation: ViolationRow | null;
  rematchedTrackedTitleId: string | null;
  proposedAllowlistEntryId: string | null;
  allowlistEntryJson: Record<string, unknown> | null;
}

async function decideInTransaction(
  client: PoolClient,
  decidedAt: Date,
  operatorId: string,
  candidateId: string,
  input: ReviewDecisionInput,
): Promise<RecordedDecision> {
  const locked = await client.query<RawCandidateRow>(
    `select ${CANDIDATE_COLUMNS} from candidates where id = $1 for update`,
    [candidateId],
  );
  if (locked.rows.length === 0) {
    throw new ApiError(404, "not_found");
  }
  const candidate = mapCandidate(locked.rows[0]);
  if (candidate.state !== "pending") {
    throw new ApiError(409, "state_conflict", { currentState: candidate.state });
  }
  if (input.action === "violation") {
    // An allowlist hit prevents confirmation regardless of score and routes
    // the row to allowlist review (suppression.ts owns the guard's doc).
    assertConfirmable(candidate);
  }
  if (input.action !== "violation" && (input.note ?? "").trim() === "") {
    throw new ApiError(422, "note_required", {
      fieldErrors: [{ path: "/note", message: "a dismissal records the operator's note" }],
    });
  }

  const cited = await validateCitedEvidence(client, candidate, input);
  if (cited.captured.length === 0 && input.action === "violation") {
    throw new ApiError(422, "evidence_required", {
      fieldErrors: [
        {
          path: "/evidenceIds",
          message: "a confirm cites at least one captured evidence of this URL",
        },
      ],
    });
  }

  let rematchedTrackedTitleId: string | null = null;
  if (input.action === "wrong_work") {
    const rematched = input.rematchedTrackedTitleId;
    if (rematched === undefined || rematched === "") {
      throw new ApiError(422, "wrong_work_requires_title", {
        fieldErrors: [{ path: "/rematchedTrackedTitleId", message: "required for wrong work" }],
      });
    }
    const title = await client.query(
      "select id from tracked_titles where id = $1 and merged_into_title_id is null",
      [rematched],
    );
    if (title.rows.length === 0) {
      throw new ApiError(422, "unprocessable", {
        fieldErrors: [{ path: "/rematchedTrackedTitleId", message: "no such tracked title" }],
      });
    }
    rematchedTrackedTitleId = rematched;
  }

  // One decision id, generated inside the transaction: the authorized-here
  // entry names it as its origin, and the violation names it in turn. A
  // confirm also pre-generates the violation's id, because the decision
  // row and the violation row foreign-key each other — the decision lands
  // first carrying the id, the violation follows inside the same
  // transaction.
  const decisionId = (
    await client.query<{ id: string }>("select uuidv7()::text as id")
  ).rows[0].id;
  const violationId =
    input.action === "violation"
      ? (await client.query<{ id: string }>("select uuidv7()::text as id")).rows[0].id
      : null;

  let allowlistEntryJson: Record<string, unknown> | null = null;
  let proposedAllowlistEntryId: string | null = null;
  if (input.action === "authorized_here") {
    if (input.allowlistEntry === undefined) {
      throw new ApiError(422, "unprocessable", {
        fieldErrors: [{ path: "/allowlistEntry", message: "required for authorized here" }],
      });
    }
    const inserted = await insertProposedEntry(
      client,
      decidedAt,
      operatorId,
      decisionId,
      input.allowlistEntry,
    );
    proposedAllowlistEntryId = inserted.id;
    allowlistEntryJson = inserted.json;
  }

  await client.query(
    `insert into review_decisions
       (id, candidate_id, operator_id, action, decided_at, evidence_ids,
        rematched_tracked_title_id, proposed_allowlist_entry_id, violation_id, note)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      decisionId,
      candidate.id,
      operatorId,
      input.action,
      decidedAt,
      input.evidenceIds,
      rematchedTrackedTitleId,
      proposedAllowlistEntryId,
      violationId,
      input.note ?? null,
    ],
  );

  let violation: ViolationRow | null = null;
  if (input.action === "violation") {
    violation = await createViolation(
      client,
      decidedAt,
      operatorId,
      decisionId,
      violationId!,
      candidate,
    );
  }

  const updated = await transitionCandidate(
    client,
    decidedAt,
    operatorId,
    candidate,
    input,
    decisionId,
    violation?.id ?? null,
    proposedAllowlistEntryId,
  );
  // The pair's decision ids after this one lands, newest first — the
  // candidate record the result returns carries them. The history is the
  // pair's, across its reappearance surfaces, not one candidate row's.
  const history = await client.query<{ id: string }>(
    `select d.id
       from review_decisions d
       join candidates pc on pc.id = d.candidate_id
      where pc.normalized_url = $1 and pc.tracked_title_id = $2
      order by d.decided_at desc, d.id`,
    [candidate.normalizedUrl, candidate.trackedTitleId],
  );

  return {
    decisionId,
    candidate: updated,
    priorDecisionIds: history.rows.map((row) => row.id),
    violation,
    rematchedTrackedTitleId,
    proposedAllowlistEntryId,
    allowlistEntryJson,
  };
}

/** The cited evidence of the pair's URL, split by outcome. */
interface CitedEvidence {
  found: Array<{ id: string; outcome: string; normalized_url: string }>;
  captured: Array<{ id: string; outcome: string; normalized_url: string }>;
}

async function validateCitedEvidence(
  client: PoolClient,
  candidate: CandidateRow,
  input: ReviewDecisionInput,
): Promise<CitedEvidence> {
  const evidenceError = new ApiError(422, "evidence_required", {
    fieldErrors: [
      {
        path: "/evidenceIds",
        message: "cite at least one capture of this candidate's URL",
      },
    ],
  });
  if (input.evidenceIds.length === 0) {
    throw evidenceError;
  }
  const rows = await client.query<{ id: string; outcome: string; normalized_url: string }>(
    `select id, outcome, normalized_url from evidence where id = any($1::uuid[])`,
    [input.evidenceIds],
  );
  const ofThisUrl = rows.rows.filter((row) => row.normalized_url === candidate.normalizedUrl);
  if (ofThisUrl.length !== input.evidenceIds.length) {
    // An id that is no capture of this URL is not evidence of this pair.
    throw evidenceError;
  }
  return {
    found: ofThisUrl,
    captured: ofThisUrl.filter((row) => row.outcome === "captured"),
  };
}

/**
 * The allowlist entry an authorized-here decision proposes and records.
 *
 * The doc's learning wording says learning proposes and an operator
 * confirms ("Learning proposes entries and an operator confirms them …
 * Nothing is added silently"; docs/design/matching-and-classification-rules.md
 * "Allowlist"). What lands here is an immediate confirm by the deciding
 * operator, and that is a deliberate reading, not an oversight: the entry
 * takes effect the moment the pair is dismissed as authorized, and the
 * schema leaves no room for a pending state — `confirmed_by` and
 * `confirmed_at` are NOT NULL (the table's CHECKs bind them to the
 * origin), so a "proposed but unconfirmed" row cannot exist. The deciding
 * operator is the confirmer of record, the decision row is the proposal's
 * origin, and the tension with the two-step wording is resolved in favour
 * of the one-step the schema and the dismissal's effect require.
 *
 * A scope's contradicting target is refused rather than silently dropped:
 * `titleGroupId` on a `tracked_title` or `rights_holder` entry (or
 * `trackedTitleId` on the others) answers 422 `validation_failed`, because
 * storing a null over a target the operator named would record an entry
 * they did not propose.
 */
async function insertProposedEntry(
  client: PoolClient,
  decidedAt: Date,
  operatorId: string,
  decisionId: string,
  entry: ProposedAllowlistEntryInput,
): Promise<{ id: string; json: Record<string, unknown> }> {
  const missing: Array<{ path: string; message: string }> = [];
  const conflicting: Array<{ path: string; message: string }> = [];
  if (entry.kind === "licensed_destination" && (entry.territory ?? "") === "") {
    missing.push({
      path: "/allowlistEntry/territory",
      message: "required for a licensed destination",
    });
  }
  if (entry.scope === "title_group" && (entry.titleGroupId ?? "") === "") {
    missing.push({
      path: "/allowlistEntry/titleGroupId",
      message: "required when the scope is a title group",
    });
  }
  if (entry.scope === "tracked_title" && (entry.trackedTitleId ?? "") === "") {
    missing.push({
      path: "/allowlistEntry/trackedTitleId",
      message: "required when the scope is a tracked title",
    });
  }
  if ((entry.value ?? "").trim() === "") {
    missing.push({ path: "/allowlistEntry/value", message: "required" });
  }
  // A target that contradicts the scope: refuse it, never silently null it.
  if (
    entry.scope !== "title_group" &&
    entry.titleGroupId !== undefined &&
    entry.titleGroupId !== ""
  ) {
    conflicting.push({
      path: "/allowlistEntry/titleGroupId",
      message: "contradicts the entry's scope",
    });
  }
  if (
    entry.scope !== "tracked_title" &&
    entry.trackedTitleId !== undefined &&
    entry.trackedTitleId !== ""
  ) {
    conflicting.push({
      path: "/allowlistEntry/trackedTitleId",
      message: "contradicts the entry's scope",
    });
  }
  if (conflicting.length > 0) {
    throw new ApiError(422, "validation_failed", { fieldErrors: conflicting });
  }
  if (missing.length > 0) {
    throw new ApiError(422, "unprocessable", { fieldErrors: missing });
  }
  const id = (await client.query<{ id: string }>("select uuidv7()::text as id")).rows[0].id;
  await client.query(
    `insert into allowlist_entries
       (id, kind, match_kind, value, scope, title_group_id, tracked_title_id, territory,
        origin, proposed_by_decision_id, confirmed_by, confirmed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'review_decision', $9, $10, $11)`,
    [
      id,
      entry.kind,
      entry.matchKind,
      entry.value,
      entry.scope,
      entry.scope === "title_group" ? entry.titleGroupId! : null,
      entry.scope === "tracked_title" ? entry.trackedTitleId! : null,
      entry.territory ?? null,
      decisionId,
      operatorId,
      decidedAt,
    ],
  );
  return {
    id,
    json: {
      id,
      kind: entry.kind,
      matchKind: entry.matchKind,
      value: entry.value,
      scope: entry.scope,
      ...(entry.titleGroupId === undefined ? {} : { titleGroupId: entry.titleGroupId }),
      ...(entry.trackedTitleId === undefined ? {} : { trackedTitleId: entry.trackedTitleId }),
      ...(entry.territory === undefined ? {} : { territory: entry.territory }),
      origin: "review_decision",
      proposedByDecisionId: decisionId,
      confirmedBy: operatorId,
      confirmedAt: decidedAt.toISOString(),
    },
  };
}

/**
 * The violation a confirm creates: the host is the landing page host the
 * newest captured evidence recorded after redirects, falling back to the
 * submitted host with `hostSource` saying so; the registrable domain is the
 * reputation unit; the predecessor is the pair's most recent terminal
 * violation when the URL reappeared. The partial unique index holds the
 * one-open-per-pair invariant — a raced second confirm loses there and
 * answers `state_conflict`.
 */
async function createViolation(
  client: PoolClient,
  decidedAt: Date,
  operatorId: string,
  decisionId: string,
  violationId: string,
  candidate: CandidateRow,
): Promise<ViolationRow> {
  const newestCaptured = await client.query<{
    id: string;
    host: string | null;
    reason: "detection" | "review" | "pre_handoff";
  }>(
    `select id, host, reason from evidence
      where normalized_url = $1 and outcome = 'captured'
      order by observed_at desc, id
      limit 1`,
    [candidate.normalizedUrl],
  );
  const newest = newestCaptured.rows[0];
  const host = newest?.host ?? candidate.host;
  const predecessor = await latestTerminalViolationForPair(client, {
    normalizedUrl: candidate.normalizedUrl,
    trackedTitleId: candidate.trackedTitleId,
  });
  const violation: NewViolation = {
    id: violationId,
    trackedTitleId: candidate.trackedTitleId,
    candidateId: candidate.id,
    reviewDecisionId: decisionId,
    url: candidate.url,
    normalizedUrl: candidate.normalizedUrl,
    host,
    hostSource: newest?.host != null ? "landing_page" : "submitted_url",
    registrableDomain: registrableDomainFor(host),
    detectedAt: candidate.firstSeenAt,
    confirmedAt: decidedAt,
    confirmedBy: operatorId,
    predecessorViolationId: predecessor?.id ?? null,
  };
  let row: ViolationRow;
  try {
    row = await insertViolation(client, violation);
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The pair already stands open — a raced or repeated confirm. One
      // winner exists; this decision is the loser the invariant refuses.
      throw new ApiError(409, "state_conflict", { currentState: "open" });
    }
    throw error;
  }
  if (newest !== undefined) {
    await citeViolationEvidence(client, {
      violationId: row.id,
      evidenceId: newest.id,
      role: newest.reason,
      citedAt: decidedAt,
      pinnedVersions: await pinnedVersionsForEvidence(client, newest.id),
    });
  }
  return row;
}

/** The candidate's side of the transition, with the dismissal it freezes. */
async function transitionCandidate(
  client: PoolClient,
  decidedAt: Date,
  operatorId: string,
  candidate: CandidateRow,
  input: ReviewDecisionInput,
  decisionId: string,
  violationId: string | null,
  proposedAllowlistEntryId: string | null,
): Promise<CandidateRow> {
  const confirming = input.action === "violation";
  // The contract's Dismissal: the pair-scoped record that suppresses this
  // (URL, tracked title) and no other. The material snapshot it freezes is
  // what the material-change detector later compares against.
  const dismissal: Record<string, unknown> | null = confirming
    ? null
    : {
        action: input.action,
        operatorId,
        decidedAt: decidedAt.toISOString(),
        ...(input.note === undefined ? {} : { note: input.note }),
        evidenceIds: input.evidenceIds,
        ...(input.rematchedTrackedTitleId === undefined
          ? {}
          : { rematchedTrackedTitleId: input.rematchedTrackedTitleId }),
        ...(proposedAllowlistEntryId === null
          ? {}
          : { proposedAllowlistEntryId }),
      };
  const materialSnapshot = confirming ? null : JSON.stringify(materialSnapshotFrom(candidate));
  const updated = await client.query<RawCandidateRow>(
    `update candidates
        set state = $2,
            review_decision_id = $3,
            violation_id = $4,
            confirmed_at = $5,
            dismissed_at = $6,
            dismissal = $7::jsonb,
            material_snapshot = $8::jsonb,
            updated_at = $9
      where id = $1
      returning ${CANDIDATE_COLUMNS}`,
    [
      candidate.id,
      confirming ? "confirmed" : "dismissed",
      decisionId,
      violationId,
      confirming ? decidedAt : null,
      confirming ? null : decidedAt,
      dismissal === null ? null : JSON.stringify(dismissal),
      materialSnapshot,
      decidedAt,
    ],
  );
  return mapCandidate(updated.rows[0]);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}
