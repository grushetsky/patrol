import type { Pool } from "pg";
import {
  approveNotice,
  supersedeNotice,
  withdrawNotice,
  type ApprovalDeps,
  type ApprovalRefusal,
  type SupersessionOutcome,
  type WithdrawalOutcome,
} from "@patrol/notices";
import { ApiError } from "../../errors.js";

/**
 * The Notices interface's lifecycle half (Patrol.Http `approve`, `withdraw`,
 * `supersede`): the shared modules' refusals mapped onto the contract's
 * error bodies. The bodies stay exactly what the contract declares:
 * `currentState` rides a 409 ONLY on a genuine lifecycle conflict (the
 * record's state is the reason the operation cannot run — a notice in the
 * wrong state, a violation no longer open), and `fieldErrors` ride ONLY a
 * 400 validation_failed; the template gates and the second-operator control
 * are conflicts over the world, not over the notice's state, so their 409s
 * carry the code and message alone.
 */

/** Maps one approval refusal onto the contract's error response. */
export function approvalRefusalError(refusal: ApprovalRefusal): ApiError {
  switch (refusal.status) {
    case "absent":
      return new ApiError(404, "not_found");
    case "state_conflict":
      return new ApiError(409, "state_conflict", { currentState: refusal.currentState });
    case "statement_version_mismatch":
      return new ApiError(400, "validation_failed", {
        fieldErrors: [
          {
            path: "/statementVersion",
            message: `the notice carries template ${refusal.noticeVersion}; re-read the notice before approving`,
          },
        ],
      });
    case "template_absent":
      return new ApiError(409, "state_conflict");
    case "template_superseded":
      return new ApiError(409, "state_conflict");
    case "template_stale":
      return new ApiError(409, "state_conflict");
    case "second_operator_required":
      return new ApiError(409, "state_conflict");
  }
}

/** Maps one withdrawal refusal onto the contract's error response. */
export function withdrawalRefusalError(
  refusal: Extract<WithdrawalOutcome, { status: "refused" }>["refusal"],
): ApiError {
  switch (refusal.status) {
    case "absent":
      return new ApiError(404, "not_found");
    case "state_conflict":
      return new ApiError(409, "state_conflict", { currentState: refusal.currentState });
    case "not_withdrawable":
      return new ApiError(409, "notice_not_withdrawable", {
        currentState: refusal.submissionState,
      });
  }
}

/** Maps one supersession refusal onto the contract's error response. */
export function supersessionRefusalError(
  refusal: Extract<SupersessionOutcome, { status: "refused" }>["refusal"],
): ApiError {
  switch (refusal.status) {
    case "absent":
      return new ApiError(404, "not_found");
    case "state_conflict":
      return new ApiError(409, "state_conflict", { currentState: refusal.currentState });
    case "already_filed":
      // A genuine lifecycle conflict: the notice's rendered status — the
      // submission's delivered or acknowledged state — is the reason the
      // supersession cannot run, exactly as it is for a withdrawal.
      return new ApiError(409, "state_conflict", { currentState: refusal.submissionState });
    case "empty_set":
      return new ApiError(400, "validation_failed", {
        fieldErrors: [
          {
            path: "/citedViolationIds",
            message: "the replacement must cite at least one violation",
          },
        ],
      });
    case "identical_set":
      return new ApiError(400, "validation_failed", {
        fieldErrors: [
          {
            path: "/citedViolationIds",
            message: "the corrected citation set must differ from the superseded notice's set",
          },
        ],
      });
    case "compose_refused":
      switch (refusal.outcome.status) {
        case "violation_reserved":
          return new ApiError(409, "violation_reserved", {
            conflictingViolationIds: refusal.outcome.conflictingViolationIds,
            existingNoticeId: refusal.outcome.existingNoticeId,
          });
        case "duplicate_entity":
          return new ApiError(409, "duplicate_entity", {
            existingNoticeId: refusal.outcome.existingNoticeId,
          });
        // A genuine lifecycle conflict — of the violation the corrected set
        // wants to cite; its current state is the reason for the refusal.
        case "violation_not_open":
          return new ApiError(409, "state_conflict", { currentState: refusal.outcome.state });
        default:
          return new ApiError(409, "state_conflict");
      }
  }
}

export type LifecycleDeps = ApprovalDeps;

/**
 * POST /notices/{id}/approval: the shared approval under the HTTP surface.
 * Returns the outcome the route serializes.
 */
export function approveNoticeRoute(
  deps: LifecycleDeps,
  operatorId: string,
  input: { noticeId: string; statementVersion: string },
) {
  return approveNotice(deps, { ...input, operatorId });
}

/** POST /notices/{id}/withdrawal. */
export function withdrawNoticeRoute(
  deps: { pool: Pool; now: () => Date },
  operatorId: string,
  input: { noticeId: string; reason?: string },
) {
  return withdrawNotice(deps, { ...input, operatorId });
}

/** POST /notices/{id}/supersession. */
export function supersedeNoticeRoute(
  deps: { pool: Pool; now: () => Date },
  operatorId: string,
  input: { noticeId: string; citedViolationIds: string[] },
) {
  return supersedeNotice(deps, { ...input, operatorId });
}
