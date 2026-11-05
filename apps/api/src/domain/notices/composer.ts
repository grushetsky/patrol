import type { Pool } from "pg";
import { composeNotices, type ComposeRefusal } from "@patrol/notices";
import { ApiError } from "../../errors.js";

/**
 * The Notices interface's compose half (Patrol.Http `create`): the shared
 * composer's refusals mapped onto the contract's error bodies. The
 * composer (packages/notices) owns the transaction and the grouping; this
 * module owns the HTTP vocabulary — `violation_reserved` carries the
 * conflicting violations and the notice that reserves them, a duplicate
 * pair answers `duplicate_entity`, an over-cap or wrong-cardinality batch
 * answers `grouping_limit_exceeded`, and an ineligible recipient answers
 * `recipient_ineligible`.
 */

export interface CreateNoticeInput {
  recipient: "google" | "bing" | "yandex";
  recipientProfileId: string;
  violationIds: string[];
}

/** Maps one composer refusal onto the contract's error response. */
export function refusalError(refusal: ComposeRefusal): ApiError {
  switch (refusal.status) {
    case "profile_absent":
      return new ApiError(404, "not_found");
    case "recipient_mismatch":
      return new ApiError(400, "validation_failed", {
        fieldErrors: [
          {
            path: "/recipientProfileId",
            message: `the profile addresses ${refusal.profileRecipient}, not the request's recipient`,
          },
        ],
      });
    case "rights_holder_absent":
      return new ApiError(503, "setup_required");
    case "recipient_ineligible":
      return new ApiError(422, "recipient_ineligible");
    case "template_absent":
      return new ApiError(409, "state_conflict", {
        fieldErrors: [
          {
            path: "/recipient",
            message: "no verified statement template exists for this recipient and language",
          },
        ],
      });
    case "empty_selection":
      return new ApiError(400, "validation_failed", {
        fieldErrors: [
          { path: "/violationIds", message: "at least one violation is required" },
        ],
      });
    case "violation_absent":
      return new ApiError(404, "not_found");
    case "violation_not_open":
      return new ApiError(409, "state_conflict", { currentState: refusal.state });
    case "grouping_limit_exceeded":
      return new ApiError(422, "grouping_limit_exceeded");
    case "violation_reserved":
      return new ApiError(409, "violation_reserved", {
        conflictingViolationIds: refusal.conflictingViolationIds,
        existingNoticeId: refusal.existingNoticeId,
      });
    case "duplicate_entity":
      return new ApiError(409, "duplicate_entity", {
        existingNoticeId: refusal.existingNoticeId,
      });
  }
}

/**
 * POST /notices: compose one on-demand draft from the selected open
 * violations. The response body (NoticeDetail) is read back through the
 * same read model the GET uses, so the two surfaces cannot drift.
 */
export async function createNotice(
  pool: Pool,
  now: () => Date,
  operatorId: string,
  input: CreateNoticeInput,
): Promise<string> {
  const outcome = await composeNotices(
    { pool, now },
    {
      recipient: input.recipient,
      recipientProfileId: input.recipientProfileId,
      violationIds: input.violationIds,
      trigger: "on_demand",
      composedBy: operatorId,
    },
  );
  if (outcome.status === "refused") {
    throw refusalError(outcome.refusal);
  }
  // On demand composes exactly one notice; the contract answers with it.
  const notice = outcome.notices[0];
  if (notice === undefined) {
    // The selection resolved to nothing citable (every violation dropped
    // as a duplicate of an active notice) — the honest conflict.
    throw new ApiError(409, "duplicate_entity");
  }
  return notice.noticeId;
}
