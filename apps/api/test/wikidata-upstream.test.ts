import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WikidataUnavailableError,
  readWikidataEntity,
  searchWikidata,
} from "../src/upstream/wikidata.js";

/**
 * The Wikidata proxy against a stub HTTP server (seam: upstream reachable
 * and unreachable). The wbsearchentities and wbgetentities response shapes
 * below mirror the MediaWiki API's documented wire format.
 */

interface CapturedRequest {
  path: string;
  userAgent: string | undefined;
}

describe("wikidata proxy", () => {
  let server: Server;
  let base: string;
  const captured: CapturedRequest[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      captured.push({
        path: request.url ?? "",
        userAgent: request.headers["user-agent"],
      });
      if (request.url?.includes("action=wbsearchentities")) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            search: [
              {
                id: "Q123",
                label: "Neon City",
                description: "1991 film",
                match: { text: "Neon City", language: "en" },
              },
              {
                id: "Q924",
                label: "Sunset",
                match: { text: "Закат", language: "ru" },
              },
            ],
          }),
        );
        return;
      }
      if (request.url?.includes("action=wbgetentities")) {
        response.setHeader("content-type", "application/json");
        if (request.url.includes("ids=Q999999999")) {
          response.end(JSON.stringify({ entities: {} }));
          return;
        }
        if (request.url.includes("ids=Q777")) {
          // MediaWiki marks an unknown id with a "missing" flag.
          response.end(
            JSON.stringify({ entities: { Q777: { id: "Q777", missing: "" } } }),
          );
          return;
        }
        if (request.url.includes("ids=Q200")) {
          response.end(
            JSON.stringify({
              entities: {
                Q200: {
                  id: "Q200",
                  labels: {
                    en: { language: "en", value: "Neon City" },
                    ru: { language: "ru", value: "Город неона" },
                  },
                  descriptions: { en: { language: "en", value: "1991 film" } },
                },
              },
            }),
          );
          return;
        }
        response.end(
          JSON.stringify({
            entities: {
              Q123: {
                id: "Q123",
                labels: { en: { language: "en", value: "Neon City" } },
                descriptions: { en: { language: "en", value: "1991 film" } },
                claims: {
                  P345: [
                    { mainsnak: { datavalue: { value: "tt0102552" } } },
                  ],
                  P2603: [
                    { mainsnak: { datavalue: { value: "45678" } } },
                  ],
                },
              },
            },
          }),
        );
        return;
      }
      response.statusCode = 500;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("stub server has no port");
    }
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const deps = () => ({
    origin: base,
    userAgent: "Patrol/test (contact: ops@example.test)",
    timeoutMs: 2_000,
  });

  it("passes the query through to wbsearchentities with limit ten and locale, and parses suggestions", async () => {
    const suggestions = await searchWikidata(deps(), {
      query: "neon",
      locale: "en",
    });
    expect(suggestions).toEqual([
      {
        qid: "Q123",
        label: "Neon City",
        description: "1991 film",
      },
      {
        qid: "Q924",
        label: "Sunset",
        // The matched alias the design's suggestion shows, with its language.
        matchedAlias: "Закат",
        matchedAliasLanguage: "ru",
      },
    ]);
    const request = captured.at(-1)!;
    expect(request.path).toContain("action=wbsearchentities");
    expect(request.path).toContain("type=item");
    expect(request.path).toContain("limit=10");
    expect(request.path).toContain("language=en");
    expect(request.path).toContain("search=neon");
    // Wikidata requires identification; the User-Agent must be contactable.
    expect(request.userAgent).toBe("Patrol/test (contact: ops@example.test)");
  });

  it("reads an entity's label, description, and its P345 and P2603 claims", async () => {
    const facts = await readWikidataEntity(deps(), "Q123");
    expect(facts).toEqual({
      qid: "Q123",
      label: "Neon City",
      description: "1991 film",
      identifiers: [
        { scheme: "imdb", value: "tt0102552", property: "P345" },
        { scheme: "kinopoisk", value: "45678", property: "P2603" },
      ],
    });
    expect(captured.at(-1)!.path).toContain("action=wbgetentities");
    expect(captured.at(-1)!.path).toContain("ids=Q123");
  });

  it("reads the label in the caller's language and falls back to English", async () => {
    const russian = await readWikidataEntity(deps(), "Q200", "ru");
    expect(russian).toEqual({
      qid: "Q200",
      label: "Город неона",
      description: "1991 film",
      identifiers: [],
    });
    expect(captured.at(-1)!.path).toContain("languages=ru%7Cen");
    // The label has no German form; the English fallback answers.
    const german = await readWikidataEntity(deps(), "Q200", "de");
    expect(german?.label).toBe("Neon City");
  });

  it("answers null for an entity wikidata does not know, flagged missing or absent", async () => {
    await expect(readWikidataEntity(deps(), "Q999999999")).resolves.toBeNull();
    await expect(readWikidataEntity(deps(), "Q777")).resolves.toBeNull();
  });

  it("throws WikidataUnavailableError when the upstream is unreachable", async () => {
    const dead = { ...deps(), origin: "http://127.0.0.1:1" };
    await expect(
      searchWikidata(dead, { query: "neon", locale: "en" }),
    ).rejects.toBeInstanceOf(WikidataUnavailableError);
    await expect(readWikidataEntity(dead, "Q123")).rejects.toBeInstanceOf(
      WikidataUnavailableError,
    );
  });

  it("throws WikidataUnavailableError on a non-200 answer", async () => {
    const broken = createServer((_request, response) => {
      response.statusCode = 502;
      response.end("bad gateway");
    });
    await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));
    const address = broken.address();
    if (address === null || typeof address === "string") {
      throw new Error("stub server has no port");
    }
    try {
      await expect(
        searchWikidata(
          { origin: `http://127.0.0.1:${address.port}`, userAgent: "u", timeoutMs: 2_000 },
          { query: "x", locale: "en" },
        ),
      ).rejects.toBeInstanceOf(WikidataUnavailableError);
    } finally {
      await new Promise<void>((resolve) => broken.close(() => resolve()));
    }
  });
});
