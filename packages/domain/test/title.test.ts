import { describe, expect, it } from "vitest";
import { normalizeTitleText } from "../src/title.js";

/**
 * The storage normalizer behind the uniqueness invariant ("A title
 * variant's text is unique within its tracked title after normalization").
 * The transforms are the catalogue design's list — NFKC, case fold,
 * diacritic folding, punctuation and whitespace collapse — with the
 * expected keys written by hand from those rules.
 */
describe("normalizeTitleText", () => {
  it("case folds and collapses punctuation and whitespace", () => {
    expect(normalizeTitleText("Hello,  World!")).toBe("hello world");
    expect(normalizeTitleText("der   Weg")).toBe("der weg");
  });

  it("applies NFKC compatibility folding, so fullwidth and ligature twins collapse", () => {
    // Fullwidth latin collapses to ascii; the ﬁ ligature collapses to fi.
    expect(normalizeTitleText("ＭＯＶＩＥ")).toBe("movie");
    expect(normalizeTitleText("ﬁle")).toBe("file");
  });

  it("folds diacritics away while the native string stays untouched elsewhere", () => {
    expect(normalizeTitleText("Léon")).toBe("leon");
    expect(normalizeTitleText("Übereinstimmung")).toBe("ubereinstimmung");
  });

  it("case folds non-latin scripts", () => {
    expect(normalizeTitleText("ΣΊΣΥΦΟΣ")).toBe("σισυφος");
    // Ы is not a mark, but Ё decomposes to е + diaeresis and the fold drops
    // the diaeresis: the key loses the mark, the native string keeps it.
    expect(normalizeTitleText("Ёлка")).toBe("елка");
  });

  it("expands the sharp s and folds the long s, so Straße and STRASSE share a key", () => {
    expect(normalizeTitleText("Straße")).toBe(normalizeTitleText("STRASSE"));
    expect(normalizeTitleText("Straße")).toBe("strasse");
    expect(normalizeTitleText("STRAẞE")).toBe("strasse");
    // The long s (U+017F) folds to s under full case folding.
    expect(normalizeTitleText(" ſin")).toBe("sin");
  });

  it("treats a run of any punctuation or whitespace as one separator", () => {
    expect(normalizeTitleText("Matrix — Reloaded… (2003)")).toBe(
      "matrix reloaded 2003",
    );
  });

  it("trims leading and trailing separators", () => {
    expect(normalizeTitleText("  Amélie  ")).toBe("amelie");
  });

  it("keeps digits and interior apostrophe-free letters intact", () => {
    expect(normalizeTitleText("2001: A Space Odyssey")).toBe(
      "2001 a space odyssey",
    );
  });
});
