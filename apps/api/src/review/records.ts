import { iso, parseArray } from "../catalogue/records.js";

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export interface CandidateRecord {
  id: string;
  trackedTitleId: string;
  url: string;
  normalizedUrl: string;
  host: string;
  registrableDomain: string;
  matchedVariantId: string;
  matchedVariant: Record<string, unknown>;
  score: number;
  scoreComponents: Record<string, unknown>;
  reputation: Record<string, unknown>;
  allowlistEntryId?: string;
  firstObservedAt: string;
  lastObservedAt: string;
  priorDecisionIds: string[];
  lifecycle: Record<string, unknown>;
}

export function toCandidate(
  row: Record<string, unknown>,
  priorDecisionIds: string[] = [],
): CandidateRecord {
  const state = String(row.state);
  const lifecycle =
    state === "confirmed"
      ? {
          state: "confirmed",
          reviewDecisionId: String(row.review_decision_id),
          violationId: String(row.violation_id),
          confirmedAt: iso(row.confirmed_at),
        }
      : state === "dismissed"
        ? {
            state: "dismissed",
            reviewDecisionId: String(row.review_decision_id),
            dismissal: parseObject(row.dismissal),
          }
        : { state: "pending" };
  return {
    id: String(row.id),
    trackedTitleId: String(row.tracked_title_id),
    url: String(row.url ?? ""),
    normalizedUrl: String(row.normalized_url ?? ""),
    host: String(row.host ?? ""),
    registrableDomain: String(row.registrable_domain ?? ""),
    matchedVariantId: String(row.matched_variant_id ?? ""),
    matchedVariant: parseObject(row.matched_variant),
    score: Number(row.score ?? 0),
    scoreComponents: parseObject(row.score_components),
    reputation: parseObject(row.reputation),
    ...(row.allowlist_entry_id
      ? { allowlistEntryId: String(row.allowlist_entry_id) }
      : {}),
    firstObservedAt: iso(row.first_observed_at ?? 0),
    lastObservedAt: iso(row.last_observed_at ?? 0),
    priorDecisionIds,
    lifecycle,
  };
}

export function toReviewRow(
  row: Record<string, unknown>,
  extras: {
    candidate: CandidateRecord;
    allowlistEntry?: Record<string, unknown>;
    prior?: Record<string, unknown>;
    newest?: Record<string, unknown>;
    thumbnail?: Record<string, unknown>;
  },
) {
  const candidate = extras.candidate;
  return {
    id: candidate.id,
    trackedTitleId: candidate.trackedTitleId,
    displayTitle: String(row.display_title ?? ""),
    releaseYear: Number(row.release_year),
    titleType: String(row.title_type),
    matchedVariant: candidate.matchedVariant,
    url: candidate.url,
    ...(row.final_url ? { finalUrl: String(row.final_url) } : {}),
    host: candidate.host,
    registrableDomain: candidate.registrableDomain,
    source: String(row.source),
    ...(row.engine ? { engine: String(row.engine) } : {}),
    ...(row.rank === null || row.rank === undefined
      ? {}
      : { rank: Number(row.rank) }),
    ...(row.query_text ? { queryText: String(row.query_text) } : {}),
    ...(row.locale ? { locale: String(row.locale) } : {}),
    ...(row.territory ? { territory: String(row.territory) } : {}),
    score: candidate.score,
    scoreComponents: candidate.scoreComponents,
    reputation: candidate.reputation,
    ...(extras.allowlistEntry
      ? { allowlistEntry: toAllowlistSummary(extras.allowlistEntry) }
      : {}),
    ...(extras.prior ? { priorDecision: toPriorDecision(extras.prior) } : {}),
    ...(extras.newest
      ? {
          newestEvidence: toEvidenceSummary(
            extras.newest,
            extras.thumbnail,
          ),
        }
      : {}),
    firstObservedAt: candidate.firstObservedAt,
    lastObservedAt: candidate.lastObservedAt,
    lifecycle: candidate.lifecycle,
  };
}

export function toReviewDecision(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    candidateId: String(row.candidate_id),
    action: String(row.action),
    operatorId: String(row.operator_id),
    decidedAt: iso(row.decided_at),
    ...(row.note ? { note: String(row.note) } : {}),
    evidenceIds: parseArray(row.evidence_ids),
    ...(row.violation_id ? { violationId: String(row.violation_id) } : {}),
    ...(row.rematched_tracked_title_id
      ? { rematchedTrackedTitleId: String(row.rematched_tracked_title_id) }
      : {}),
    ...(row.proposed_allowlist_entry_id
      ? { proposedAllowlistEntryId: String(row.proposed_allowlist_entry_id) }
      : {}),
  };
}

export function toEvidenceSummary(
  row: Record<string, unknown>,
  thumbnail?: Record<string, unknown>,
) {
  return {
    id: String(row.id),
    reason: String(row.reason),
    outcome: String(row.outcome),
    observedAt: iso(row.observed_at),
    ...(row.http_status === null || row.http_status === undefined
      ? {}
      : { httpStatus: Number(row.http_status) }),
    ...(row.final_url ? { finalUrl: String(row.final_url) } : {}),
    ...(row.host ? { host: String(row.host) } : {}),
    ...(thumbnail ? { thumbnail: toArtifactSummary(thumbnail) } : {}),
    purged: row.purged_at !== null && row.purged_at !== undefined,
  };
}

export function toArtifactSummary(row: Record<string, unknown>) {
  return {
    kind: String(row.kind),
    sha256: String(row.sha256),
    contentType: String(row.content_type),
    byteSize: Number(row.byte_size),
    ...(row.width === null || row.width === undefined
      ? {}
      : { width: Number(row.width) }),
    ...(row.height === null || row.height === undefined
      ? {}
      : { height: Number(row.height) }),
    truncated: Boolean(row.truncated),
  };
}

export function toAllowlistSummary(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    kind: String(row.kind),
    value: String(row.value),
    scope: String(row.scope),
    ...(row.territory ? { territory: String(row.territory) } : {}),
  };
}

export function toPriorDecision(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    action: String(row.action),
    operatorId: String(row.operator_id),
    decidedAt: iso(row.decided_at),
    ...(row.note ? { note: String(row.note) } : {}),
  };
}

export function toViolation(row: Record<string, unknown>) {
  const state = String(row.state);
  const lifecycle =
    state === "removed"
      ? {
          state: "removed",
          closedAt: iso(row.closed_at),
          reason: String(row.closure_reason),
          ...(row.closure_evidence_id
            ? { closureEvidenceId: String(row.closure_evidence_id) }
            : {}),
          ...(row.closed_by ? { closedBy: String(row.closed_by) } : {}),
        }
      : state === "closed"
        ? {
            state: "closed",
            closedAt: iso(row.closed_at),
            reason: String(row.closure_reason),
            closedBy: String(row.closed_by),
            ...(row.closure_note ? { note: String(row.closure_note) } : {}),
          }
        : { state: "open", openedAt: iso(row.confirmed_at) };
  return {
    id: String(row.id),
    trackedTitleId: String(row.tracked_title_id),
    candidateId: String(row.candidate_id),
    reviewDecisionId: String(row.review_decision_id),
    url: String(row.url),
    normalizedUrl: String(row.normalized_url),
    host: String(row.host),
    hostSource: String(row.host_source),
    registrableDomain: String(row.registrable_domain),
    detectedAt: iso(row.detected_at),
    confirmedAt: iso(row.confirmed_at),
    confirmedBy: String(row.confirmed_by),
    ...(row.predecessor_violation_id
      ? { predecessorViolationId: String(row.predecessor_violation_id) }
      : {}),
    lifecycle,
  };
}
