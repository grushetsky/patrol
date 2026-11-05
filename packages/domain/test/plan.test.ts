import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTENT_PHRASES,
  QUERY_LENGTH_CAPS,
  buildPlan,
  eligibleVariants,
  languageOf,
  localeRequestParams,
  pricePlan,
  sanitizeQueryText,
  truncateAtWordBoundary,
  type PlanTitle,
  type PlanVariant,
} from "../src/index.js";

function variant(
  id: string,
  text: string,
  kind: PlanVariant["kind"],
  language: string,
): PlanVariant {
  return { id, text, kind, language };
}

function title(
  id: string,
  original: PlanVariant,
  ...more: PlanVariant[]
): PlanTitle {
  return { id, originalVariant: original, variants: [original, ...more] };
}

const SUNRISE = variant("v-orig", "Sunrise", "original", "en");
const SUNRISE_TITLE = title("t-1", SUNRISE);

describe("eligible variants", () => {
  it("always admits the original variant whatever its language", () => {
    const original = variant("v-orig", "Рассвет", "original", "ru");
    const group = title("t-1", original);
    expect(
      eligibleVariants(group, "en").map((entry) => entry.id),
    ).toEqual(["v-orig"]);
  });

  it("admits a non-original variant only when its language matches the locale", () => {
    const localized = variant("v-loc", "L'Aube", "localized", "fr");
    const translit = variant("v-tr", "Rassvet", "transliterated", "en");
    const group = title("t-1", variant("v-orig", "Рассвет", "original", "ru"), localized, translit);
    expect(
      eligibleVariants(group, "en").map((entry) => entry.id),
    ).toEqual(["v-orig", "v-tr"]);
    expect(
      eligibleVariants(group, "fr").map((entry) => entry.id),
    ).toEqual(["v-orig", "v-loc"]);
  });

  it("orders original, localized, transliterated and caps at three", () => {
    const group = title(
      "t-1",
      variant("v-orig", "Рассвет", "original", "ru"),
      variant("v-tr-1", "Rassvet", "transliterated", "ru"),
      variant("v-loc-1", "Dawn", "localized", "ru"),
      variant("v-tr-2", "Rassvet Filma", "transliterated", "ru"),
      variant("v-loc-2", "Aube", "localized", "ru"),
    );
    expect(
      eligibleVariants(group, "ru").map((entry) => entry.id),
    ).toEqual(["v-orig", "v-loc-1", "v-loc-2"]);
  });
});

describe("buildPlan", () => {
  it("derives bare variant queries plus two versioned intent queries per locale", () => {
    const plan = buildPlan({
      engine: "google",
      locales: ["en"],
      titles: [SUNRISE_TITLE],
    });
    expect(plan.queries).toEqual([
      {
        trackedTitleId: "t-1",
        locale: "en",
        kind: "variant",
        text: "Sunrise",
        variantId: "v-orig",
      },
      {
        trackedTitleId: "t-1",
        locale: "en",
        kind: "intent",
        text: "Sunrise watch online",
        intentPhrase: { text: "watch online", version: 1 },
      },
      {
        trackedTitleId: "t-1",
        locale: "en",
        kind: "intent",
        text: "Sunrise download",
        intentPhrase: { text: "download", version: 1 },
      },
    ]);
  });

  it("uses the configured intent phrases and their versions, not the defaults", () => {
    const plan = buildPlan({
      engine: "yandex",
      locales: ["ru-RU"],
      titles: [title("t-1", variant("v-orig", "Рассвет", "original", "ru"))],
      intentPhrases: {
        ru: [
          { text: "бесплатно в хорошем качестве", version: 4 },
          { text: "торрент", version: 2 },
        ],
      },
    });
    expect(plan.queries.map((query) => query.intentPhrase)).toEqual([
      undefined,
      { text: "бесплатно в хорошем качестве", version: 4 },
      { text: "торрент", version: 2 },
    ]);
    expect(plan.queries[1].text).toBe("Рассвет бесплатно в хорошем качестве");
  });

  it("deduplicates queries by normalized text within one plan", () => {
    // The localized variant repeats the display title for its own locale:
    // one query, not two.
    const group = title(
      "t-1",
      variant("v-orig", "Sunrise", "original", "en"),
      variant("v-loc", "SUNRISE!", "localized", "en"),
    );
    const plan = buildPlan({ engine: "google", locales: ["en"], titles: [group] });
    expect(plan.queries.filter((query) => query.kind === "variant")).toHaveLength(1);
    // The plan never repeats the same text, even across two locales: the
    // query is issued once, under the first locale that produced it.
    const twoLocales = buildPlan({
      engine: "google",
      locales: ["en", "en-US"],
      titles: [SUNRISE_TITLE],
    });
    expect(
      twoLocales.queries.filter((query) => query.kind === "variant"),
    ).toHaveLength(1);
  });

  it("never issues a query carrying quotes or a search operator", () => {
    const nasty = title(
      "t-1",
      variant("v-orig", '"Sunrise" -site:ok.ru official: page', "original", "en"),
      variant("v-loc", "Sun't+itle inurl:watch", "localized", "en"),
    );
    const plan = buildPlan({ engine: "google", locales: ["en"], titles: [nasty] });
    expect(plan.queries.length).toBeGreaterThan(0);
    for (const query of plan.queries) {
      expect(query.text).not.toMatch(/["'“”‘’«»]/);
      expect(query.text).not.toMatch(/(^|\s)[-+]/);
      expect(query.text).not.toMatch(/(^|\s)[A-Za-z0-9_]+:/);
      expect(query.text).not.toContain("site:");
    }
    // A hyphen inside a word is a title's own punctuation, not an operator.
    expect(sanitizeQueryText("Spider-Man Returns")).toBe("Spider-Man Returns");
  });

  it("drops the intent phrase before truncating, and truncates at a word boundary", () => {
    const longTitle = "A".repeat(QUERY_LENGTH_CAPS.yandex - 5); // 395 chars
    const group = title("t-1", variant("v-orig", longTitle, "original", "en"));
    const plan = buildPlan({ engine: "yandex", locales: ["en"], titles: [group] });
    const variantQuery = plan.queries.find((query) => query.kind === "variant")!;
    const intentQuery = plan.queries.find((query) => query.kind === "intent")!;
    // The variant itself fits and is untouched.
    expect(variantQuery.text).toBe(longTitle);
    // The combined intent text is over the cap, so the phrase is dropped and
    // the query deduplicates against the bare variant.
    expect(intentQuery).toBeUndefined();

    const overlong = "W".repeat(QUERY_LENGTH_CAPS.yandex + 25);
    const overGroup = title("t-1", variant("v-orig", overlong, "original", "en"));
    const capped = buildPlan({ engine: "yandex", locales: ["en"], titles: [overGroup] });
    for (const query of capped.queries) {
      expect(query.text.length).toBeLessThanOrEqual(QUERY_LENGTH_CAPS.yandex);
    }
    // Truncation lands on a word boundary when one exists.
    expect(truncateAtWordBoundary("one two three four", 11)).toBe("one two");
  });

  it("respects the Google cap of 2048 and the Yandex cap of 400", () => {
    const huge = "x".repeat(QUERY_LENGTH_CAPS.google + 100);
    const google = buildPlan({
      engine: "google",
      locales: ["en"],
      titles: [title("t-1", variant("v-orig", huge, "original", "en"))],
    });
    for (const query of google.queries) {
      expect(query.text.length).toBeLessThanOrEqual(2048);
    }
  });
});

describe("pricePlan", () => {
  it("prices a Google plan at two units per depth-20 query", () => {
    const plan = buildPlan({ engine: "google", locales: ["en"], titles: [SUNRISE_TITLE] });
    expect(pricePlan("google", plan)).toBe(6);
  });

  it("prices a Yandex plan at one unit per request", () => {
    const plan = buildPlan({ engine: "yandex", locales: ["en"], titles: [SUNRISE_TITLE] });
    expect(pricePlan("yandex", plan)).toBe(3);
  });
});

describe("locale mapping", () => {
  it("maps ru to Russia, SEARCH_TYPE_RU, region 225, territory RU", () => {
    expect(localeRequestParams("ru")).toEqual({
      language: "ru",
      google: { languageCode: "ru", locationName: "Russia" },
      yandex: { l10n: "ru", searchType: "SEARCH_TYPE_RU", region: 225 },
      territory: "RU",
    });
  });

  it("maps en to the United States, SEARCH_TYPE_COM, no region, territory US", () => {
    expect(localeRequestParams("en")).toEqual({
      language: "en",
      google: { languageCode: "en", locationName: "United States" },
      yandex: { l10n: "en", searchType: "SEARCH_TYPE_COM" },
      territory: "US",
    });
  });

  it("derives the language from the locale's primary subtag", () => {
    expect(languageOf("ru-RU")).toBe("ru");
    expect(languageOf("en-US")).toBe("en");
  });
});

describe("default intent phrases", () => {
  it("seeds two phrases per supported locale", () => {
    expect(DEFAULT_INTENT_PHRASES.ru.map((phrase) => phrase.text)).toEqual([
      "смотреть онлайн",
      "скачать",
    ]);
    expect(DEFAULT_INTENT_PHRASES.en.map((phrase) => phrase.text)).toEqual([
      "watch online",
      "download",
    ]);
  });
});
