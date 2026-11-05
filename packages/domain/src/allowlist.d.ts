/**
 * The pure allowlist matching shared by the API (entry management and,
 * from slice 5, candidate suppression) and the capture worker (the guard
 * before any fetch — implementation rules "Allowlist before capture": a
 * URL matching an entry is never fetched). Values normalize the way URL
 * keys do, so a `www.` host never escapes its own entry, and precedence
 * follows docs/design/matching-and-classification-rules.md.
 */
export type AllowlistKind = "official_domain" | "licensed_destination" | "neutral_source";
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
export declare function allowlistTier(kind: AllowlistKind): AllowlistTier;
/** The tier order, for tests and the slice-5 matcher. */
export declare const ALLOWLIST_TIER_ORDER: readonly AllowlistTier[];
/**
 * Normalizes an entry value into its matching form: a host is lowercased
 * (its leading www dropped, the way URL keys are), and a URL prefix becomes
 * the prefix of a normalized URL key, so matching compares like with like.
 * Throws a plain Error on a value that is neither; the caller decides how
 * the refusal reaches an operator.
 */
export declare function normalizeAllowlistValue(matchKind: AllowlistMatchKind, value: string): string;
/** True when one entry matches a URL under its match kind. */
export declare function entryMatchesUrl(entry: {
    matchKind: AllowlistMatchKind;
    value: string;
}, rawUrl: string): boolean;
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
export declare function findAllowlistHit(entries: ReadonlyArray<{
    kind: AllowlistKind;
    origin?: AllowlistOrigin;
} & {
    matchKind: AllowlistMatchKind;
    value: string;
}>, rawUrl: string): AllowlistHit | null;
