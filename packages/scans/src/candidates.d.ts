import type { Pool } from "pg";
import { type AllowlistTitleContext, type FormationTitle, type ReputationFacts } from "@patrol/domain";
/**
 * The candidate store (docs/design/matching-and-classification-rules.md
 * "Candidate formation", "Score and bands"; contract Patrol.Domain.Candidate).
 * A search result creates a candidate by pairing its URL with the tracked
 * title whose variant generated the query; candidates deduplicate across
 * queries and engines on (normalized URL, tracked title), so the upsert is
 * the dedup and every observation only refreshes the observation summary —
 * first engine, first query, best rank, the engines array, and the last
 * observation time. Scores are never clobbered by a re-observation: the
 * formation score is what the SERP row alone supports (the URL slug), and
 * the deepened score lands when the capture's sidecar arrives.
 *
 * The allowlist check runs here, scoped: an entry applies when its scope is
 * the rights holder, the candidate's title group, or the candidate's title,
 * and a licensed destination additionally needs the observation's territory.
 * A hit is recorded on the candidate and the detection capture is not
 * enqueued — an allowlisted URL is never fetched.
 */
/** The engines a candidate row names. */
export type CandidateEngine = "google" | "bing" | "yandex";
/** One candidate row (the candidates table). */
export interface CandidateRow {
    id: string;
    trackedTitleId: string;
    url: string;
    normalizedUrl: string;
    host: string;
    registrableDomain: string;
    source: "serp" | "manual";
    engine: CandidateEngine | null;
    engines: CandidateEngine[];
    queryId: string | null;
    queryText: string | null;
    locale: string | null;
    territory: string | null;
    bestRank: number | null;
    matchedVariantId: string;
    matchedVariant: Record<string, unknown>;
    score: number;
    band: "a" | "b" | "c";
    scoreComponents: Record<string, unknown>;
    reputation: Record<string, unknown>;
    allowlistEntryId: string | null;
    allowlistKind: string | null;
    firstSeenAt: Date;
    lastObservedAt: Date;
    state: "pending" | "confirmed" | "dismissed";
    reviewDecisionId: string | null;
    violationId: string | null;
    confirmedAt: Date | null;
    dismissedAt: Date | null;
    dismissal: Record<string, unknown> | null;
    /** The page facts the worker's last rescore saw (episode count, landing domain). */
    lastPageFacts: Record<string, unknown> | null;
    /** The snapshot a dismissal froze for the material-change detector. */
    materialSnapshot: Record<string, unknown> | null;
    createdBy: string | null;
}
export declare const CANDIDATE_COLUMNS = "id, tracked_title_id, url, normalized_url, host, registrable_domain,\n  source, engine, engines, query_id, query_text, locale, territory, best_rank,\n  matched_variant_id, matched_variant, score, band, score_components, reputation,\n  allowlist_entry_id, allowlist_kind, first_seen_at, last_observed_at, state,\n  review_decision_id, violation_id, confirmed_at, dismissed_at, dismissal,\n  last_page_facts, material_snapshot, created_by";
/** A candidates-table row in its snake-case shape, as the store reads it. */
export type RawCandidateRow = {
    id: string;
    tracked_title_id: string;
    url: string;
    normalized_url: string;
    host: string;
    registrable_domain: string;
    source: "serp" | "manual";
    engine: CandidateEngine | null;
    engines: CandidateEngine[];
    query_id: string | null;
    query_text: string | null;
    locale: string | null;
    territory: string | null;
    best_rank: number | null;
    matched_variant_id: string;
    matched_variant: Record<string, unknown>;
    score: string;
    band: "a" | "b" | "c";
    score_components: Record<string, unknown>;
    reputation: Record<string, unknown>;
    allowlist_entry_id: string | null;
    allowlist_kind: string | null;
    first_seen_at: Date;
    last_observed_at: Date;
    state: "pending" | "confirmed" | "dismissed";
    review_decision_id: string | null;
    violation_id: string | null;
    confirmed_at: Date | null;
    dismissed_at: Date | null;
    dismissal: Record<string, unknown> | null;
    last_page_facts: Record<string, unknown> | null;
    material_snapshot: Record<string, unknown> | null;
    created_by: string | null;
};
export declare function mapCandidate(row: RawCandidateRow): CandidateRow;
/** Reads one candidate by id; null when absent. */
export declare function readCandidate(pool: Pool, candidateId: string): Promise<CandidateRow | null>;
/**
 * The candidate for one (URL, tracked title) pair, when one stands. A pair
 * accumulates one confirmed row per violation in its reappearance chain
 * (ADR 0001); the live row — pending or dismissed — is the pair's current
 * candidate, and a pair with no live row answers its newest confirmed row.
 * Callers that must decide between the two check the state themselves.
 */
export declare function candidateForPair(pool: Pool, input: {
    url: string;
    trackedTitleId: string;
}): Promise<CandidateRow | null>;
/** One tracked title with its variants, as formation and scoring see it. */
export declare function loadTitleForMatching(pool: Pool, trackedTitleId: string): Promise<(FormationTitle & {
    titleGroupId: string;
    originalVariantId: string;
}) | null>;
/**
 * The detection-capture enqueue port, injected by the caller's process. The
 * optional title context rides along so the port's own allowlist guard can
 * apply the scoped entries for the same pair the formation checked.
 */
export type EnqueueDetectionCapture = (input: {
    url: string;
    reason: "detection";
    context?: AllowlistTitleContext;
}) => Promise<unknown>;
/** What forming one observation produced. */
export interface FormationOutcome {
    candidate: CandidateRow;
    created: boolean;
    /** The allowlist entry that hit the URL, when one did. */
    allowlistEntryId: string | null;
}
/**
 * Forms the candidates one query's results pair: every result row of the
 * query, paired with the tracked title the query targeted. Deduplication is
 * the upsert — the same URL from a second query or a second engine refreshes
 * the observation summary and links the new result rows to the standing
 * candidate. A newly created candidate without an allowlist hit enqueues its
 * detection capture through the injected port (the port re-checks the
 * allowlist itself; formation skips the enqueue so a scoped hit never
 * fetches either). The formation score reads the domain's real reputation
 * facts, so the snapshot a candidate freezes at observation time is the
 * domain's standing, not a placeholder. A query without scan provenance —
 * no plan, no scan — has no engine to attribute and forms nothing; the
 * caller logs and walks on rather than guessing an engine.
 */
export declare function formCandidatesForQuery(pool: Pool, now: () => Date, input: {
    queryId: string;
    enqueueCapture?: EnqueueDetectionCapture;
    log?: (message: string, extra?: Record<string, unknown>) => void;
}): Promise<FormationOutcome[]>;
/**
 * Creates (or returns) the candidate a manual entry names: the operator's
 * URL paired with the tracked title they selected, source `manual`, no
 * engine, and the operator as actor. A standing pair is returned unchanged
 * — the deduplication key already names it — where standing means a live
 * row (pending or dismissed) or a confirmed pair whose violation is still
 * open. A pair whose violation left the open state (removed or closed,
 * both terminal) is reappearance history, not a standing pair: the manual
 * entry starts the reappearance, a new candidate whose confirm is a new
 * violation linked to its predecessor (ADR 0001). The matched variant is
 * the title's
 * original variant, and the score is the formation score (the URL slug),
 * exactly like a SERP-formed pair. Throws when the title does not exist or
 * was merged; the caller decides how that reaches the operator.
 */
export declare function formManualCandidate(pool: Pool, now: () => Date, input: {
    url: string;
    trackedTitleId: string;
    operatorId: string;
    enqueueCapture?: EnqueueDetectionCapture;
}): Promise<FormationOutcome>;
/** Twelve months, the reputation window. */
export declare const REPUTATION_WINDOW_MS: number;
/**
 * The reputation facts for one registrable domain: violations confirmed
 * against the domain in the last twelve months, read from the violations
 * table the review decision writes (slice 5b's swap away from the interim
 * confirmed-candidate count — a violation is now a first-class row, so the
 * aggregate reads the rows themselves and a closed violation keeps counting
 * for its confirmation window). Blocklists still have no stored source:
 * reputation blocklists remain a risk-register item (docs/plan/risks.md),
 * so `blocklisted` stays seam-false until a real source lands here — never
 * a hardcoded true.
 */
export declare function readReputationFacts(pool: Pool, now: () => Date, registrableDomain: string): Promise<ReputationFacts>;
/**
 * The player hosts among a capture's facts that reputation knows: at least
 * one confirmed violation at the host's registrable domain in the last
 * twelve months, read from the violations table. (A blocklist hit would
 * qualify too; no blocklist source is stored yet — the same seam
 * `readReputationFacts` documents.)
 */
export declare function knownBadPlayerHosts(pool: Pool, now: () => Date, hosts: readonly string[]): Promise<(host: string) => boolean>;
/**
 * Deepens the scores of one URL's pending candidates from a capture's
 * extraction sidecar: the exact or partial page-title match, the signals
 * the page's facts fire, and reputation applied only alongside a strong
 * signal. The frozen variant snapshot and the observation summary stand —
 * a candidate explains the observation it was formed from, and the score
 * explains the latest captured evidence. Confirmed and dismissed candidates
 * keep their decision-time scores; their lifecycle is the review slice's.
 * The same pass records the page facts a later dismissal freezes into its
 * material snapshot: the episode count the sidecar lists and the landing
 * registrable domain the capture resolved to. Returns the candidates
 * rescored.
 */
export declare function rescoreCandidatesFromSidecar(pool: Pool, now: () => Date, input: {
    normalizedUrl: string;
    sidecar: string | null;
    /** The capture's landing host, when it recorded one. */
    landingHost?: string | null;
}): Promise<CandidateRow[]>;
