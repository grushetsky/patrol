import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, poolSchemaStamp, testConfig } from "../test-app.js";
import { MemoryMailTransport } from "../../src/mail/transport.js";
import {
  authHeaders,
  ceremonyApp,
  signedInAdministrator,
  type CeremonyApp,
  type SignedInOperator,
} from "./ceremony.js";

/**
 * Seam 6 (route half) and seam 12: the add-title field's two indexes. A
 * Wikidata failure never blocks local suggestions or free-text creation
 * (the wikidata route alone answers 503 upstream_unavailable), and the
 * local index ranks exact matches first, prefixes second, containments
 * last — the documented ranking choice until slice 5's scorer replaces it.
 */
describe("catalogue search", () => {
  let world: CeremonyApp;
  let admin: SignedInOperator;
  let groupId: string;
  let stub: Server;
  let stubBase: string;
  let wikidataApp: FastifyInstance;
  let lastStubUrl = "";

  beforeAll(async () => {
    world = await ceremonyApp();
    admin = await signedInAdministrator(world, "admin@example.test");
    const group = await world.app.inject({
      method: "POST",
      url: "/api/title-groups",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        name: "Search group",
        locales: ["en"],
        scanTime: "02:45:00Z",
        priority: "normal",
      },
    });
    groupId = group.json().id;

    // Three titles whose normalized texts sit at the three ranks: an exact
    // key, a key that starts with the query, and a key that merely contains
    // it mid-string.
    await createTitle("Neon City", 1991);
    await createTitle("Neon City Lights", 1992);
    await createTitle("Chronicles of Neon City", 1993);

    stub = createServer((request, response) => {
      lastStubUrl = request.url ?? "";
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          search: [
            {
              id: "Q55",
              label: "Neon City",
              description: "1991 film",
              match: { text: "Neon City", language: "en" },
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const address = stub.address();
    if (address === null || typeof address === "string") {
      throw new Error("stub server has no port");
    }
    stubBase = `http://127.0.0.1:${address.port}`;
    wikidataApp = await buildApp({
      config: testConfig({ now: world.clock.now, wikidataOrigin: stubBase }),
      pool: world.pool,
      mail: new MemoryMailTransport(),
      schemaStamp: poolSchemaStamp(world.pool),
    });
  });

  afterAll(async () => {
    await wikidataApp.close();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    await world.app.close();
    await world.pool.end();
  });

  async function createTitle(text: string, year: number) {
    const created = await world.app.inject({
      method: "POST",
      url: "/api/titles",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        titleGroupId: groupId,
        originalVariant: { text, language: "en", script: "Latn" },
        releaseYear: year,
        titleType: "film",
        additionalVariants: [],
        externalIdentifiers: [],
        source: "operator_knowledge",
      },
    });
    expect(created.statusCode).toBe(201);
    return created.json();
  }

  it("ranks the local index exact, prefix, then containment, and always offers creation", async () => {
    const result = await world.app.inject({
      method: "GET",
      url: "/api/catalogue/suggestions?query=neon%20city",
      headers: { cookie: admin.cookie },
    });
    expect(result.statusCode).toBe(200);
    const body = result.json();
    expect(body.createProposal).toBe("neon city");
    expect(
      body.suggestions.map((s: { displayTitle: string }) => s.displayTitle),
    ).toEqual(["Neon City", "Neon City Lights", "Chronicles of Neon City"]);
    // Each suggestion carries the fields the design's row shows.
    expect(body.suggestions[0]).toMatchObject({
      displayTitle: "Neon City",
      releaseYear: 1991,
      titleType: "film",
      titleGroupName: "Search group",
    });
    expect(body.suggestions[0].matchedVariant).toMatchObject({
      text: "Neon City",
      kind: "original",
      language: "en",
      script: "Latn",
    });
  });

  it("passes wikidata suggestions through with limit ten and the locale", async () => {
    const result = await wikidataApp.inject({
      method: "GET",
      url: "/api/catalogue/wikidata-suggestions?query=neon&locale=en",
      headers: { cookie: admin.cookie },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().suggestions).toEqual([
      {
        qid: "Q55",
        label: "Neon City",
        description: "1991 film",
      },
    ]);
    // The stub saw limit=10 and the locale, and was asked serially.
    expect(lastStubUrl).toContain("action=wbsearchentities");
    expect(lastStubUrl).toContain("limit=10");
    expect(lastStubUrl).toContain("language=en");
  });

  it("answers 503 upstream_unavailable when wikidata is unreachable, while local suggestions still work", async () => {
    const dead = await buildApp({
      config: testConfig({
        now: world.clock.now,
        wikidataOrigin: "http://127.0.0.1:1",
        upstreamTimeoutMs: 500,
      }),
      pool: world.pool,
      mail: new MemoryMailTransport(),
      schemaStamp: poolSchemaStamp(world.pool),
    });
    try {
      const unreachable = await dead.inject({
        method: "GET",
        url: "/api/catalogue/wikidata-suggestions?query=neon&locale=en",
        headers: { cookie: admin.cookie },
      });
      expect(unreachable.statusCode).toBe(503);
      expect(unreachable.json().code).toBe("upstream_unavailable");

      // Local suggestions and free-text creation never depend on Wikidata.
      const local = await dead.inject({
        method: "GET",
        url: "/api/catalogue/suggestions?query=neon",
        headers: { cookie: admin.cookie },
      });
      expect(local.statusCode).toBe(200);
      expect(local.json().suggestions.length).toBeGreaterThan(0);

      const created = await dead.inject({
        method: "POST",
        url: "/api/titles",
        headers: { "content-type": "application/json", ...authHeaders(admin) },
        payload: {
          titleGroupId: groupId,
          originalVariant: { text: "Offline Creation", language: "en", script: "Latn" },
          releaseYear: 2020,
          titleType: "other",
          additionalVariants: [],
          externalIdentifiers: [],
          source: "operator_knowledge",
        },
      });
      expect(created.statusCode).toBe(201);
    } finally {
      await dead.close();
    }
  });

  it("reads a wikidata entity's identifier claims, and refuses a malformed qid", async () => {
    const entityRequests: string[] = [];
    const entity = createServer((request, response) => {
      entityRequests.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      if (request.url?.includes("ids=Q123")) {
        response.end(
          JSON.stringify({
            entities: {
              Q123: {
                id: "Q123",
                labels: { en: { language: "en", value: "Neon City" } },
                descriptions: { en: { language: "en", value: "1991 film" } },
                claims: {
                  P345: [{ mainsnak: { datavalue: { value: "tt0102552" } } }],
                  P2603: [{ mainsnak: { datavalue: { value: "45678" } } }],
                },
              },
            },
          }),
        );
        return;
      }
      response.end(JSON.stringify({ entities: {} }));
    });
    await new Promise<void>((resolve) => entity.listen(0, "127.0.0.1", resolve));
    const address = entity.address();
    if (address === null || typeof address === "string") {
      throw new Error("stub server has no port");
    }
    const app = await buildApp({
      config: testConfig({
        now: world.clock.now,
        wikidataOrigin: `http://127.0.0.1:${address.port}`,
      }),
      pool: world.pool,
      mail: new MemoryMailTransport(),
      schemaStamp: poolSchemaStamp(world.pool),
    });
    try {
      const facts = await app.inject({
        method: "GET",
        url: "/api/catalogue/wikidata-entities/Q123",
        headers: { cookie: admin.cookie },
      });
      expect(facts.statusCode).toBe(200);
      expect(facts.json()).toMatchObject({
        qid: "Q123",
        label: "Neon City",
        identifiers: [
          { scheme: "imdb", value: "tt0102552", property: "P345" },
          { scheme: "kinopoisk", value: "45678", property: "P2603" },
        ],
      });
      // The second read asks for the request's resolved language with the
      // English fallback.
      expect(entityRequests.at(-1)).toContain("languages=en");

      // The contract's union declares no BadRequest here, so a malformed id
      // answers not_found — the closest declared code.
      const malformed = await app.inject({
        method: "GET",
        url: "/api/catalogue/wikidata-entities/notaqid",
        headers: { cookie: admin.cookie },
      });
      expect(malformed.statusCode).toBe(404);
      expect(malformed.json().code).toBe("not_found");

      const unknown = await app.inject({
        method: "GET",
        url: "/api/catalogue/wikidata-entities/Q999999999",
        headers: { cookie: admin.cookie },
      });
      expect(unknown.statusCode).toBe(404);
    } finally {
      await app.close();
      await new Promise<void>((resolve) => entity.close(() => resolve()));
    }
  });
});
