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
export type PlannableVariantKind = "original" | "localized" | "transliterated";
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
export declare const QUERY_LENGTH_CAPS: Record<PlanEngine, number>;
/**
 * The billable units one issued query costs: a Google depth-20 query is two
 * SERP units, a Yandex request one (implementation rules "Billable units").
 */
export declare const UNITS_PER_QUERY: Record<PlanEngine, number>;
/**
 * The intent phrases seeded per supported locale
 * (docs/design/query-strategy.md): "смотреть онлайн" and "скачать" for ru,
 * "watch online" and "download" for en. An operator edits the stored
 * configuration without a release; these defaults only seed it.
 */
export declare const DEFAULT_INTENT_PHRASES: Record<string, IntentPhraseConfig[]>;
/** The locale's language: the primary subtag, lowercased. */
export declare function languageOf(locale: string): string;
/**
 * Strips quotation marks and search operators from a query text
 * (ADR 0012). The operators DataForSEO bills at five times the base price
 * and the engines treat specially never reach the provider from Patrol;
 * allowlisting applies after matching, never inside the query.
 */
export declare function sanitizeQueryText(text: string): string;
/**
 * Truncates a text at a word boundary so it fits a cap: the longest prefix
 * that ends on whitespace, or a hard cut when a single word exceeds the
 * cap. The issued text is what the search result records, so an operator
 * can always reproduce the query.
 */
export declare function truncateAtWordBoundary(text: string, cap: number): string;
/**
 * The eligible variants for one title and locale, ordered original,
 * localized, transliterated, at most three. The original-title variant is
 * always eligible; another variant only when its language matches the
 * locale's language. The "alternate" kind names a recorded name that is
 * neither the original nor a localization or transliteration, and the
 * design's plan order does not include it.
 */
export declare function eligibleVariants(title: PlanTitle, locale: string): PlanVariant[];
/**
 * Derives the plan for one scan: the queries for every title, in every one
 * of the group's locales, deduplicated by normalized text so the same text
 * is never issued twice within the plan. `intentPhrases` maps a language to
 * its ordered phrases; a locale whose language has no configured phrases
 * issues no intent queries rather than inventing one.
 */
export declare function buildPlan(input: {
    locales: string[];
    titles: PlanTitle[];
    engine: PlanEngine;
    intentPhrases?: Record<string, IntentPhraseConfig[]>;
}): BuiltPlan;
/**
 * The billable units a plan costs on an engine: two per Google query at
 * depth 20, one per Yandex request (implementation rules "Google request",
 * "Yandex request"). This is the number the ledger reserves before a scan
 * starts.
 */
export declare function pricePlan(engine: PlanEngine, plan: BuiltPlan): number;
/** The Google request's fixed result depth: twenty results, two billable SERPs, no second page. */
export declare const GOOGLE_DEPTH = 20;
/** The Yandex request's fixed result shape: thirty flat groups of one document, one billable request. */
export declare const YANDEX_GROUPS_ON_PAGE = 30;
export declare const YANDEX_DOCS_IN_GROUP = 1;
export declare const YANDEX_GROUP_MODE = "flat";
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
    google: {
        languageCode: string;
        locationName: string;
    };
    /** Yandex's l10n, searchType, and region id. */
    yandex: {
        l10n: string;
        searchType: "SEARCH_TYPE_RU" | "SEARCH_TYPE_COM";
        region?: number;
    };
    /** The territory the query targeted, when one applied. */
    territory?: string;
}
export declare function localeRequestParams(locale: string): LocaleRequestParams;
