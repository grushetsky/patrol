import type { Locale } from "@patrol/i18n";

/**
 * The browser-side twin of the API's resolveLocale: the signed-in operator's
 * stored preference wins, then the browser's language, then English. The
 * preference arrives from GET /auth/session; until it loads, the browser's
 * own language stands in.
 */
export function resolveLocale(
  operatorPreference: Locale | null | undefined,
  browserLanguage: string | null | undefined,
): Locale {
  if (operatorPreference === "en" || operatorPreference === "ru") {
    return operatorPreference;
  }
  const primary = (browserLanguage ?? "").split(",")[0].split("-")[0].toLowerCase();
  if (primary === "en" || primary === "ru") {
    return primary;
  }
  return "en";
}
