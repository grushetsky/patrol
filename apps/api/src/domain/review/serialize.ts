import type { ViolationRow } from "@patrol/scans";

/**
 * The violation serializers (contract Patrol.Domain.Violation with its
 * ViolationLifecycle union), shared by the decision result, the list row,
 * and the detail. One writer per shape, so the three surfaces cannot drift.
 */

/** The Violation's identity half, before the lifecycle union attaches. */
export function violationBaseJson(row: ViolationRow): Record<string, unknown> {
  return {
    id: row.id,
    trackedTitleId: row.trackedTitleId,
    candidateId: row.candidateId,
    reviewDecisionId: row.reviewDecisionId,
    url: row.url,
    normalizedUrl: row.normalizedUrl,
    host: row.host,
    hostSource: row.hostSource,
    registrableDomain: row.registrableDomain,
    detectedAt: row.detectedAt.toISOString(),
    confirmedAt: row.confirmedAt.toISOString(),
    confirmedBy: row.confirmedBy,
    ...(row.predecessorViolationId === null
      ? {}
      : { predecessorViolationId: row.predecessorViolationId }),
  };
}

/** The contract's Violation, with its lifecycle union. */
export function violationJson(row: ViolationRow): Record<string, unknown> {
  const base = violationBaseJson(row);
  switch (row.state) {
    case "open":
      return { ...base, lifecycle: { state: "open", openedAt: row.openedAt.toISOString() } };
    case "removed":
      return {
        ...base,
        lifecycle: {
          state: "removed",
          closedAt: row.closedAt!.toISOString(),
          reason: row.closureReason!,
          ...(row.closureEvidenceId === null ? {} : { closureEvidenceId: row.closureEvidenceId }),
          ...(row.closedBy === null ? {} : { closedBy: row.closedBy }),
        },
      };
    case "closed":
      return {
        ...base,
        lifecycle: {
          state: "closed",
          closedAt: row.closedAt!.toISOString(),
          reason: row.closureReason!,
          closedBy: row.closedBy!,
          ...(row.closureNote === null ? {} : { note: row.closureNote }),
        },
      };
  }
}
