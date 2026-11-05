import type { Pool } from "pg";
import { hostForUrl, parseSidecar, registrableDomainFor, scoreFromPage } from "@patrol/domain";
import {
  CANDIDATE_COLUMNS,
  knownBadPlayerHosts,
  loadTitleForMatching,
  mapCandidate,
  type CandidateRow,
  type RawCandidateRow,
} from "./candidates.js";

/**
 * Dismissal reopening (docs/design/matching-and-classification-rules.md
 * "Dismissal and reopening"; ADR 0010 pair-scoped dismissal). A dismissed
 * pair returns as a candidate when an operator reopens it, or when a new
 * capture shows a material change: a strong signal that was absent at
 * dismissal, an expanded episode range, or a different landing registrable
 * domain. A `page_dead` pair reopens when a capture returns content.
 *
 * The dismissal freezes the page it judged — the signal kinds behind the
 * score, the episode count, and the landing registrable domain of the
 * newest capture — into `candidates.material_snapshot`; the detector
 * compares that snapshot against what the new capture's sidecar supports.
 * This module is shared because the worker runs the detector on every
 * captured outcome while the operator reopen is the API's route.
 */

/** The page facts a dismissal freezes for the material-change detector. */
export interface MaterialSnapshot {
  /** The strong-signal kinds that contributed to the dismissal-time score. */
  signals: string[];
  /** The episode count the dismissal-time page listed, when it was known. */
  episodeCount: number | null;
  /** The landing registrable domain of the newest capture at dismissal. */
  landingRegistrableDomain: string | null;
}

/** What a new capture supports, for the same comparison. */
export interface CurrentPageFacts {
  /** The strong-signal kinds the new page fires. */
  signals: string[];
  /** The episode count the new page lists. */
  episodeCount: number | null;
  /** The new capture's landing registrable domain. */
  landingRegistrableDomain: string | null;
}

/**
 * Whether the change between a dismissal's frozen page and a new capture is
 * material. A missing snapshot is no baseline — a pair dismissed before any
 * capture landed reopens through an operator, not through a guess. An
 * unknown episode count on either side cannot prove expansion, so it never
 * fires alone; an episodes signal that appears at all is a new strong
 * signal and fires on the first rule.
 */
export function isMaterialChange(
  stored: MaterialSnapshot | null,
  current: CurrentPageFacts,
): boolean {
  if (stored === null) {
    return false;
  }
  if (current.signals.some((kind) => !stored.signals.includes(kind))) {
    return true;
  }
  if (
    stored.episodeCount !== null &&
    current.episodeCount !== null &&
    current.episodeCount > stored.episodeCount
  ) {
    return true;
  }
  if (
    stored.landingRegistrableDomain !== null &&
    current.landingRegistrableDomain !== null &&
    current.landingRegistrableDomain !== stored.landingRegistrableDomain
  ) {
    return true;
  }
  return false;
}

/** What one reopen attempt produced. */
export type ReopenResult =
  | { status: "reopened"; candidate: CandidateRow }
  | { status: "not_dismissed"; candidate: CandidateRow }
  | { status: "absent" };

/**
 * Returns one dismissed pair to the queue. The lifecycle columns clear —
 * the decision stays in the pair's history (review_decisions is immutable)
 * while the candidate loses its decision-time state, and the score stands
 * frozen as it was decided on; the next decision re-freezes it. Only a
 * dismissed pair reopens: a confirmed candidate's violation is the record,
 * and a pending pair never left the queue.
 */
export async function reopenCandidate(
  pool: Pool,
  now: () => Date,
  candidateId: string,
): Promise<ReopenResult> {
  const result = await pool.query<RawCandidateRow>(
    `update candidates
        set state = 'pending', review_decision_id = null, violation_id = null,
            confirmed_at = null, dismissed_at = null, dismissal = null,
            material_snapshot = null, updated_at = $2
      where id = $1 and state = 'dismissed'
      returning ${CANDIDATE_COLUMNS}`,
    [candidateId, now()],
  );
  if (result.rows.length > 0) {
    return { status: "reopened", candidate: mapCandidate(result.rows[0]) };
  }
  const standing = await pool.query<RawCandidateRow>(
    `select ${CANDIDATE_COLUMNS} from candidates where id = $1`,
    [candidateId],
  );
  if (standing.rows.length === 0) {
    return { status: "absent" };
  }
  return { status: "not_dismissed", candidate: mapCandidate(standing.rows[0]) };
}

/** The snapshot a dismissal freezes from the candidate's standing facts. */
export function materialSnapshotFrom(candidate: CandidateRow): MaterialSnapshot {
  const components = candidate.scoreComponents as {
    signals?: Array<{ kind: string }>;
  };
  const facts = candidate.lastPageFacts as {
    episodeCount?: number | null;
    landingRegistrableDomain?: string | null;
  } | null;
  return {
    signals: (components.signals ?? []).map((signal) => signal.kind),
    episodeCount: facts?.episodeCount ?? null,
    landingRegistrableDomain: facts?.landingRegistrableDomain ?? null,
  };
}

/** The frozen snapshot as the detector reads it, or null when none stands. */
export function materialSnapshotOf(
  snapshot: Record<string, unknown> | null,
): MaterialSnapshot | null {
  if (snapshot === null || typeof snapshot !== "object") {
    return null;
  }
  const signals = Array.isArray(snapshot.signals)
    ? snapshot.signals.filter((kind): kind is string => typeof kind === "string")
    : [];
  const episodeCount =
    typeof snapshot.episodeCount === "number" ? snapshot.episodeCount : null;
  const landingRegistrableDomain =
    typeof snapshot.landingRegistrableDomain === "string"
      ? snapshot.landingRegistrableDomain
      : null;
  return { signals, episodeCount, landingRegistrableDomain };
}

/**
 * Evaluates a new capture's sidecar against one candidate's frozen
 * snapshot: the real signal evaluation (the title, the page's facts, the
 * signal rules) reads the kinds the page fires, never a re-implementation
 * of them. Reputation is irrelevant here — only which signals fire — so the
 * facts pass as a zeroed domain, except the player signal's own question:
 * whether a player host is known bad reads the real violations aggregate
 * (`knownBadPlayerHosts`), because a player on a known-bad host is exactly
 * the new strong signal the detector exists to catch.
 */
export async function currentPageFactsFor(
  pool: Pool,
  now: () => Date,
  input: { candidate: CandidateRow; sidecar: string | null; landingHost: string | null },
): Promise<CurrentPageFacts> {
  const title = await loadTitleForMatching(pool, input.candidate.trackedTitleId);
  const facts = parseSidecar(input.sidecar);
  if (title === null) {
    return {
      signals: [],
      episodeCount: facts.episodeLinks.length,
      landingRegistrableDomain: domainOrNull(input.landingHost),
    };
  }
  const playerHosts = [
    ...new Set(
      facts.playerCandidates
        .map((candidate) => {
          try {
            return hostForUrl(candidate);
          } catch {
            return null;
          }
        })
        .filter((host): host is string => host !== null),
    ),
  ];
  const scored = scoreFromPage({
    title,
    url: input.candidate.url,
    sidecar: input.sidecar,
    reputation: { confirmedViolations: 0, blocklisted: false },
    playerHostKnownBad: await knownBadPlayerHosts(pool, now, playerHosts),
    now: now(),
  });
  return {
    signals: scored.components.signals.map((signal) => signal.kind as string),
    episodeCount: facts.episodeLinks.length,
    landingRegistrableDomain: domainOrNull(input.landingHost),
  };
}

function domainOrNull(host: string | null): string | null {
  if (host === null) {
    return null;
  }
  try {
    return registrableDomainFor(host);
  } catch {
    return null;
  }
}

/** What the captured-outcome hook did to one URL's dismissed pairs. */
export interface CaptureReopenOutcome {
  /** The candidates returned to the queue. */
  reopenedCandidateIds: string[];
  /** Why each reopened: its dismissal action plus the rule that fired. */
  reasons: Array<{ candidateId: string; rule: "page_dead_serves_content" | "material_change" }>;
}

/**
 * The worker's post-capture hook for a URL whose capture returned content:
 * a `page_dead` pair reopens because the URL serves content again, and any
 * other dismissed pair reopens when the new capture shows a material
 * change. A pair whose dismissal still matches the page stays dismissed.
 */
export async function reopenDismissedOnCapture(
  pool: Pool,
  now: () => Date,
  input: { normalizedUrl: string; sidecar: string | null; landingHost: string | null },
): Promise<CaptureReopenOutcome> {
  const dismissed = await pool.query<RawCandidateRow>(
    `select ${CANDIDATE_COLUMNS} from candidates
      where normalized_url = $1 and state = 'dismissed'`,
    [input.normalizedUrl],
  );
  const outcome: CaptureReopenOutcome = {
    reopenedCandidateIds: [],
    reasons: [],
  };
  for (const raw of dismissed.rows) {
    const candidate = mapCandidate(raw);
    const dismissalAction = (candidate.dismissal as { action?: string } | null)?.action;
    let rule: CaptureReopenOutcome["reasons"][number]["rule"] | null = null;
    if (dismissalAction === "page_dead") {
      rule = "page_dead_serves_content";
    } else {
      const current = await currentPageFactsFor(pool, now, {
        candidate,
        sidecar: input.sidecar,
        landingHost: input.landingHost,
      });
      if (isMaterialChange(materialSnapshotOf(candidate.materialSnapshot), current)) {
        rule = "material_change";
      }
    }
    if (rule === null) {
      continue;
    }
    const reopened = await reopenCandidate(pool, now, candidate.id);
    if (reopened.status === "reopened") {
      outcome.reopenedCandidateIds.push(candidate.id);
      outcome.reasons.push({ candidateId: candidate.id, rule });
    }
  }
  return outcome;
}
