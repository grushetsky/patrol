import type { Locale } from "@patrol/i18n";

/** The interface languages the API can resolve a request to. */
const SUPPORTED: readonly Locale[] = ["en", "ru"];

function isSupported(tag: string | null | undefined): tag is Locale {
  return tag === "en" || tag === "ru";
}

interface AcceptLanguageEntry {
  /** The entry's language tag, lowercased ("ru-ru"). */
  tag: string;
  quality: number;
}

/**
 * Parses an Accept-Language header into quality-ordered entries. Malformed
 * entries score zero and never win; "*" carries no language and is dropped.
 */
function parseAcceptLanguage(header: string): AcceptLanguageEntry[] {
  return header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      let quality = 1;
      for (const param of params) {
        const [key, value] = param.trim().split("=");
        if (key === "q" && value !== undefined) {
          const parsed = Number.parseFloat(value);
          quality = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0;
        }
      }
      return { tag: (tag ?? "").trim().toLowerCase(), quality };
    })
    .filter((entry) => entry.tag !== "" && entry.tag !== "*" && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality);
}

/**
 * Resolves one request's interface language (implementation-rules "Language
 * resolution"): a signed-in operator's stored preference wins, then the
 * request's Accept-Language, then English. Slice 1 feeds the preference from
 * the operator account; until then callers pass undefined.
 */
export function resolveLocale(
  operatorPreference?: Locale | null,
  acceptLanguageHeader?: string | null,
): Locale {
  if (isSupported(operatorPreference)) {
    return operatorPreference;
  }
  for (const entry of parseAcceptLanguage(acceptLanguageHeader ?? "")) {
    const primary = entry.tag.split("-")[0];
    if (isSupported(primary)) {
      return primary;
    }
  }
  return "en";
}
