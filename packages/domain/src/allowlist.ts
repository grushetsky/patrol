import { hostForUrl, normalizeUrlKey } from "./url.js";

/**
 * The pure allowlist matching shared by the API (entry management and,
from slice 5, candidate suppression) and the capture worker (the guard
before any fetch — implementation rules "Allowlist before capture": a URL
matching an entry is never fetched). Values normalize the way URL keys
do, so a `www.` host never escapes its own entry, and precedence follows
docs/design/matching-and-classification-rules.md: rights-holder official
domains, then global neutral sources, then learned entries, then
reputation blocklists (the blocklist tier arrives with slice 5 and is
structured here already, because blocklists never veto a per-URL match).
 */

export type AllowlistKind =
  | "official_domain"
  | "licensed_destination"
  | "neutral_source";
export type AllowlistMatchKind = "host" | "url_prefix";
export type AllowlistScope = "rights_holder" | "title_group" | "tracked_title";
export type AllowlistOrigin = "operator" | "review_decision";

/** The precedence tiers, most specific and authoritative first. */
export type AllowlistTier = "official" | "neutral" | "learned" | "blocklist";

/**
 * The tier an entry matches in, decided by its kind alone. Slice 5's
 * reputation blocklist extends this with an origin (a blocklist source is
 * not an allowlist entry), which is when a second parameter arrives.
 */
export function allowlistTier(kind: AllowlistKind): AllowlistTier {
  if (kind === "official_domain") {
    return "official";
  }
  if (kind === "neutral_source") {
    return "neutral";
  }
  // A licensed destination is a learned fact whichever way it was
  // confirmed.
  return "learned";
}

/** The tier order, for tests and the slice-5 matcher. */
export const ALLOWLIST_TIER_ORDER: readonly AllowlistTier[] = [
  "official",
  "neutral",
  "learned",
  "blocklist",
];

/**
 * Normalizes an entry value into its matching form: a host is lowercased
 * (its leading www dropped, the way URL keys are), and a URL prefix becomes
 * the prefix of a normalized URL key, so matching compares like with like.
 * Throws a plain Error on a value that is neither; the caller decides how
 * the refusal reaches an operator.
 */
export function normalizeAllowlistValue(
  matchKind: AllowlistMatchKind,
  value: string,
): string {
  if (matchKind === "host") {
    const trimmed = value.trim().toLowerCase();
    try {
      return hostForUrl(`https://${trimmed}`);
    } catch {
      throw new Error("not a host");
    }
  }
  try {
    return normalizeUrlKey(value);
  } catch {
    throw new Error("not a URL prefix");
  }
}

/** True when one entry matches a URL under its match kind. */
export function entryMatchesUrl(
  entry: { matchKind: AllowlistMatchKind; value: string },
  rawUrl: string,
): boolean {
  const key = normalizeUrlKey(rawUrl);
  if (entry.matchKind === "host") {
    return hostForUrl(rawUrl) === entry.value;
  }
  return key === entry.value || key.startsWith(`${entry.value}/`);
}

/** The winning allowlist hit on a URL: its kind, match kind, and value. */
export interface AllowlistHit {
  kind: AllowlistKind;
  matchKind: AllowlistMatchKind;
  value: string;
}

/**
 * The highest-precedence entry matching a URL, or null. Scoped entries are
 * the caller's to filter first: matching here is about the value.
 */
export function findAllowlistHit(
  entries: ReadonlyArray<{ kind: AllowlistKind; origin?: AllowlistOrigin } & {
    matchKind: AllowlistMatchKind;
    value: string;
  }>,
  rawUrl: string,
): AllowlistHit | null {
  const matches = entries.filter((entry) => entryMatchesUrl(entry, rawUrl));
  if (matches.length === 0) {
    return null;
  }
  const ranked = [...matches].sort(
    (left, right) =>
      ALLOWLIST_TIER_ORDER.indexOf(allowlistTier(left.kind)) -
      ALLOWLIST_TIER_ORDER.indexOf(allowlistTier(right.kind)),
  );
  const best = ranked[0];
  return { kind: best.kind, matchKind: best.matchKind, value: best.value };
}
