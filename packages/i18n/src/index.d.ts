import en from "./en.json";
/** The interface languages Patrol ships. Catalogue keys are shared. */
export type Locale = "en" | "ru";
/** A dotted catalogue key, typed from the English source of truth. */
export type MessageKey = keyof typeof en;
/**
 * Looks up one catalogue message. The `code` an API error carries is never
 * localized; only this display text is. A missing key throws rather than
 * rendering a raw key to an operator.
 */
export declare function t(locale: Locale, key: MessageKey): string;
/** The locale automated tests and screenshot baselines fix. */
export declare const TEST_LOCALE: Locale;
