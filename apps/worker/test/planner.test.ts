import { describe, expect, it } from "vitest";
import { normalizeTitle as apiNormalize } from "../../api/src/catalogue/normalize.js";
import {
  buildQueryPlan,
  territoryForLocale,
} from "../src/acquisition/planner.js";
import { normalizeTitle } from "../src/acquisition/normalize.js";

describe("query planner", () => {
  it("orders eligible variants and adds two intent queries per locale", () => {
    const plan = buildQueryPlan({
      engine: "google",
      locales: ["ru-RU", "en-US"],
      intents: {
        ru: [
          { text: "смотреть онлайн", version: 1 },
          { text: "скачать", version: 1 },
        ],
        en: [
          { text: "watch online", version: 2 },
          { text: "download", version: 2 },
        ],
      },
      titles: [
        {
          id: "title-1",
          displayTitle: "Ирония судьбы",
          variants: [
            {
              id: "v1",
              text: "Ирония судьбы",
              kind: "original",
              language: "ru-RU",
            },
            {
              id: "v2",
              text: "The Irony of Fate",
              kind: "localized",
              language: "en-US",
            },
            {
              id: "v3",
              text: "Ironiya sudby",
              kind: "transliterated",
              language: "en-US",
            },
            {
              id: "v4",
              text: "Alternate name",
              kind: "alternate",
              language: "en-US",
            },
          ],
        },
      ],
      now: new Date("2026-11-04T03:00:00Z"),
    });

    expect(plan.queries).toHaveLength(6);
    expect(
      plan.queries.map((query) => `${query.locale}:${query.kind}:${query.text}`),
    ).toEqual([
      "ru-RU:variant:Ирония судьбы",
      "ru-RU:intent:Ирония судьбы смотреть онлайн",
      "ru-RU:intent:Ирония судьбы скачать",
      "en-US:variant:The Irony of Fate",
      "en-US:intent:Ирония судьбы watch online",
      "en-US:intent:Ирония судьбы download",
    ]);
    expect(plan.queries[4].intentPhrase).toEqual({
      text: "watch online",
      version: 2,
    });
    expect(plan.generatedAt).toBe("2026-11-04T03:00:00.000Z");
  });

  it("deduplicates the same normalized text inside one plan", () => {
    const plan = buildQueryPlan({
      engine: "google",
      locales: ["ru-RU"],
      intents: { ru: [{ text: "смотреть онлайн", version: 1 }] },
      titles: [
        {
          id: "title-1",
          displayTitle: "СAME TITLE",
          variants: [
            {
              id: "v1",
              text: "Same Title",
              kind: "original",
              language: "ru-RU",
            },
            {
              id: "v2",
              text: "same   TITLE",
              kind: "localized",
              language: "ru-RU",
            },
          ],
        },
      ],
      now: new Date("2026-11-04T03:00:00Z"),
    });

    expect(plan.queries.filter((query) => query.kind === "variant")).toHaveLength(
      1,
    );
  });

  it("applies the Google and Yandex length caps at a word boundary", () => {
    const long = "word ".repeat(600).trim();
    const google = buildQueryPlan({
      engine: "google",
      locales: ["ru-RU"],
      intents: { ru: [{ text: "смотреть онлайн", version: 1 }] },
      titles: [
        {
          id: "title-1",
          displayTitle: long,
          variants: [
            { id: "v1", text: long, kind: "original", language: "ru-RU" },
          ],
        },
      ],
      now: new Date("2026-11-04T03:00:00Z"),
    });
    const yandex = buildQueryPlan({
      engine: "yandex",
      locales: ["ru-RU"],
      intents: { ru: [{ text: "смотреть онлайн", version: 1 }] },
      titles: [
        {
          id: "title-1",
          displayTitle: long,
          variants: [
            { id: "v1", text: long, kind: "original", language: "ru-RU" },
          ],
        },
      ],
      now: new Date("2026-11-04T03:00:00Z"),
    });

    expect(google.queries.every((query) => query.text.length <= 2_048)).toBe(
      true,
    );
    expect(yandex.queries.every((query) => query.text.length <= 400)).toBe(true);
    expect(yandex.queries[0].text.endsWith("word")).toBe(true);
    expect(yandex.queries[0].text.endsWith(" ")).toBe(false);
  });

  it("removes quotation marks and search operators", () => {
    const plan = buildQueryPlan({
      engine: "google",
      locales: ["en-US"],
      intents: {},
      titles: [
        {
          id: "title-1",
          displayTitle: '"The Movie" site:example.test',
          variants: [
            {
              id: "v1",
              text: '"The Movie" site:example.test -bad',
              kind: "original",
              language: "en-US",
            },
          ],
        },
      ],
      now: new Date("2026-11-04T03:00:00Z"),
    });

    expect(plan.queries[0].text).toBe("The Movie");
  });

  it("maps a locale to its search territory", () => {
    expect(territoryForLocale("ru-RU")).toBe("RU");
    expect(territoryForLocale("en-US")).toBe("US");
    expect(territoryForLocale("ru")).toBe("RU");
    expect(territoryForLocale("en")).toBe("US");
    expect(territoryForLocale("ja-JP")).toBe("JP");
    expect(territoryForLocale("fr")).toBeUndefined();
  });
});

describe("normalizer parity", () => {
  it("derives the same key as the catalogue", () => {
    const samples: Array<[string, string]> = [
      ["Ирония судьбы", "ru-RU"],
      ["The Irony of Fate", "en-US"],
      ["  The   MATRIX! ", "en-US"],
      ["Amélie", "fr-FR"],
      ["Die Welle", "de-DE"],
    ];

    for (const [text, language] of samples) {
      expect(normalizeTitle(text, language)).toBe(apiNormalize(text, language));
    }
  });
});
