// The import attributes keep this source loadable by plain Node (the API's
// compiled dist imports this file through the package's default export and
// relies on Node 26 type stripping), not only by vite and vitest.
import en from "./en.json" with { type: "json" };
import ru from "./ru.json" with { type: "json" };

/** The interface languages Patrol ships. Catalogue keys are shared. */
export type Locale = "en" | "ru";

/** A dotted catalogue key, typed from the English source of truth. */
export type MessageKey = keyof typeof en;

type Catalogue = Readonly<Record<MessageKey, string>>;

const catalogues: Readonly<Record<Locale, Catalogue>> = {
  en: en as Catalogue,
  ru: ru as Catalogue,
};

/**
 * Looks up one catalogue message. The `code` an API error carries is never
 * localized; only this display text is. A missing key throws rather than
 * rendering a raw key to an operator.
 */
export function t(locale: Locale, key: MessageKey): string {
  const message = catalogues[locale][key];
  if (message === undefined) {
    throw new Error(`catalogue key ${key} is missing from ${locale}`);
  }
  return message;
}

/** The locale automated tests and screenshot baselines fix. */
export const TEST_LOCALE: Locale = "en";
