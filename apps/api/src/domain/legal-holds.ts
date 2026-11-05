import type { Pool } from "pg";
import type { LegalHoldRow } from "@patrol/evidence";
import {
  listLegalHolds as listHolds,
  placeLegalHold as placeHold,
  releaseLegalHold as releaseHold,
} from "@patrol/evidence";
import { ApiError } from "../errors.js";
import { pageParams } from "../routes/support.js";

/**
 * The LegalHolds interface's domain (Patrol.Http): the list, the placement
 * over captures, violations, or notices, and the administrator's release.
 * A hold outranks every retention rule until released, and the release is
 * itself recorded — the purge job reads the same rows through the shared
 * package, so the surface and the enforcement cannot drift.
 */

/** The contract's LegalHold shape. */
export function legalHoldJson(row: LegalHoldRow): Record<string, unknown> {
  return {
    id: row.id,
    reason: row.reason,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    evidenceIds: row.evidenceIds,
    violationIds: row.violationIds,
    noticeIds: row.noticeIds,
    ...(row.releasedAt === null ? {} : { releasedAt: row.releasedAt.toISOString() }),
    ...(row.releasedBy === null ? {} : { releasedBy: row.releasedBy }),
  };
}

/** GET /legal-holds: every hold, newest first. */
export async function listLegalHoldsPage(
  pool: Pool,
  query: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { page, pageSize, limit, offset } = pageParams(query);
  const { rows, total } = await listHolds(pool, { limit, offset });
  return {
    items: rows.map(legalHoldJson),
    total,
    page,
    pageSize,
  };
}

/**
 * The reason every hold-carrying body must bring: the contract types it as
 * a bare string, the database CHECK holds the real line (`btrim`
 * non-empty), so a whitespace-only reason passes schema validation and
 * would surface as the database's 500. The route trims and answers the 422
 * the request always was, and the trimmed text is what gets recorded.
 */
function holdReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new ApiError(422, "unprocessable");
  }
  return trimmed;
}

/**
 * POST /legal-holds: place a hold. At least one of the three scopes is
 * required (the contract says so and the database CHECK holds the same
 * line); everything else is the operator's instruction recorded verbatim.
 */
export async function createLegalHoldRoute(
  deps: { pool: Pool; now: () => Date },
  actorId: string,
  body: {
    reason: string;
    evidenceIds?: string[];
    violationIds?: string[];
    noticeIds?: string[];
  },
): Promise<Record<string, unknown>> {
  const evidenceIds = body.evidenceIds ?? [];
  const violationIds = body.violationIds ?? [];
  const noticeIds = body.noticeIds ?? [];
  if (evidenceIds.length + violationIds.length + noticeIds.length === 0) {
    throw new ApiError(422, "unprocessable");
  }
  const row = await placeHold(deps.pool, deps.now, {
    reason: holdReason(body.reason),
    evidenceIds,
    violationIds,
    noticeIds,
    createdBy: actorId,
  });
  return legalHoldJson(row);
}

/**
 * POST /legal-holds/{id}/release: an administrator's explicit release (the
 * contract reserves the operation for the role). The release reason is
 * required and recorded; releasing a released hold is a state conflict,
 * and the next retention run after a release purges what the hold
 * suspended.
 */
export async function releaseLegalHoldRoute(
  deps: { pool: Pool; now: () => Date },
  actorId: string,
  legalHoldId: string,
  reason: string,
): Promise<Record<string, unknown>> {
  const result = await releaseHold(deps.pool, deps.now, {
    legalHoldId,
    operatorId: actorId,
    reason: holdReason(reason),
  });
  if (result.status === "absent") {
    throw new ApiError(404, "not_found");
  }
  if (result.status === "already_released") {
    throw new ApiError(409, "state_conflict");
  }
  return legalHoldJson(result.row);
}
