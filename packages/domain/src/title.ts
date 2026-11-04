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

/** Unicode combining marks, stripped after NFD to fold diacritics away. */
const COMBINING_MARK = /\p{M}/gu;

/** Any run of punctuation or whitespace becomes a single separator. */
const SEPARATOR_RUN = /[\p{P}\p{Zs}\s]+/gu;

/**
 * Derives the matching key for one variant text. The native string is never
 * modified; this key is what the uniqueness constraint and the duplicate
 * checks compare.
 */
export function normalizeTitleText(text: string): string {
  return text
    // NFKC first: fullwidth forms, ligatures, and compatibility sequences
    // collapse to their composed plain forms.
    .normalize("NFKC")
    // Diacritic folding: decompose, drop combining marks, recompose. The
    // native string keeps its accents; only the key loses them.
    .normalize("NFD")
    .replace(COMBINING_MARK, "")
    .normalize("NFC")
    // Case fold (lowercase approximates the full fold once the folds that
    // lowercase alone misses are applied first: the Greek final sigma to its
    // medial form, the sharp s to "ss", and the long s to "s" — full case
    // folding expands ß and maps ſ, and so "Straße" and "STRASSE" share a
    // key).
    .replace(/ς/g, "σ")
    .replace(/ß/g, "ss")
    .replace(/ẞ/g, "ss")
    .replace(/ſ/g, "s")
    .toLowerCase()
    .replace(SEPARATOR_RUN, " ")
    .trim();
}
