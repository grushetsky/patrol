import { type TitleMatch } from "./matcher.js";
import { type ReputationSnapshot } from "./reputation.js";
import { type AssembledScore } from "./score.js";
/**
 * Candidate formation's pure half
 * (docs/design/matching-and-classification-rules.md "Candidate formation",
 * "Score and bands"). A search result creates a candidate by pairing its URL
 * with the tracked title whose variant generated the query; candidates
 * deduplicate across queries and engines on (URL, tracked title); a manual
 * entry creates one with source `manual`.
 *
 * The score lifecycle is the document's own:
 *
 * - **At formation**, the SERP row supports exactly what the URL carries:
 *   the slug match, worth 0.60 or 0.00. Signals come from the captured page,
 *   never from the snippet, and the page-title match needs the page, so
 *   both wait for the capture's sidecar.
 * - **After the capture's sidecar lands**, the score deepens: the exact or
 *   partial title match against the page title, `h1`, and structured-data
 *   name, the signals the page's facts fire, and reputation — which applies
 *   only alongside a strong signal.
 */
/** A variant as formation sees it, matching the contract's VariantSnapshot. */
export interface FormationVariant {
    id: string;
    text: string;
    kind: "original" | "localized" | "transliterated" | "alternate";
    language: string;
    script: string;
    territory?: string | null;
}
/** A tracked title as formation sees it. */
export interface FormationTitle {
    id: string;
    runtimeMinutes?: number | null;
    releaseYear?: number | null;
    originalVariantId: string;
    variants: readonly FormationVariant[];
}
/** The variant snapshot frozen on the candidate at observation time. */
export type VariantSnapshot = Omit<FormationVariant, "territory"> & {
    territory: string | undefined;
};
/**
 * The variant fields a candidate carries so a review row explains its match
 * without joining the catalogue; the native text stands, never rewritten.
 */
export declare function variantSnapshot(variant: FormationVariant): VariantSnapshot;
/**
 * The deduplication key: one URL and one tracked title. The URL is the
 * normalized key — scheme dropped, host folded, tracking parameters gone —
 * so the same page reached through `http`, `www`, or a `utm_` parameter is
 * one candidate whatever query or engine surfaced it.
 */
export declare function candidateDedupKey(url: string, trackedTitleId: string): {
    normalizedUrl: string;
    trackedTitleId: string;
};
/** The reputation facts the caller read for the candidate's domain. */
export interface ReputationFacts {
    confirmedViolations: number;
    blocklisted: boolean;
}
/** What one scoring pass produced. */
export interface ScoredCandidate {
    match: TitleMatch & {
        variantId: string | null;
    };
    reputation: ReputationSnapshot;
    components: AssembledScore["components"];
    score: number;
    band: AssembledScore["band"];
}
/**
 * The score a candidate carries at formation, from the SERP row alone: the
 * best slug match across the title's variants, no signals (the snippet is
 * never a signal source), and the reputation facts the caller read for the
 * URL's registrable domain at formation time — which contributes nothing
 * while no strong signal has fired, but records an honest snapshot rather
 * than a zero placeholder.
 */
export declare function initialCandidateScore(input: {
    title: FormationTitle;
    url: string;
    /** The reputation facts read for the URL's registrable domain; absent reads as none. */
    reputation?: ReputationFacts;
}): ScoredCandidate;
/**
 * The score once the capture's sidecar landed: the best variant against the
 * page title, `h1`s, and structured-data names (falling back to the slug),
 * the signals the page's facts fire, and reputation applied only alongside a
 * strong signal.
 */
export declare function scoreFromPage(input: {
    title: FormationTitle;
    url: string;
    /** The capture's serialized extraction sidecar; missing facts stay empty. */
    sidecar: string | null | undefined;
    reputation: ReputationFacts;
    /** Whether a player host is known bad (12-month violation or blocklist). */
    playerHostKnownBad?: (host: string) => boolean;
    now: Date;
}): ScoredCandidate;
