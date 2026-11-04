const ARTICLES: Record<string, Record<string, true>> = {
  en: { the: true, a: true, an: true },
  de: { der: true, die: true, das: true, ein: true, eine: true },
  es: { el: true, la: true, los: true, las: true, un: true, una: true },
  fr: { le: true, la: true, les: true, l: true, un: true, une: true },
  it: {
    il: true,
    lo: true,
    la: true,
    i: true,
    gli: true,
    le: true,
    un: true,
    uno: true,
    una: true,
  },
  nl: { de: true, het: true, een: true },
  pt: { o: true, a: true, os: true, as: true, um: true, uma: true },
};

const ALL_ARTICLES: Record<string, true> = Object.assign(
  {},
  ...Object.values(ARTICLES),
);

// The declared transliteration scheme. Every Cyrillic letter maps to a Latin
// sequence; the native string stays untouched beside the derived key.
const CYRILLIC: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "i",
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
  і: "i",
  ї: "yi",
  є: "ye",
  ґ: "g",
};

/**
 * The matching key of a title: NFKC, case folding, diacritic folding, the
 * declared transliteration, punctuation and whitespace collapse, and a
 * language's leading article removed. The native text is never modified.
 */
export function normalizeTitle(text: string, language?: string): string {
  let value = text.normalize("NFKC").toLowerCase();
  value = value.replaceAll("ß", "ss").replaceAll("ς", "σ");

  let transliterated = "";
  for (const character of value) {
    transliterated += CYRILLIC[character] ?? character;
  }
  value = transliterated;

  value = value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFC");

  const tokens = value
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const languageBase = language?.split("-")[0]?.toLowerCase();
  const articles = languageBase ? ARTICLES[languageBase] : undefined;
  if (articles && tokens.length > 1 && articles[tokens[0]]) {
    tokens.shift();
  }

  return tokens.join(" ");
}

/**
 * A key for free-text search, where the query's language is unknown. It strips
 * a leading article from any supported language after the usual normalization.
 */
export function searchKey(text: string, language?: string): string {
  const tokens = normalizeTitle(text, language).split(" ").filter(Boolean);
  if (tokens.length > 1 && ALL_ARTICLES[tokens[0]]) {
    tokens.shift();
  }
  return tokens.join(" ");
}

/** A URL slug as a title-like key, so `the-matrix-1999` matches `The Matrix`. */
export function normalizeSlug(slug: string): string {
  let decoded = slug;
  try {
    decoded = decodeURIComponent(slug);
  } catch {
    // A malformed escape is matched as written.
  }
  return normalizeTitle(decoded.replace(/[-_+/]+/g, " "));
}
