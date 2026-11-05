import type { Pool } from "pg";
import { reopenCandidate } from "@patrol/scans";
import { ApiError } from "../../errors.js";
import { recordSecurityEvent } from "../security-events.js";
import { candidateJson, reviewDecisionsFor } from "../candidates.js";

/**
 * The operator reopen (contract POST /candidates/{id}/reopen): a dismissed
 * pair returns to the queue. The pair-scoped dismissal is the only thing a
 * reopen touches — the decision history stands (review_decisions is
 * immutable), the candidate's lifecycle columns clear, and the score stays
 * frozen as it was decided on until the next decision re-freezes it. The
 * operator's reason rides the security event, not the pair: the candidates
 * table has no reopen column to hold it, and the append-only event log is
 * where an operator's deliberate overturn of a colleague's decision is
 * audited.
 */
export async function reopenCandidateRoute(
  pool: Pool,
  now: () => Date,
  operatorId: string,
  candidateId: string,
  note?: string,
): Promise<Record<string, unknown>> {
  const outcome = await reopenCandidate(pool, now, candidateId);
  switch (outcome.status) {
    case "reopened": {
      await recordSecurityEvent(pool, {
        operatorId,
        kind: "candidate_reopened",
        detail: {
          candidateId,
          ...(note === undefined || note.trim() === "" ? {} : { note: note.trim() }),
        },
      }, now());
      const decisions = await reviewDecisionsFor(pool, {
        normalizedUrl: outcome.candidate.normalizedUrl,
        trackedTitleId: outcome.candidate.trackedTitleId,
      });
      return candidateJson(
        outcome.candidate,
        decisions.map((decision) => decision.id),
      );
    }
    case "not_dismissed":
      // Only a dismissed pair reopens: a confirmed candidate's violation is
      // the record, and a pending pair never left the queue.
      throw new ApiError(409, "state_conflict", {
        currentState: outcome.candidate.state,
      });
    case "absent":
      throw new ApiError(404, "not_found");
  }
}
