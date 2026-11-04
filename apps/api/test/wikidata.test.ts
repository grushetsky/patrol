import { afterEach, describe, expect, it, vi } from "vitest";
import { WikidataClient } from "../src/catalogue/wikidata.js";

function respond(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Wikidata client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports an alias only when the match was an alias", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        respond({
          search: [
            {
              id: "Q1",
              label: "The Matrix",
              match: { type: "label", language: "en", text: "The Matrix" },
            },
            {
              id: "Q2",
              label: "The Matrix Reloaded",
              match: { type: "alias", language: "en", text: "Reloaded" },
            },
          ],
        }),
      ),
    );

    const client = new WikidataClient("https://wikidata.test", "PatrolTest/1.0", 0);
    const suggestions = await client.search("matrix", "en-US");

    expect(suggestions[0].matchedAlias).toBeUndefined();
    expect(suggestions[1]).toMatchObject({
      matchedAlias: "Reloaded",
      matchedAliasLanguage: "en",
    });
  });

  it("reads IMDb and KinoPoisk claims from the selected entity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        respond({
          entities: {
            Q1: {
              labels: { en: { value: "The Matrix" } },
              descriptions: { en: { value: "1999 film" } },
              claims: {
                P345: [{ mainsnak: { datavalue: { value: "tt0133093" } } }],
                P2603: [{ mainsnak: { datavalue: { value: "301" } } }],
              },
            },
          },
        }),
      ),
    );

    const client = new WikidataClient("https://wikidata.test", "PatrolTest/1.0", 0);
    const entity = await client.entity("Q1");

    expect(entity).toEqual({
      qid: "Q1",
      label: "The Matrix",
      description: "1999 film",
      identifiers: [
        { scheme: "imdb", value: "tt0133093", property: "P345" },
        { scheme: "kinopoisk", value: "301", property: "P2603" },
      ],
    });
  });

  it("skips the remote lookup below three characters", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = new WikidataClient("https://wikidata.test", "PatrolTest/1.0", 0);
    expect(await client.search("ab", "en-US")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
