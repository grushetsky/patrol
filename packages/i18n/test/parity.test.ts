import { describe, expect, it } from "vitest";
import en from "../src/en.json";
import ru from "../src/ru.json";
import { TEST_LOCALE, t, type MessageKey } from "../src/index";

/**
 * Implementation-rules "Language" row: every operator-facing string exists in
 * both languages, enforced by a key-parity test. Automated tests fix English.
 */
describe("catalogue key parity", () => {
  it("holds every English key in the Russian catalogue", () => {
    const missingInRu = Object.keys(en).filter((key) => !(key in ru));
    expect(missingInRu).toEqual([]);
  });

  it("holds every Russian key in the English catalogue", () => {
    const missingInEn = Object.keys(ru).filter((key) => !(key in en));
    expect(missingInEn).toEqual([]);
  });

  it("keeps both key sets exactly identical", () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
  });

  it("carries a non-empty message for every key in both locales", () => {
    for (const key of Object.keys(en)) {
      expect(typeof en[key as MessageKey]).toBe("string");
      expect(en[key as MessageKey].length).toBeGreaterThan(0);
      expect(typeof ru[key as MessageKey]).toBe("string");
      expect(ru[key as MessageKey].length).toBeGreaterThan(0);
    }
  });

  it("resolves a known key through t() in the fixed test locale", () => {
    expect(t(TEST_LOCALE, "errors.not_found")).toBe(en["errors.not_found"]);
  });

  it("resolves a known key in Russian too", () => {
    expect(t("ru", "errors.not_found")).toBe(ru["errors.not_found"]);
  });
});
