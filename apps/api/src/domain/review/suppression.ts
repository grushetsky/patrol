import type { CandidateRow } from "@patrol/scans";
import { ApiError } from "../../errors.js";

/**
 * Allowlist suppression (docs/design/matching-and-classification-rules.md
 * "Allowlist", "Score and bands"; INVARIANTS.md: an allowlist hit prevents
 * a candidate from being confirmed, regardless of score). The hit is
 * recorded on the candidate at formation; the row routes to allowlist
 * review — the queue's `allowlistHit` filter — and the confirm transition
 * is the guard that refuses. No score path reaches a violation: only a
 * review decision creates one, and this guard is in its way.
 */

/**
 * The confirm-time guard: a candidate whose URL an allowlist entry hits can
 * never be confirmed, whatever its score. The refusal names the code the UI
 * branches on (`allowlist_hit`) so the operator is sent to the allowlist
 * review task — correct or remove the entry — rather than to the evidence.
 */
export function assertConfirmable(candidate: CandidateRow): void {
  if (candidate.allowlistEntryId !== null) {
    throw new ApiError(409, "allowlist_hit", {
      currentState: candidate.state,
    });
  }
}
