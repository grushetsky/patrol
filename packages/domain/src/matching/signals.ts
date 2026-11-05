import { hostForUrl } from "../url.js";
import { isPlayerFrameUrl, type PageFacts } from "./sidecar.js";

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

/** The evaluation order, which is also the contribution order the score records. */
const SIGNAL_ORDER: readonly SignalKind[] = [
  "player",
  "duration",
  "download",
  "release",
  "episodes",
];

/** The ±10% band around a runtime the duration signal allows. */
export const DURATION_TOLERANCE = 0.1;

/**
 * How many per-episode links one season must list for the selector to count
 * as "most or all episodes of a season": a conventional season runs at least
 * six episodes, so a page with player links for that many distinct episodes
 * of one season is listing the season. Six is a declared reading of "most or
 * all" — the design names no count, and this constant is Patrol's pin.
 */
export const SEASON_EPISODE_THRESHOLD = 6;

/** The pre-release tokens the release signal reads. */
const RELEASE_TOKENS: readonly RegExp[] = [
  /\bcam\b/i,
  /\btelesync\b/i,
  /\btelecine\b/i,
  /\bworkprint\b/i,
];

/** A file size a page states next to a copy: "1.4 GB", "700 MB", "2,5 GB". */
const FILE_SIZE = /(^|\s)\d+(?:[.,]\d+)?\s*(?:TB|GB|MB)\b/i;

/** A video resolution a copy is offered in. */
const RESOLUTION = /\b(?:2160p|1080[pi]|720[pi]|480p|4k|8k)\b/i;

/** A release-source token naming where a copy came from. */
const RELEASE_SOURCE =
  /\b(?:web[-\s]?dl|webrip|blu[-\s]?ray|brrip|bdrip|hdrip|dvdrip|dvd[-\s]?scr|hdtv)\b/i;

/** An episode selector entry: "S01E02", "Episode 3", "серия 2", "2 серия". */
const EPISODE_LABEL =
  /^(?:s(\d{1,2})\s?[ex-]\s?(\d{1,3})|(?:episode|ep\.?|серия)\s*(\d{1,3})|(\d{1,3})\s*серия)(?:\D.*)?$/i;

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
 * The player host of a candidate player URL, lowercased without a leading
 * `www.` — the form reputation aggregates over.
 */
function playerHost(url: string): string | null {
  try {
    return hostForUrl(url);
  } catch {
    return null;
  }
}

/** The player signal: a known-bad player host behind a page-borne variant. */
function playerFired(input: SignalEvaluationInput): boolean {
  if (!input.titleOnPage) {
    return false;
  }
  const knownBad = input.playerHostKnownBad ?? (() => false);
  return input.facts.playerCandidates.some((candidate) => {
    const host = playerHost(candidate);
    return host !== null && knownBad(host);
  });
}

/** The duration signal: a declared duration within ±10% of the runtime. */
function durationFired(input: SignalEvaluationInput): boolean {
  const runtime = input.runtimeMinutes;
  if (runtime === undefined || runtime === null || runtime <= 0) {
    return false;
  }
  const seconds = runtime * 60;
  const band = seconds * DURATION_TOLERANCE;
  return input.facts.declaredDurationsSeconds.some(
    (declared) => Math.abs(declared - seconds) <= band,
  );
}

/** The download signal: an explicit download affordance on the page. */
function downloadFired(input: SignalEvaluationInput): boolean {
  if (input.facts.downloadAffordances.length > 0) {
    return true;
  }
  const texts = input.facts.linkTexts;
  if (texts.some((text) => FILE_SIZE.test(text))) {
    return true;
  }
  return texts.some(
    (text) => RESOLUTION.test(text) && RELEASE_SOURCE.test(text),
  );
}

/**
 * The release signal: a pre-release token for a title the catalogue places
 * in a future year. The catalogue carries a release year, not per-territory
 * release dates, so "released there within 30 days" is unevaluatable for a
 * current-year title and the signal stays silent rather than guess; a
 * strictly future year is "not yet released" outright. This year gate is the
 * catalogue limitation made explicit: per-territory release dates would let
 * a current-year title evaluate too, and the catalogue (slice 2's schema)
 * carries only `release_year`.
 */
function releaseFired(input: SignalEvaluationInput): boolean {
  const year = input.releaseYear;
  if (year === undefined || year === null) {
    return false;
  }
  if (year <= input.now.getUTCFullYear()) {
    return false;
  }
  const surfaces = [
    input.facts.pageTitle ?? "",
    ...input.facts.h1s,
    ...input.facts.structuredNames,
  ];
  return surfaces.some((surface) =>
    RELEASE_TOKENS.some((token) => token.test(surface)),
  );
}

/**
 * Distinct episode numbers of one season the selector links to
 * player-plausibly. A selector entry counts only when its per-episode href
 * is player-oriented — the same predicate the player signal's iframe set
 * uses — so a list of episode labels pointing at plain category pages never
 * reads as a season's worth of players.
 */
function episodeCounts(facts: PageFacts): number[] {
  const bySeason = new Map<number, Set<number>>();
  const episodesOf = (season: number): Set<number> => {
    let episodes = bySeason.get(season);
    if (episodes === undefined) {
      episodes = new Set();
      bySeason.set(season, episodes);
    }
    return episodes;
  };
  for (const entry of facts.episodeLinks) {
    if (!isPlayerFrameUrl(entry.href)) {
      continue;
    }
    const match = EPISODE_LABEL.exec(entry.label.trim());
    if (match === null) {
      continue;
    }
    if (match[1] !== undefined && match[2] !== undefined) {
      episodesOf(Number(match[1])).add(Number(match[2]));
      continue;
    }
    if (match[3] !== undefined) {
      // A bare "Episode N" belongs to the season the page is on.
      episodesOf(1).add(Number(match[3]));
      continue;
    }
    if (match[4] !== undefined) {
      episodesOf(1).add(Number(match[4]));
    }
  }
  return [...bySeason.values()].map((episodes) => episodes.size);
}

/** The episodes signal: one season's selector with per-episode player links. */
function episodesFired(input: SignalEvaluationInput): boolean {
  return episodeCounts(input.facts).some(
    (count) => count >= SEASON_EPISODE_THRESHOLD,
  );
}

/**
 * Evaluates every signal against one capture's facts. The result carries
 * each fired kind in the canonical order; the score assembly turns the list
 * into contributions. An unevaluatable signal simply does not appear.
 */
export function evaluateSignals(input: SignalEvaluationInput): FiredSignal[] {
  const fired = new Set<SignalKind>();
  if (playerFired(input)) {
    fired.add("player");
  }
  if (durationFired(input)) {
    fired.add("duration");
  }
  if (downloadFired(input)) {
    fired.add("download");
  }
  if (releaseFired(input)) {
    fired.add("release");
  }
  if (episodesFired(input)) {
    fired.add("episodes");
  }
  return SIGNAL_ORDER.filter((kind) => fired.has(kind)).map((kind) => ({
    kind,
  }));
}
