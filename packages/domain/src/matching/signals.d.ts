import { type PageFacts } from "./sidecar.js";
/**
 * The signal evaluator (docs/design/matching-and-classification-rules.md
 * "Strong signals"). Signals come from the captured page's sidecar facts —
 * never from the SERP snippet — and a signal that cannot be evaluated, such
 * as `duration` when the catalogue carries no runtime, contributes nothing.
 *
 * The five kinds, with the document's exact definitions:
 *
 * - `player`: a `VideoObject` `contentUrl` or `embedUrl`, or a player
 *   iframe, pointing at a host with at least one confirmed violation in the
 *   last 12 months or on a blocklist, with a title variant on the page.
 * - `duration`: a declared duration within ±10% of the tracked title's
 *   runtime.
 * - `download`: an explicit download affordance — a `.torrent` or `magnet:`
 *   link, a `.mkv` or `.mp4` link, a file size, or a resolution paired with
 *   a release-source token.
 * - `release`: a `CAM`, `TELESYNC`, `TELECINE`, or `WORKPRINT` token for a
 *   title not yet released in the candidate's territory, or released there
 *   within 30 days.
 * - `episodes`: an episode selector listing most or all episodes of a
 *   season with per-episode player links.
 *
 * Every fired signal is a strong signal (the document's section is "Strong
 * signals"); the weights live in the score assembly, not here.
 */
/** The contract's SignalKind. */
export type SignalKind = "player" | "duration" | "download" | "release" | "episodes";
/** The ±10% band around a runtime the duration signal allows. */
export declare const DURATION_TOLERANCE = 0.1;
/**
 * How many per-episode links one season must list for the selector to count
 * as "most or all episodes of a season": a conventional season runs at least
 * six episodes, so a page with player links for that many distinct episodes
 * of one season is listing the season. Six is a declared reading of "most or
 * all" — the design names no count, and this constant is Patrol's pin.
 */
export declare const SEASON_EPISODE_THRESHOLD = 6;
/** What the evaluation needs from the caller, all precomputed facts aside. */
export interface SignalEvaluationInput {
    /** The capture's parsed sidecar facts. */
    facts: PageFacts;
    /** Whether a title variant occurred on the page (the matcher's answer). */
    titleOnPage: boolean;
    /** The evaluation clock, for the release signal's year gate. */
    now: Date;
    /** The tracked title's runtime in minutes; absent when unknown. */
    runtimeMinutes?: number | null;
    /** The tracked title's release year; absent when unknown. */
    releaseYear?: number | null;
    /**
     * Whether a player host is one the reputation aggregate knows: at least
     * one confirmed violation in the last 12 months, or a blocklist entry.
     */
    playerHostKnownBad?: (host: string) => boolean;
}
/** One fired signal, with the kind that fired. */
export interface FiredSignal {
    kind: SignalKind;
}
/**
 * Evaluates every signal against one capture's facts. The result carries
 * each fired kind in the canonical order; the score assembly turns the list
 * into contributions. An unevaluatable signal simply does not appear.
 */
export declare function evaluateSignals(input: SignalEvaluationInput): FiredSignal[];
