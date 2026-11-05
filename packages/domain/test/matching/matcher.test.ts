import { describe, expect, it } from "vitest";
import { bestVariantMatch, matchVariant } from "../../src/matching/matcher.js";

/**
 * Seam 2, against docs/design/matching-and-classification-rules.md "Title
 * match". The scores 0.70, 0.60, and 0.00 are the document's table, copied:
 *
 * | Exact variant | 0.70 | Equals or occurs as a complete token sequence in
 *   the page title, h1, or structured-data name. |
 * | Partial or slug | 0.60 | Occurs in the URL slug, or as a substring with
 *   extra tokens in the title or h1. |
 * | None | 0.00 | No variant occurs on the page. |
 */

const VARIANT = { id: "v1", text: "Sunrise", language: "en" };

describe("an exact variant match (0.70)", () => {
  it("equals the page title", () => {
    expect(matchVariant(VARIANT, { pageTitle: "Sunrise" })).toMatchObject({
      kind: "exact",
      score: 0.70,
    });
  });

  it("occurs as a complete token sequence inside the page title", () => {
    expect(
      matchVariant(VARIANT, { pageTitle: "Sunrise (2024) — Watch Online HD" }),
    ).toMatchObject({ kind: "exact", score: 0.70 });
  });

  it("occurs as a complete token sequence inside an h1", () => {
    expect(matchVariant(VARIANT, { h1s: ["Watch Sunrise free"] })).toMatchObject(
      { kind: "exact", score: 0.70 },
    );
  });

  it("occurs as a complete token sequence inside a structured-data name", () => {
    expect(
      matchVariant(VARIANT, { structuredNames: ["Sunrise — full movie"] }),
    ).toMatchObject({ kind: "exact", score: 0.70 });
  });

  it("folds case, diacritics, and a leading article before comparing", () => {
    expect(
      matchVariant(
        { id: "v1", text: "The Café", language: "en" },
        { pageTitle: "CAFE (2024)" },
      ),
    ).toMatchObject({ kind: "exact", score: 0.70 });
  });

  it("matches a transliterated page title against the Cyrillic variant", () => {
    expect(
      matchVariant(
        { id: "v1", text: "Рассвет", language: "ru" },
        { pageTitle: "Rassvet (2024) — smotret online" },
      ),
    ).toMatchObject({ kind: "exact", score: 0.70 });
  });

  it("matches a multi-token variant as a contiguous token run", () => {
    expect(
      matchVariant(
        { id: "v1", text: "Far From Home", language: "en" },
        { pageTitle: "Watch Far From Home (2019) online" },
      ),
    ).toMatchObject({ kind: "exact", score: 0.70 });
  });
});

describe("a variant inside a word is not an exact match", () => {
  it("a substring inside one word of the title stays partial", () => {
    expect(
      matchVariant(VARIANT, { pageTitle: "SunriseOnline — watch free" }),
    ).toMatchObject({ kind: "partial", score: 0.60 });
  });

  it("a token run broken by other tokens does not occur at all", () => {
    expect(
      matchVariant(
        { id: "v1", text: "Far From Home", language: "en" },
        { pageTitle: "Far From The Home online" },
      ),
    ).toMatchObject({ kind: "none", score: 0.00 });
  });
});

describe("a partial or slug match (0.60)", () => {
  it("occurs in the URL slug", () => {
    expect(
      matchVariant(VARIANT, {
        url: "https://stream.example.test/movies/sunrise-2024-full-hd",
      }),
    ).toMatchObject({ kind: "partial", score: 0.60 });
  });

  it("occurs in the URL slug across a Cyrillic variant", () => {
    expect(
      matchVariant(
        { id: "v1", text: "Рассвет", language: "ru" },
        { url: "https://stream.example.test/films/rassvet-2024" },
      ),
    ).toMatchObject({ kind: "partial", score: 0.60 });
  });

  it("a substring of the title with extra tokens around it", () => {
    expect(
      matchVariant(VARIANT, { pageTitle: "NewSunrise cut — watch now" }),
    ).toMatchObject({ kind: "partial", score: 0.60 });
  });

  it("an exact beat in one source outranks a partial in another", () => {
    expect(
      matchVariant(VARIANT, {
        pageTitle: "Newsunrise hub",
        h1s: ["Sunrise"],
      }),
    ).toMatchObject({ kind: "exact", score: 0.70 });
  });
});

describe("no variant occurs (0.00)", () => {
  it("an unrelated page and URL", () => {
    expect(
      matchVariant(VARIANT, {
        pageTitle: "Moonlight streaming",
        h1s: ["Watch Moonlight"],
        structuredNames: ["Moonlight"],
        url: "https://other.example.test/watch/moonlight-1080p",
      }),
    ).toMatchObject({ kind: "none", score: 0.00 });
  });

  it("a slug fragment that does not contain the variant key", () => {
    expect(
      matchVariant(VARIANT, {
        url: "https://other.example.test/watch/moonrise-club",
      }),
    ).toMatchObject({ kind: "none", score: 0.00 });
  });
});

describe("the best match across a title's variants", () => {
  const variants = [
    { id: "original", text: "Рассвет", language: "ru" },
    { id: "localized", text: "Sunrise", language: "en" },
  ];

  it("picks the exact match and names its variant", () => {
    expect(
      bestVariantMatch(variants, { pageTitle: "Sunrise (2024)" }),
    ).toMatchObject({ kind: "exact", score: 0.70, variantId: "localized" });
  });

  it("falls back to the best score available", () => {
    expect(
      bestVariantMatch(variants, {
        url: "https://stream.example.test/films/rassvet-2024",
      }),
    ).toMatchObject({ kind: "partial", score: 0.60, variantId: "original" });
  });

  it("reports none when no variant occurs", () => {
    expect(
      bestVariantMatch(variants, { pageTitle: "Moonlight" }),
    ).toMatchObject({ kind: "none", score: 0.00, variantId: null });
  });

  it("a machine translation of the title is never a match", () => {
    // The page says "Dawn" — a translation, not a catalogue variant.
    expect(
      bestVariantMatch(variants, { pageTitle: "Dawn (2024)" }),
    ).toMatchObject({ kind: "none", score: 0.00 });
  });
});
