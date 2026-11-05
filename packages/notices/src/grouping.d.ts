import type { Recipient } from "./statements.js";
/**
 * Grouping per recipient (docs/design/notice-composition.md "Grouping per
 * recipient"; implementation rules "Notices and submissions / Grouping"):
 *
 * - Google: many works per notice, at most `GOOGLE_DEFAULT_URL_CAP` URLs
 *   by default, lowered to the profile's published per-file cap and the
 *   server-discovered cap the form's error text supplied. Patrol never
 *   hard-codes a discovered cap — the profile records it and this module
 *   only reads it.
 * - Bing: ONE tracked title per notice, at most 1,000 URLs; a title over
 *   the cap splits into numbered notices.
 * - Yandex: one violation, one URL, per notice.
 *
 * The composer's scheduled path splits a selection into batches (one notice
 * each); the on-demand path demands the selection fit a single notice,
 * because POST /notices composes one draft and answers once.
 */
/** Google's default per-file URL cap; the design's documented default. */
export declare const GOOGLE_DEFAULT_URL_CAP = 500;
/** Bing's published bulk-upload cap: 1,000 URLs per notice, one work each. */
export declare const BING_URL_CAP = 1000;
/** The profile-sourced caps grouping reads. Nullish caps are ignored. */
export interface GroupingCaps {
    /** The recipient's published per-notice cap, where one is published. */
    maxUrlsPerNotice?: number | null;
    /** The recipient's published per-file cap, where one is published. */
    maxUrlsPerFile?: number | null;
    /** The per-file cap last observed from the recipient's error text. */
    lastObservedMaxUrlsPerFile?: number | null;
}
/** The slice of a violation row grouping needs. */
export interface GroupingViolation {
    violationId: string;
    trackedTitleId: string;
    normalizedUrl: string;
}
/**
 * Google's effective URL cap: the default lowered by the profile's
 * published and server-discovered caps — the lowest of the values that
 * exist and are at least one.
 */
export declare function googleUrlCap(caps: GroupingCaps): number;
/**
 * Groups a selection into batches, one notice per batch, preserving the
 * input order (the operator's cart order or the confirmed-time order the
 * scheduled path selected). Generic in the row shape, so a caller's richer
 * violation rows survive the grouping.
 */
export declare function groupViolations<T extends GroupingViolation>(recipient: Recipient, violations: readonly T[], caps: GroupingCaps): T[][];
/**
 * Whether a selection fits ONE notice under the recipient's rules — the
 * on-demand contract: POST /notices composes one draft, so a selection
 * that would split is refused (`grouping_limit_exceeded`) and the operator
 * composes the parts separately.
 */
export declare function fitsSingleNotice(recipient: Recipient, violations: readonly GroupingViolation[], caps: GroupingCaps): boolean;
