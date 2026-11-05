import type { SignalKind } from "./signals.js";
import {
  REPUTATION_CAP,
  reputationContribution,
  type ReputationSnapshot,
} from "./reputation.js";

/**
 * The score assembly and the bands
 * (docs/design/matching-and-classification-rules.md "Score and bands").
 * The score is `min(1, title + signals + reputation)`. The title
 * contribution is 0.70 for an exact variant, 0.60 for a partial or slug
 * match, and 0.00 for none; the first strong signal adds 0.25, each
 * additional signal 0.05, capped at 0.30; reputation adds at most 0.10 and
 * only alongside a strong signal. No score confirms a violation — the bands
 * only route the review.
 */

/** The contract's ScoreComponents. */
export interface ScoreComponents {
  /** The title-match contribution: 0.70 / 0.60 / 0.00. */
  titleMatch: number;
  /** The strong signals that contributed, in evaluation order. */
  signals: Array<{ kind: SignalKind; value: number }>;
  /** The reputation contribution, at most 0.10. */
  reputation: number;
}

/** What the first strong signal adds. */
export const FIRST_SIGNAL_WEIGHT = 0.25;

/** What each additional strong signal adds. */
export const ADDITIONAL_SIGNAL_WEIGHT = 0.05;

/** The most the signals together can add. */
export const SIGNALS_CAP = 0.3;

/** The score cap. */
export const SCORE_CAP = 1;

/** The contract's ScoreBand. */
export type ScoreBand = "a" | "b" | "c";

/**
 * The band boundaries: a score at or above `a` is band A, at or above `b`
 * and below `a` is band B, below `b` is band C. The design calls the
 * boundaries configurable per engine, but no engine configuration exists
 * yet — a single default (the document's 0.95 and 0.70) is in force for
 * every engine, and an engine-keyed lookup lands with the settings that
 * would feed it.
 */
export interface BandBoundaries {
  a: number;
  b: number;
}

/** The document's default boundaries, in force for every engine today. */
export const DEFAULT_BAND_BOUNDARIES: BandBoundaries = { a: 0.95, b: 0.7 };

/** The band a score falls into under the given boundaries. */
export function bandForScore(score: number, boundaries: BandBoundaries = DEFAULT_BAND_BOUNDARIES): ScoreBand {
  if (score >= boundaries.a) {
    return "a";
  }
  if (score >= boundaries.b) {
    return "b";
  }
  return "c";
}

/** What one assembly produced: the components, the score, and the band. */
export interface AssembledScore {
  components: ScoreComponents;
  score: number;
  band: ScoreBand;
}

/**
 * Assembles the score from its parts. Signal contributions run in the given
 * order — the first strong signal takes 0.25, each additional 0.05 — and the
 * tail past the 0.30 cap is recorded as a zero-value contribution, so every
 * fired signal stays on the record even when the cap spends nothing on it.
 */
export function assembleScore(input: {
  titleMatch: number;
  signals: readonly SignalKind[];
  reputation: ReputationSnapshot;
  boundaries?: BandBoundaries;
}): AssembledScore {
  const contributions: ScoreComponents["signals"] = [];
  let signalTotal = 0;
  for (const [index, kind] of input.signals.entries()) {
    const value =
      index === 0 ? FIRST_SIGNAL_WEIGHT : ADDITIONAL_SIGNAL_WEIGHT;
    const affordable = Math.min(value, SIGNALS_CAP - signalTotal);
    contributions.push({ kind, value: roundScore(affordable) });
    signalTotal += affordable;
  }

  const reputation = reputationContribution(
    input.reputation,
    input.signals.length > 0,
  );

  const score = roundScore(
    Math.min(
      SCORE_CAP,
      roundScore(input.titleMatch) + roundScore(signalTotal) + reputation,
    ),
  );

  return {
    components: {
      titleMatch: roundScore(input.titleMatch),
      signals: contributions,
      reputation,
    },
    score,
    band: bandForScore(score, input.boundaries),
  };
}

/**
 * Scores are sums of twos and fives in decimal; rounding to three places
 * keeps 0.70 + 0.25 + 0.05 exactly 1.00 in floating point and the stored
 * numeric(4,3) honest about what was computed.
 */
export function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export { REPUTATION_CAP };
