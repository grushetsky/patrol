import { describe, expect, it, vi } from "vitest";
import { DataForSeoGoogleAdapter } from "../src/acquisition/adapters/dataforseo.js";
import { YandexAdapter } from "../src/acquisition/adapters/yandex.js";
import {
  AdapterError,
  type PlannedQuery,
  type SearchContext,
} from "../src/acquisition/types.js";

const CONTEXT: SearchContext = {
  engine: "google",
  locale: "ru-RU",
  territory: "RU",
  limit: 20,
};

const QUERY: PlannedQuery = {
  id: "query-1",
  trackedTitleId: "title-1",
  locale: "ru-RU",
  kind: "variant",
  text: "Ирония судьбы",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("DataForSEO adapter", () => {
  it("posts a standard-queue task with the depth and locale, then reads it", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ tasks: [{ id: "task-1" }] }))
      .mockResolvedValueOnce(
        json({
          tasks: [
            {
              status_code: 20000,
              result: [
                {
                  items: [
                    {
                      type: "organic",
                      url: "https://example.test/film",
                      title: "Film",
                      description: "Snippet",
                      rank_group: 3,
                      domain: "example.test",
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );
    const adapter = new DataForSeoGoogleAdapter({
      login: "login",
      password: "password",
      fetchImpl,
      pollDelayMs: 0,
    });

    const batch = await adapter.search(QUERY, CONTEXT);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("/v3/serp/google/organic/task_post");
    expect((init as RequestInit).headers).toMatchObject({
      authorization: `Basic ${Buffer.from("login:password").toString("base64")}`,
    });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual([
      {
        keyword: "Ирония судьбы",
        language_code: "ru",
        location_name: "Russia",
        depth: 20,
        device: "desktop",
      },
    ]);
    expect(batch.rows[0].engine).toBe("google");
    expect(batch.rows[0]).toMatchObject({
      url: "https://example.test/film",
      position: 3,
      host: "example.test",
      engine: "google",
    });
  });

  it("fails when the asynchronous task never returns a result", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ tasks: [{ id: "task-1" }] }))
      .mockResolvedValue(json({ tasks: [{ status_code: 20100 }] }));
    const adapter = new DataForSeoGoogleAdapter({
      login: "login",
      password: "password",
      fetchImpl,
      pollAttempts: 1,
      pollDelayMs: 0,
    });

    await expect(adapter.search(QUERY, CONTEXT)).rejects.toMatchObject({
      kind: "retryable",
    });
  });

  it("keeps a zero-balance route disabled on a probe", async () => {
    const adapter = new DataForSeoGoogleAdapter({
      login: "login",
      password: "password",
      fetchImpl: vi.fn(async () =>
        json({
          tasks: [{ result: [{ money: { balance: 0 } }] }],
        }),
      ),
    });

    await expect(adapter.probe()).rejects.toMatchObject({ kind: "balance" });
  });

  it("maps a rejected key to an authentication error", async () => {
    const adapter = new DataForSeoGoogleAdapter({
      login: "login",
      password: "password",
      fetchImpl: vi.fn(async () => json({}, 403)),
    });

    await expect(adapter.search(QUERY, CONTEXT)).rejects.toMatchObject({
      kind: "auth",
    });
  });

  it("maps a provider failure to a retryable error", async () => {
    const adapter = new DataForSeoGoogleAdapter({
      login: "login",
      password: "password",
      fetchImpl: vi.fn(async () => json({}, 503)),
    });

    await expect(adapter.search(QUERY, CONTEXT)).rejects.toBeInstanceOf(AdapterError);
    await expect(adapter.search(QUERY, CONTEXT)).rejects.toMatchObject({
      kind: "retryable",
    });
  });
});

describe("Yandex adapter", () => {
  it("requests one flat page and parses the base64 XML", async () => {
    const xml = `<yandexsearch><response><results><grouping><group>
      <doc><url>https://example.test/film</url><title>Film</title>
      <passages><passage>First passage</passage></passages></doc>
      <doc><url>https://other.test/watch</url><title>Other</title></doc>
    </group></grouping></results></response></yandexsearch>`;
    const fetchImpl = vi.fn(async () =>
      json({ rawData: Buffer.from(xml).toString("base64") }),
    );
    const adapter = new YandexAdapter({
      apiKey: "key",
      folderId: "folder",
      fetchImpl,
    });

    const batch = await adapter.search(QUERY, {
      ...CONTEXT,
      engine: "yandex",
      limit: 30,
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/v2/web/search");
    expect(init.headers).toMatchObject({ authorization: "Api-Key key" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      folderId: "folder",
      query: {
        searchType: "SEARCH_TYPE_RU",
        queryText: "Ирония судьбы",
      },
      sortBy: "RLV",
      groupBy: { groupsOnPage: 30, docsInGroup: 1, groupMode: "FLAT" },
      region: 225,
      l10n: "ru",
    });
    expect(batch.rows).toEqual([
      expect.objectContaining({
        url: "https://example.test/film",
        title: "Film",
        snippet: "First passage",
        host: "example.test",
        position: 1,
      }),
      expect.objectContaining({
        url: "https://other.test/watch",
        host: "other.test",
        position: 2,
      }),
    ]);
  });

  it("maps a rejected key to an authentication error", async () => {
    const adapter = new YandexAdapter({
      apiKey: "key",
      folderId: "folder",
      fetchImpl: vi.fn(async () => json({}, 401)),
    });

    await expect(adapter.search(QUERY, CONTEXT)).rejects.toMatchObject({ kind: "auth" });
  });
});
