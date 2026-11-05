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

/** Unicode combining marks, stripped after NFD to fold diacritics away. */
const COMBINING_MARK = /\p{M}/gu;

/** Any run of punctuation or whitespace becomes a single separator. */
const SEPARATOR_RUN = /[\p{P}\p{Zs}\s]+/gu;

/**
 * The declared transliteration table for Russian (BGN/PCGN romanization,
 * which romanizes ё as `yo` and й as `y`). Applied to the NFKC string
 * before the diacritic fold, while the text still carries its case — a
 * letter outside the table's lowercase keys is looked up through its own
 * lowercase form, because the case fold runs after this step anyway; the
 * hard sign `ъ` and the soft sign `ь` contribute nothing to the key.
 */
const RUSSIAN_TRANSLITERATION: Readonly<Record<string, string>> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "yo",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

/** The Cyrillic block the table covers; anything outside it passes through. */
function transliterateDeclared(text: string): string {
  let out = "";
  for (const character of text) {
    out +=
      RUSSIAN_TRANSLITERATION[character] ??
      RUSSIAN_TRANSLITERATION[character.toLowerCase()] ??
      character;
  }
  return out;
}

/**
 * The per-language article lists. The leading article of the declared
 * language drops from the key, so "The Batman" and "Batman" compare equal.
 */
const LEADING_ARTICLES: Readonly<Record<string, readonly string[]>> = {
  en: ["the", "a", "an"],
  // Russian carries no articles; its list stays empty by declaration.
  ru: [],
};

/** Every declared leading article, for a context that names no language. */
const ALL_LEADING_ARTICLES: readonly string[] = [
  ...new Set(Object.values(LEADING_ARTICLES).flat()),
];

/** The language's primary subtag, lowercased ("en-US" → "en"). */
function languageTag(language: string | undefined): string | undefined {
  if (language === undefined || language === "") {
    return undefined;
  }
  return language.split("-")[0]?.toLowerCase();
}

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
export function normalizeForMatching(
  text: string,
  language?: string,
): MatchingNormalization {
  const transliterated = transliterateDeclared(text.normalize("NFKC"));

  const folded = transliterated
    .normalize("NFD")
    .replace(COMBINING_MARK, "")
    .normalize("NFC")
    .replace(/ß/g, "ss")
    .replace(/ẞ/g, "ss")
    .replace(/ſ/g, "s")
    .toLowerCase()
    // After the lowercase, so an uppercase word-final Σ (lowercased to ς)
    // folds onto the medial σ exactly like a typed ς does.
    .replace(/ς/g, "σ")
    .replace(SEPARATOR_RUN, " ")
    .trim();

  const tag = languageTag(language);
  const articles = tag !== undefined ? LEADING_ARTICLES[tag] : undefined;
  return {
    native: text,
    key: stripLeadingArticles(folded, articles ?? ALL_LEADING_ARTICLES),
  };
}

/** The key alone, for comparisons that already hold the native text. */
export function matchingKey(text: string, language?: string): string {
  return normalizeForMatching(text, language).key;
}

/** Drops one leading article token, repeatedly ("The A List" → "a list"). */
function stripLeadingArticles(key: string, articles: readonly string[]): string {
  if (articles.length === 0) {
    return key;
  }
  let tokens = key.split(" ");
  while (tokens.length > 0 && articles.includes(tokens[0])) {
    tokens = tokens.slice(1);
  }
  return tokens.join(" ");
}
