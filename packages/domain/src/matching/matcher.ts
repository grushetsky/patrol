import { matchingKey } from "./normalizer.js";

/**
 * The title matcher (docs/design/matching-and-classification-rules.md
 * "Title match"). The scores are the document's table, copied, never
 * recomputed:
 *
 * | Match | Score | Definition |
 * | --- | --- | --- |
 * | Exact variant | 0.70 | The normalized variant equals the normalized page title, `h1`, or structured-data name, or occurs there as a complete token sequence. |
 * | Partial or slug | 0.60 | The variant occurs in the URL slug, or as a substring with extra tokens in the title or `h1`. |
 * | None | 0.00 | No variant occurs on the page. |
 *
 * A machine translation of a title is never a match; only catalogue-provided
 * variants are compared, so a page naming the work in another language
 * without a recorded variant of that form stays at "none".
 */

/** The exact score the document assigns an exact variant match. */
export const EXACT_MATCH_SCORE = 0.7;

/** The exact score the document assigns a partial or slug match. */
export const PARTIAL_MATCH_SCORE = 0.6;

/** The score when no variant occurs on the page. */
export const NO_MATCH_SCORE = 0;

/** The three match kinds behind the scores. */
export type TitleMatchKind = "exact" | "partial" | "none";

/** One variant as the matcher sees it. */
export interface MatchableVariant {
  id: string;
  text: string;
  language?: string;
}

/** The page surfaces a variant can match against. */
export interface MatchablePage {
  /** The captured page's `<title>`. */
  pageTitle?: string | null;
  /** The captured page's `<h1>` elements. */
  h1s?: string[];
  /** Structured-data names from the capture's sidecar. */
  structuredNames?: string[];
  /** The candidate URL, whose slug can carry a partial match. */
  url?: string;
}

/** What one variant's comparison against one page produced. */
export interface TitleMatch {
  kind: TitleMatchKind;
  score: number;
}

/**
 * Whether `needle` occurs inside `haystack` as a complete token sequence: a
 * contiguous run of whole tokens equal to the needle's tokens. "sunrise"
 * occurs in "watch sunrise 2024"; "rise" does not occur in "sunrise 2024".
 */
export function containsCompleteTokenSequence(
  needleKey: string,
  haystackKey: string,
): boolean {
  const needle = needleKey.split(" ").filter((token) => token !== "");
  const haystack = haystackKey.split(" ").filter((token) => token !== "");
  if (needle.length === 0 || haystack.length === 0) {
    return false;
  }
  outer: for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

/**
 * The URL's slug: the last non-empty path segment, with its hyphen and
 * underscore separators standing as token breaks ("sunrise-2024_full" →
 * "sunrise 2024 full").
 */
export function urlSlugKey(url: string | undefined): string | null {
  if (url === undefined) {
    return null;
  }
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const segments = path.split("/").filter((segment) => segment !== "");
  const slug = segments[segments.length - 1];
  if (slug === undefined || slug === "") {
    return null;
  }
  return matchingKey(slug.replace(/[-_]+/g, " "));
}

/**
 * Matches one variant against one page. The exact sources are the page
 * title, the h1 elements, and structured-data names; the partial sources
 * are those title surfaces as substrings plus the URL slug. A substring
 * inside a single word is a partial occurrence, not an exact one — only a
 * complete token sequence is exact.
 */
export function matchVariant(
  variant: MatchableVariant,
  page: MatchablePage,
): TitleMatch {
  const variantKey = matchingKey(variant.text, variant.language);

  const exactSources = [
    page.pageTitle ?? null,
    ...(page.h1s ?? []),
    ...(page.structuredNames ?? []),
  ];
  for (const source of exactSources) {
    if (source === null || source === "") {
      continue;
    }
    const sourceKey = matchingKey(source, variant.language);
    if (variantKey === "" || sourceKey === "") {
      continue;
    }
    if (
      sourceKey === variantKey ||
      containsCompleteTokenSequence(variantKey, sourceKey)
    ) {
      return { kind: "exact", score: EXACT_MATCH_SCORE };
    }
  }

  // Partial: a substring of the title or an h1 — "with extra tokens", so an
  // embedded-in-a-word hit counts as an occurrence, just not an exact one —
  // or an occurrence in the URL slug.
  const partialTextSources = [page.pageTitle ?? null, ...(page.h1s ?? [])];
  for (const source of partialTextSources) {
    if (source === null || source === "") {
      continue;
    }
    const sourceKey = matchingKey(source, variant.language);
    if (variantKey !== "" && sourceKey.includes(variantKey)) {
      return { kind: "partial", score: PARTIAL_MATCH_SCORE };
    }
  }
  const slug = urlSlugKey(page.url);
  if (variantKey !== "" && slug !== null && slug.includes(variantKey)) {
    return { kind: "partial", score: PARTIAL_MATCH_SCORE };
  }

  return { kind: "none", score: NO_MATCH_SCORE };
}

/**
 * The best match across a title's variants: the highest score wins, the
 * first variant to reach it is the one named. `variantId` is null when no
 * variant occurs, so a caller never mistakes "no match" for a missing
 * comparison.
 */
export function bestVariantMatch(
  variants: readonly MatchableVariant[],
  page: MatchablePage,
): TitleMatch & { variantId: string | null } {
  let best: TitleMatch & { variantId: string | null } = {
    kind: "none",
    score: NO_MATCH_SCORE,
    variantId: null,
  };
  for (const variant of variants) {
    const match = matchVariant(variant, page);
    if (match.score > best.score) {
      best = { ...match, variantId: variant.id };
    }
  }
  return best;
}
