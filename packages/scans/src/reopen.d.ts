import type { Pool } from "pg";
import { type CandidateRow } from "./candidates.js";
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
export declare function isMaterialChange(stored: MaterialSnapshot | null, current: CurrentPageFacts): boolean;
/** What one reopen attempt produced. */
export type ReopenResult = {
    status: "reopened";
    candidate: CandidateRow;
} | {
    status: "not_dismissed";
    candidate: CandidateRow;
} | {
    status: "absent";
};
/**
 * Returns one dismissed pair to the queue. The lifecycle columns clear —
 * the decision stays in the pair's history (review_decisions is immutable)
 * while the candidate loses its decision-time state, and the score stands
 * frozen as it was decided on; the next decision re-freezes it. Only a
 * dismissed pair reopens: a confirmed candidate's violation is the record,
 * and a pending pair never left the queue.
 */
export declare function reopenCandidate(pool: Pool, now: () => Date, candidateId: string): Promise<ReopenResult>;
/** The snapshot a dismissal freezes from the candidate's standing facts. */
export declare function materialSnapshotFrom(candidate: CandidateRow): MaterialSnapshot;
/** The frozen snapshot as the detector reads it, or null when none stands. */
export declare function materialSnapshotOf(snapshot: Record<string, unknown> | null): MaterialSnapshot | null;
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
export declare function currentPageFactsFor(pool: Pool, now: () => Date, input: {
    candidate: CandidateRow;
    sidecar: string | null;
    landingHost: string | null;
}): Promise<CurrentPageFacts>;
/** What the captured-outcome hook did to one URL's dismissed pairs. */
export interface CaptureReopenOutcome {
    /** The candidates returned to the queue. */
    reopenedCandidateIds: string[];
    /** Why each reopened: its dismissal action plus the rule that fired. */
    reasons: Array<{
        candidateId: string;
        rule: "page_dead_serves_content" | "material_change";
    }>;
}
/**
 * The worker's post-capture hook for a URL whose capture returned content:
 * a `page_dead` pair reopens because the URL serves content again, and any
 * other dismissed pair reopens when the new capture shows a material
 * change. A pair whose dismissal still matches the page stays dismissed.
 */
export declare function reopenDismissedOnCapture(pool: Pool, now: () => Date, input: {
    normalizedUrl: string;
    sidecar: string | null;
    landingHost: string | null;
}): Promise<CaptureReopenOutcome>;
