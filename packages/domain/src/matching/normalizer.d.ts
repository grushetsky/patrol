/**
 * The matching normalizer (docs/design/matching-and-classification-rules.md
 * "Title match"; implementation rules "Normalization"): NFKC, full case fold,
 * diacritic folding that keeps the native string, punctuation and whitespace
 * collapse, a per-language article-less key, and a declared transliteration
 * scheme.
 *
 * This is the slice-5 matching key, which extends the storage normalizer
 * (`normalizeTitleText`) with the two matching-only steps:
 *
 * - **Transliteration.** The declared scheme is the BGN/PCGN romanization of
 *   Russian, applied to the NFKC string *before* the diacritic fold: NFKC
 *   composes the decomposed forms, so the table reads й as й (→ `y`) and ё
 *   as ё (→ `yo`) rather than as the breve- or diaeresis-stripped и and е
 *   the fold would leave — precomposed and decomposed inputs transliterate
 *   identically, and a Cyrillic variant and the page's Latin rendering of it
 *   share one key ("Рассвет" and "Rassvet" are both `rassvet`). The design
 *   names the requirement and Patrol declares this table as its scheme; the
 *   hard and soft signs carry no letter of their own in the key, exactly as
 *   their romanization marks vanish under the separator collapse. Other
 *   Cyrillic languages are out of scope until a variant language needs them.
 * - **The article-less key.** Each language declares the leading articles
 *   its titles carry; English declares `the`, `a`, and `an`. Russian
 *   declares none — it has no articles — so a Russian key never loses a
 *   token. A comparison context passes one language (the variant's); a
 *   context with none passes nothing and every declared list applies.
 *
 * The native string is never overwritten: `normalizeForMatching` returns the
 * text beside its key, and only the key is ever compared or stored as the
 * matching form.
 */
/** One text beside the key derived from it; the native string stands. */
export interface MatchingNormalization {
    /** The text as it was given, never rewritten. */
    native: string;
    /** The matching key: the folded, transliterated, article-less form. */
    key: string;
}
/**
 * Derives the matching key for one text under one language's article rule.
 * The pipeline is the design's own order: NFKC, the declared
 * transliteration (before the diacritic fold, so the table reads the
 * composed Cyrillic letters rather than their mark-stripped remnants),
 * diacritic folding, full case fold (the sharp s and the long s expand, the
 * Greek final sigma folds onto the medial form), separator collapse, and
 * the article-less key.
 */
export declare function normalizeForMatching(text: string, language?: string): MatchingNormalization;
/** The key alone, for comparisons that already hold the native text. */
export declare function matchingKey(text: string, language?: string): string;
