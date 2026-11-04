import { describe, expect, it } from "vitest";
import { en, resolveLanguage, ru, translate } from "../src/i18n";

describe("catalogues", () => {
  it("has the same keys in English and Russian", () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
  });

  it("resolves Russian from a regional Accept-Language header", () => {
    expect(resolveLanguage("ru-RU,ru;q=0.9,en;q=0.8")).toBe("ru");
  });

  it("resolves English from an English header", () => {
    expect(resolveLanguage("en-GB,en;q=0.9")).toBe("en");
  });

  it("falls back to English for an unsupported language", () => {
    expect(resolveLanguage("de-DE,de;q=0.9")).toBe("en");
    expect(resolveLanguage(undefined)).toBe("en");
  });

  it("translates a key in the resolved language", () => {
    expect(translate("ru", "reviewQueue")).not.toBe(en.reviewQueue);
    expect(translate("en", "reviewQueue")).toBe(en.reviewQueue);
  });
});
