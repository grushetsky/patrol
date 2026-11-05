import { normalizeTitleText } from "./title.js";

/**
 * The query planner (docs/design/query-strategy.md "Query plan",
 * implementation rules "Query plan and acquisition"). Pure: the caller loads
 * a group's locales, its titles and variants, and the intent-phrase
 * configuration; the builder derives the plan and nothing here touches a
 * database or a provider.
 *
 * Rules this module owns:
 *
 * - Per tracked title and locale, at most three bare variant queries,
 *   ordered original, localized, transliterated. The original-title variant
 *   is always eligible whatever its language; every other variant is
 *   eligible only when its language matches the locale's language.
 * - Two intent queries per locale: the display title followed by one intent
 *   phrase. Intent phrases are configuration carrying a version each search
 *   result records.
 * - Queries deduplicate by normalized text within one plan.
 * - No query carries quotation marks or a search operator.
 * - Length caps: Google 2,048 characters, Yandex 400. An intent query that
 *   exceeds its cap drops the intent phrase first; a variant is truncated
 *   at a word boundary.
 */

/** The engines a plan can be priced for. */
export type PlanEngine = "google" | "bing" | "yandex";

/** The contract's QueryKind. */
export type PlannedQueryKind = "variant" | "intent";

/** The variant kinds a plan derives queries from. */
export type PlannableVariantKind =
  | "original"
  | "localized"
  | "transliterated";

/** The contract's IntentPhrase: the text plus the version it was issued under. */
export interface IntentPhraseConfig {
  text: string;
  version: number;
}

/** One variant as the planner sees it. */
export interface PlanVariant {
  id: string;
  text: string;
  kind: PlannableVariantKind | "alternate";
  language: string;
}

/** One tracked title with the variants the plan chooses from. */
export interface PlanTitle {
  id: string;
  /** The title's original variant; its text is the display title. */
  originalVariant: PlanVariant;
  /** Every variant of the title, the original included. */
  variants: PlanVariant[];
}

/** One query in the plan, in plan order. */
export interface PlannedQuery {
  trackedTitleId: string;
  locale: string;
  kind: PlannedQueryKind;
  /** The exact text issued, after sanitization and any length cap. */
  text: string;
  /** The variant the query was generated from, for a variant query. */
  variantId?: string;
  /** The intent phrase appended, for an intent query. */
  intentPhrase?: IntentPhraseConfig;
}

/** The queries one scan issues, in plan order. */
export interface BuiltPlan {
  queries: PlannedQuery[];
}

/**
 * The maximum length of an issued query, in UTF-16 code units. Google caps
 * at 2,048 characters; Yandex at 400. Bing is deferred and reuses the
 * Google route's cap when it is added.
 */
export const QUERY_LENGTH_CAPS: Record<PlanEngine, number> = {
  google: 2048,
  bing: 2048,
  yandex: 400,
};

/**
 * The billable units one issued query costs: a Google depth-20 query is two
 * SERP units, a Yandex request one (implementation rules "Billable units").
 */
export const UNITS_PER_QUERY: Record<PlanEngine, number> = {
  google: 2,
  yandex: 1,
  // Bing buys no route in v1, so no plan on it is ever priced or issued.
  bing: 0,
};

/**
 * The intent phrases seeded per supported locale
 * (docs/design/query-strategy.md): "смотреть онлайн" and "скачать" for ru,
 * "watch online" and "download" for en. An operator edits the stored
 * configuration without a release; these defaults only seed it.
 */
export const DEFAULT_INTENT_PHRASES: Record<string, IntentPhraseConfig[]> = {
  ru: [
    { text: "смотреть онлайн", version: 1 },
    { text: "скачать", version: 1 },
  ],
  en: [
    { text: "watch online", version: 1 },
    { text: "download", version: 1 },
  ],
};

/** The locale's language: the primary subtag, lowercased. */
export function languageOf(locale: string): string {
  return locale.split("-")[0]?.toLowerCase() ?? "";
}

/** Quote characters stripped from every issued query. */
const QUOTE_CHARS = /["'“”‘’«»]/g;

/**
 * A search-operator token: an exclusion or inclusion prefix (`-term`,
 * `+term`) or a name:value operator (`site:`, `inurl:`, `intitle:`,
 * `filetype:` — any token whose first word ends in a colon). A hyphen
 * inside a word ("Spider-Man") is not an operator; only a token-leading
 * `-` or `+` is.
 */
const OPERATOR_TOKEN = /^[+-]|[A-Za-z0-9_]+:/;

/** A run of whitespace collapsed for rejoining tokens. */
const SPACE_RUN = /\s+/g;

/**
 * Strips quotation marks and search operators from a query text
 * (ADR 0012). The operators DataForSEO bills at five times the base price
 * and the engines treat specially never reach the provider from Patrol;
 * allowlisting applies after matching, never inside the query.
 */
export function sanitizeQueryText(text: string): string {
  const unquoted = text.replace(QUOTE_CHARS, "");
  const tokens = unquoted.split(/\s+/).filter((token) => {
    if (token.length === 0) {
      return false;
    }
    // Strip the leading operator marker and re-test the remainder, so
    // "-site:example.com" falls on either rule; a bare marker is noise.
    const bare = token.replace(/^[+-]/, "");
    if (bare.length === 0) {
      return false;
    }
    return !OPERATOR_TOKEN.test(token) && !OPERATOR_TOKEN.test(bare);
  });
  return tokens.join(" ").replace(SPACE_RUN, " ").trim();
}

/**
 * Truncates a text at a word boundary so it fits a cap: the longest prefix
 * that ends on whitespace, or a hard cut when a single word exceeds the
 * cap. The issued text is what the search result records, so an operator
 * can always reproduce the query.
 */
export function truncateAtWordBoundary(text: string, cap: number): string {
  if (text.length <= cap) {
    return text;
  }
  const slice = text.slice(0, cap);
  const boundary = slice.lastIndexOf(" ");
  return (boundary <= 0 ? slice : slice.slice(0, boundary)).trimEnd();
}

/** The order the eligible-variant kinds are considered in. */
const VARIANT_KIND_ORDER: Record<string, number> = {
  original: 0,
  localized: 1,
  transliterated: 2,
};

/** The most variants one title issues per locale. */
const MAX_VARIANTS_PER_LOCALE = 3;

/**
 * The eligible variants for one title and locale, ordered original,
 * localized, transliterated, at most three. The original-title variant is
 * always eligible; another variant only when its language matches the
 * locale's language. The "alternate" kind names a recorded name that is
 * neither the original nor a localization or transliteration, and the
 * design's plan order does not include it.
 */
export function eligibleVariants(
  title: PlanTitle,
  locale: string,
): PlanVariant[] {
  const language = languageOf(locale);
  const eligible = title.variants.filter(
    (variant) =>
      variant.id === title.originalVariant.id ||
      (variant.kind !== "original" &&
        variant.kind !== "alternate" &&
        languageOf(variant.language) === language),
  );
  eligible.sort(
    (left, right) =>
      (VARIANT_KIND_ORDER[left.kind] ?? 3) -
      (VARIANT_KIND_ORDER[right.kind] ?? 3),
  );
  return eligible.slice(0, MAX_VARIANTS_PER_LOCALE);
}

/**
 * Derives the plan for one scan: the queries for every title, in every one
 * of the group's locales, deduplicated by normalized text so the same text
 * is never issued twice within the plan. `intentPhrases` maps a language to
 * its ordered phrases; a locale whose language has no configured phrases
 * issues no intent queries rather than inventing one.
 */
export function buildPlan(input: {
  locales: string[];
  titles: PlanTitle[];
  engine: PlanEngine;
  intentPhrases?: Record<string, IntentPhraseConfig[]>;
}): BuiltPlan {
  const phrases = input.intentPhrases ?? DEFAULT_INTENT_PHRASES;
  const cap = QUERY_LENGTH_CAPS[input.engine];
  const queries: PlannedQuery[] = [];
  const seen = new Set<string>();
  const push = (query: PlannedQuery): void => {
    const key = normalizeTitleText(query.text);
    if (key.length === 0 || seen.has(key)) {
      return;
    }
    seen.add(key);
    queries.push(query);
  };

  for (const title of input.titles) {
    const displayTitle = sanitizeQueryText(title.originalVariant.text);
    for (const locale of input.locales) {
      for (const variant of eligibleVariants(title, locale)) {
        push({
          trackedTitleId: title.id,
          locale,
          kind: "variant",
          text: truncateAtWordBoundary(
            sanitizeQueryText(variant.text),
            cap,
          ),
          variantId: variant.id,
        });
      }
      for (const phrase of phrases[languageOf(locale)] ?? []) {
        const combined = sanitizeQueryText(
          `${title.originalVariant.text} ${phrase.text}`,
        );
        // A query over the cap drops its intent phrase first, then the
        // variant (here the display title) truncates at a word boundary.
        const text =
          combined.length > cap
            ? truncateAtWordBoundary(displayTitle, cap)
            : combined;
        push({
          trackedTitleId: title.id,
          locale,
          kind: "intent",
          text,
          intentPhrase: phrase,
        });
      }
    }
  }
  return { queries };
}

/**
 * The billable units a plan costs on an engine: two per Google query at
 * depth 20, one per Yandex request (implementation rules "Google request",
 * "Yandex request"). This is the number the ledger reserves before a scan
 * starts.
 */
export function pricePlan(engine: PlanEngine, plan: BuiltPlan): number {
  return UNITS_PER_QUERY[engine] * plan.queries.length;
}

/** The Google request's fixed result depth: twenty results, two billable SERPs, no second page. */
export const GOOGLE_DEPTH = 20;

/** The Yandex request's fixed result shape: thirty flat groups of one document, one billable request. */
export const YANDEX_GROUPS_ON_PAGE = 30;
export const YANDEX_DOCS_IN_GROUP = 1;
export const YANDEX_GROUP_MODE = "flat";

/**
 * The locale mapping both adapters issue under (implementation rules
 * "Locale mapping"): ru defaults to Russia, SEARCH_TYPE_RU, region 225; en
 * to the United States, SEARCH_TYPE_COM, no region; desktop; no freshness
 * filter. A locale outside the supported set maps like en — same territory
 * defaults (United States, "US"), its own language code — until the design
 * extends the set.
 */
export interface LocaleRequestParams {
  /** The locale's language, the primary subtag lowercased. */
  language: string;
  /** Google's language_code and location_name. */
  google: { languageCode: string; locationName: string };
  /** Yandex's l10n, searchType, and region id. */
  yandex: {
    l10n: string;
    searchType: "SEARCH_TYPE_RU" | "SEARCH_TYPE_COM";
    region?: number;
  };
  /** The territory the query targeted, when one applied. */
  territory?: string;
}

export function localeRequestParams(locale: string): LocaleRequestParams {
  const language = languageOf(locale);
  if (language === "ru") {
    return {
      language,
      google: { languageCode: "ru", locationName: "Russia" },
      yandex: { l10n: "ru", searchType: "SEARCH_TYPE_RU", region: 225 },
      territory: "RU",
    };
  }
  return {
    language,
    google: { languageCode: language, locationName: "United States" },
    yandex: { l10n: "en", searchType: "SEARCH_TYPE_COM" },
    territory: "US",
  };
}
