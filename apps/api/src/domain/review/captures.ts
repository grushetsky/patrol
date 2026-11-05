import type { Pool } from "pg";
import { enqueueCapture, type EnqueueCaptureResult } from "@patrol/evidence";
import type { AllowlistTitleContext } from "@patrol/domain";
import { readCandidate, type CandidateRow } from "@patrol/scans";
import { readViolation } from "@patrol/scans";
import { ApiError } from "../../errors.js";

/**
 * Review captures (docs/design/evidence-capture.md "Capture points"): the
 * `review` point fires when an operator opens a candidate or records a
 * review decision, and only when the newest live capture is over 24 hours
 * old. The enqueue port owns that freshness window and every guard in
 * front of a fetch (the allowlist before anything, an objection before the
 * fetch); this module is the API's wiring of the port onto the review
 * surfaces.
 *
 * The on-open enqueue is a side effect of a read, so it never blocks and
 * never fails the response: the operator sees the row either way, and the
 * capture the queue produces lands for the next look. The on-demand
 * endpoints (POST /candidates/{id}/captures, POST /violations/{id}/captures)
 * answer for themselves — 202 with the queued reason, or the port's
 * refusal codes.
 */

/** The API's enqueue port wiring: the evidence package plus dispatch. */
export interface CapturePort {
  enqueue: (input: {
    url: string;
    reason: "review" | "pre_handoff";
    context?: AllowlistTitleContext;
  }) => Promise<EnqueueCaptureResult>;
}

/** Builds the port over the pool, the clock, and the capture dispatch. */
export function capturePort(
  pool: Pool,
  now: () => Date,
  dispatch: (captureId: string) => Promise<void>,
): CapturePort {
  return {
    async enqueue(input) {
      return enqueueCapture({ pool, now, dispatch }, input);
    },
  };
}

/** The scoped allowlist context of one candidate's pair. */
async function contextForCandidate(
  pool: Pool,
  candidate: CandidateRow,
): Promise<AllowlistTitleContext> {
  const title = await pool.query<{ title_group_id: string }>(
    "select title_group_id from tracked_titles where id = $1",
    [candidate.trackedTitleId],
  );
  return {
    titleGroupId: title.rows[0]?.title_group_id ?? null,
    trackedTitleId: candidate.trackedTitleId,
    territory: candidate.territory,
  };
}

/**
 * The on-open side effect: a pending pair whose URL an operator is looking
 * at gets a review capture when its newest live capture is stale — the
 * port's freshness window decides, and its guards (an allowlisted URL is
 * never fetched) run before anything. Never awaited by the read path.
 */
export async function queueReviewCaptureOnOpen(
  port: CapturePort,
  pool: Pool,
  candidate: CandidateRow,
): Promise<void> {
  if (candidate.state !== "pending" || candidate.allowlistEntryId !== null) {
    return;
  }
  try {
    await port.enqueue({
      url: candidate.url,
      reason: "review",
      context: await contextForCandidate(pool, candidate),
    });
  } catch {
    // A refused enqueue never fails the read; the next capture point
    // catches up.
  }
}

/** What an on-demand capture request produced for the response. */
export type CaptureAnswer =
  | { status: "accepted"; queuedAt: Date; reason: "review" | "pre_handoff" }
  | { status: "allowlist" }
  | { status: "objection"; hostObjectionId: string };

/** Maps the port's answer onto the route's three outcomes. */
function answerOf(
  result: EnqueueCaptureResult,
  reason: "review" | "pre_handoff",
  now: () => Date,
): CaptureAnswer {
  if (result.status === "skipped_allowlist") {
    return { status: "allowlist" };
  }
  if (result.status === "refused") {
    return { status: "objection", hostObjectionId: result.hostObjectionId };
  }
  // queued, exists (the one-per-point row already stands), or fresh (the
  // newest live capture is inside the window): all accepted — the capture
  // the operator asked for either now stands or already covers the ask.
  return { status: "accepted", queuedAt: now(), reason };
}

/**
 * POST /candidates/{id}/captures: queue a capture of the candidate's URL.
 * An allowlisted URL is never captured (`allowlist_hit`); a host under an
 * objection answers 409 `host_objection` with the objection's id.
 */
export async function captureCandidateUrl(
  port: CapturePort,
  pool: Pool,
  now: () => Date,
  candidateId: string,
  reason: "review" | "pre_handoff",
): Promise<CaptureAnswer> {
  const candidate = await readCandidate(pool, candidateId);
  if (candidate === null) {
    throw new ApiError(404, "not_found");
  }
  const result = await port.enqueue({
    url: candidate.url,
    reason,
    context: await contextForCandidate(pool, candidate),
  });
  return answerOf(result, reason, now);
}

/**
 * POST /violations/{id}/captures: queue a capture of the violation's URL
 * for review or handoff, with the violation's title context for the
 * scoped allowlist guard.
 */
export async function captureViolationUrl(
  port: CapturePort,
  pool: Pool,
  now: () => Date,
  violationId: string,
  reason: "review" | "pre_handoff",
): Promise<CaptureAnswer> {
  const violation = await readViolation(pool, violationId);
  if (violation === null) {
    throw new ApiError(404, "not_found");
  }
  const title = await pool.query<{ title_group_id: string }>(
    "select title_group_id from tracked_titles where id = $1",
    [violation.trackedTitleId],
  );
  const result = await port.enqueue({
    url: violation.url,
    reason,
    context: {
      titleGroupId: title.rows[0]?.title_group_id ?? null,
      trackedTitleId: violation.trackedTitleId,
      territory: null,
    },
  });
  return answerOf(result, reason, now);
}
