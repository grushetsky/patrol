import { normalizeSlug, normalizeTitle } from "./normalize.js";
import type { PageFacts } from "./sidecar.js";

export type MatchKind = "exact" | "partial" | "none";
export type ScoreBand = "a" | "b" | "c";
export type SignalKind = "player" | "duration" | "download" | "release" | "episodes";

export interface TitleMatch {
  kind: MatchKind;
  value: number;
}

export interface SignalContribution {
  kind: SignalKind;
  value: number;
}

export interface ReputationInput {
  confirmedViolations: number;
  blocklisted: boolean;
}

export interface ScoreContext {
  variantText: string;
  variantLanguage?: string;
  runtimeMinutes?: number;
  url: string;
  /** Hosts with a confirmed violation in the last twelve months. */
  playerHosts?: Iterable<string>;
  reputation: ReputationInput;
  allowlisted?: boolean;
  shortener?: boolean;
  bandA?: number;
  bandB?: number;
}

export interface ScoreResult {
  score: number;
  titleMatch: number;
  signals: SignalContribution[];
  reputation: number;
  band: ScoreBand;
  suppressed: boolean;
}

const SHORTENER_HOSTS: Record<string, true> = {
  "bit.ly": true,
  "buff.ly": true,
  "cutt.ly": true,
  "is.gd": true,
  "ow.ly": true,
  "rebrand.ly": true,
  "shorturl.at": true,
  "t.co": true,
  "tinyurl.com": true,
};

/** Whether a host is a link shortener, which never hosts a violation. */
export function isShortener(host: string): boolean {
  return SHORTENER_HOSTS[host.toLowerCase()] === true;
}

function containsTokenSequence(haystack: string, needle: string): boolean {
  if (needle === "") {
    return false;
  }
  return ` ${haystack} `.includes(` ${needle} `);
}

/** The title-match contribution: exact 0.70, partial or slug 0.60, none 0.00. */
export function titleMatch(
  variantText: string,
  facts: PageFacts,
  url: string,
  language?: string,
): TitleMatch {
  const variant = normalizeTitle(variantText, language);
  if (variant === "") {
    return { kind: "none", value: 0 };
  }
  const names = facts.names
    .map((name) => normalizeTitle(name, language))
    .filter((name) => name !== "");

  if (
    names.some(
      (name) => name === variant || containsTokenSequence(name, variant),
    )
  ) {
    return { kind: "exact", value: 0.7 };
  }

  let slug = "";
  try {
    slug = normalizeSlug(new URL(url).pathname);
  } catch {
    slug = "";
  }
  if (slug !== "" && containsTokenSequence(slug, variant)) {
    return { kind: "partial", value: 0.6 };
  }
  if (names.some((name) => name.includes(variant))) {
    return { kind: "partial", value: 0.6 };
  }
  return { kind: "none", value: 0 };
}

/** The strong signals that the page evidence supports. */
export function evaluateSignals(
  facts: PageFacts,
  context: ScoreContext,
): SignalContribution[] {
  const hosts = new Set(
    [...(context.playerHosts ?? [])].map((host) => host.toLowerCase()),
  );
  const signals: SignalKind[] = [];

  const player = facts.playerUrls.some((raw) => {
    try {
      return hosts.has(new URL(raw).hostname.toLowerCase());
    } catch {
      return false;
    }
  });
  if (player) {
    signals.push("player");
  }

  if (
    facts.durationSeconds !== undefined &&
    context.runtimeMinutes !== undefined &&
    context.runtimeMinutes > 0
  ) {
    const runtimeSeconds = context.runtimeMinutes * 60;
    const delta = Math.abs(facts.durationSeconds - runtimeSeconds);
    if (delta <= runtimeSeconds * 0.1) {
      signals.push("duration");
    }
  }

  const downloadText = `${facts.downloadAffordances.join(" ")} ${facts.dom}`;
  if (
    facts.downloadAffordances.length > 0 ||
    /(?:magnet:|\.torrent|\.mkv|\.mp4)(?:[?#"'\s]|$)/i.test(downloadText)
  ) {
    signals.push("download");
  }

  if (facts.episodeNumbers.length >= 3) {
    signals.push("episodes");
  }

  return signals.map((kind, index) => ({
    kind,
    value: index === 0 ? 0.25 : index === 1 ? 0.05 : 0,
  }));
}

/** The reputation contribution, at most 0.10 and only alongside a signal. */
export function reputationContribution(
  reputation: ReputationInput,
  hasSignal: boolean,
): number {
  if (!hasSignal) {
    return 0;
  }
  const count = reputation.confirmedViolations;
  const bonus =
    count >= 10 ? 0.1 : count >= 3 ? 0.05 : count >= 1 ? 0.02 : 0;
  return Math.min(0.1, bonus + (reputation.blocklisted ? 0.02 : 0));
}

export function bandFor(
  score: number,
  thresholds: { bandA?: number; bandB?: number } = {},
): ScoreBand {
  const bandA = thresholds.bandA ?? 0.95;
  const bandB = thresholds.bandB ?? 0.7;
  if (score >= bandA) {
    return "a";
  }
  if (score >= bandB) {
    return "b";
  }
  return "c";
}

/** Score a candidate from its title match, page signals, and host reputation. */
export function scoreCandidate(
  facts: PageFacts,
  context: ScoreContext,
): ScoreResult {
  const match = titleMatch(
    context.variantText,
    facts,
    context.url,
    context.variantLanguage,
  );
  const signals = evaluateSignals(facts, context);
  const reputation = reputationContribution(
    context.reputation,
    signals.length > 0,
  );
  const score = Math.min(
    1,
    Math.round((match.value + signals.reduce((sum, signal) => sum + signal.value, 0) + reputation) * 1000) / 1000,
  );
  const suppressed = context.allowlisted === true || context.shortener === true;
  return {
    score,
    titleMatch: match.value,
    signals,
    reputation,
    band: suppressed ? "c" : bandFor(score, context),
    suppressed,
  };
}
