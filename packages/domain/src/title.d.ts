/**
 * The title-text storage normalizer (docs/design/catalogue-entry.md
 * "Duplicate and near-duplicate handling"; GLOSSARY invariant "A title
 * variant's text is unique within its tracked title after normalization").
 *
 * Scope note: this is the normalization slice 2 needs for storage and
 * uniqueness — NFKC, full case fold, diacritic folding, and punctuation and
 * whitespace collapse. The full matching normalizer ("docs/design/
 * matching-and-classification-rules.md": a per-language article-less key and
 * a declared transliteration scheme) lands with slice 5 and builds on this
 * base; until then no article-less or transliterated key is claimed. Native
 * strings are never overwritten: only the derived key is stored beside the
 * operator's text.
 */
/**
 * Derives the matching key for one variant text. The native string is never
 * modified; this key is what the uniqueness constraint and the duplicate
 * checks compare.
 */
export declare function normalizeTitleText(text: string): string;
