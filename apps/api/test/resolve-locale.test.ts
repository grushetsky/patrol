import { describe, expect, it } from "vitest";
import { resolveLocale } from "../src/i18n.js";

/**
 * Implementation-rules "Language resolution": a signed-in operator's stored
 * preference wins, then the request's Accept-Language, then English. The
 * operator preference itself arrives with slice 1's sessions.
 */
describe("locale resolution precedence", () => {
  it("prefers the operator's stored preference over the header", () => {
    expect(resolveLocale("ru", "en-US,en;q=0.9")).toBe("ru");
    expect(resolveLocale("en", "ru")).toBe("en");
  });

  it("falls back to the header when no preference exists", () => {
    expect(resolveLocale(undefined, "ru-RU,ru;q=0.9,en;q=0.8")).toBe("ru");
    expect(resolveLocale(null, "en-GB,en;q=0.9")).toBe("en");
  });

  it("matches a supported primary subtag inside a regional tag", () => {
    expect(resolveLocale(undefined, "ru-RU")).toBe("ru");
    expect(resolveLocale(undefined, "EN-ca")).toBe("en");
  });

  it("picks the highest-quality supported entry", () => {
    expect(resolveLocale(undefined, "fr;q=1.0, ru;q=0.8, en;q=0.5")).toBe("ru");
    expect(resolveLocale(undefined, "fr;q=1.0, en;q=0.5, ru;q=0.4")).toBe("en");
  });

  it("skips entries the header explicitly refuses with q=0", () => {
    expect(resolveLocale(undefined, "ru;q=0, en;q=0.5")).toBe("en");
    expect(resolveLocale(undefined, "en;q=0, ru;q=0")).toBe("en");
  });

  it("answers English when nothing resolves", () => {
    expect(resolveLocale(undefined, undefined)).toBe("en");
    expect(resolveLocale(null, null)).toBe("en");
    expect(resolveLocale(undefined, "")).toBe("en");
    expect(resolveLocale(undefined, "de-DE,fr;q=0.8")).toBe("en");
    expect(resolveLocale(undefined, "*;q=1")).toBe("en");
    expect(resolveLocale(undefined, "garbage;;;=;")).toBe("en");
  });

  it("ignores an unsupported preference and resolves from the header", () => {
    expect(resolveLocale("de" as never, "ru")).toBe("ru");
  });
});
