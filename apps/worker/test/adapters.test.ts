import { describe, expect, it } from "vitest";
import { QUERY_RETRY_DELAYS_MS } from "../src/acquisition/port.js";
import { runWithRetry } from "../src/acquisition/retry.js";
import { FakeSerpAcquisitor } from "../src/acquisition/fake.js";
import {
  DataForSeoAdapter,
  classifyDataForSeoStatus,
  dataForSeoAuthHeader,
  dataForSeoUserAgent,
  googleTaskPostBody,
  parseDataForSeoBalance,
  parseGoogleItems,
  parseReadyTaskIds,
} from "../src/acquisition/dataforseo.js";
import {
  YandexAdapter,
  decodeRawData,
  parseYandexXml,
  yandexSearchBody,
} from "../src/acquisition/yandex.js";
import { CRON_JOBS } from "../src/jobs.js";

/**
 * The adapters' request and response shapes, pinned against the
 * documented provider bodies with fetch mocked — no test reaches a
 * network (docs/design/serp-acquisition-route.md; implementation rules
 * "Query plan and acquisition").
 */

const instantSleep = async () => {};
const frozenNow = () => new Date("2026-03-02T10:00:00.000Z");

describe("the query retry schedule", () => {
  it("retries at one, five, and fifteen minutes", () => {
    expect(QUERY_RETRY_DELAYS_MS).toEqual([60_000, 300_000, 900_000]);
  });

  it("consumes the initial try plus three retries, recording each", async () => {
    let calls = 0;
    const result = await runWithRetry(
      async () => {
        calls += 1;
        return { kind: "retryable", reason: "provider 5xx" } as const;
      },
      { retryDelaysMs: QUERY_RETRY_DELAYS_MS, sleep: instantSleep, now: frozenNow },
    );
    expect(calls).toBe(4);
    expect(result.outcome).toBe("query_failed");
    if (result.outcome === "query_failed") {
      expect(result.attempts).toBe(4);
      // The recorded sequence: attempt, +1 min, +5 min, +15 min.
      expect(result.attemptLog.map((entry) => entry.waitedMs)).toEqual([
        60_000,
        300_000,
        900_000,
        undefined,
      ]);
    }
  });

  it("stops a route failure immediately — no retry applies", async () => {
    let calls = 0;
    const result = await runWithRetry(
      async () => {
        calls += 1;
        return { kind: "route", reason: "authentication" } as const;
      },
      { retryDelaysMs: QUERY_RETRY_DELAYS_MS, sleep: instantSleep, now: frozenNow },
    );
    expect(calls).toBe(1);
    expect(result).toMatchObject({ outcome: "route_failed", reason: "authentication" });
  });

  it("recovers when a retry answers", async () => {
    let calls = 0;
    const result = await runWithRetry(
      async () => {
        calls += 1;
        return calls === 1
          ? ({ kind: "retryable", reason: "provider 429" } as const)
          : ({
              kind: "rows",
              rows: [],
              rawPayloadRef: "ref",
              observedAt: frozenNow().toISOString(),
            } as const);
      },
      { retryDelaysMs: QUERY_RETRY_DELAYS_MS, sleep: instantSleep, now: frozenNow },
    );
    expect(result).toMatchObject({ outcome: "acquired", attempts: 2 });
  });
});

describe("the fake adapter", () => {
  it("returns canned rows and records the request shape", async () => {
    const fake = new FakeSerpAcquisitor("google", {
      results: { "Sunrise watch online": [{ url: "https://a.example/x", title: "A", snippet: "s", rank: 1 }] },
    });
    const result = await fake.acquire(
      { queryId: "q1", text: "Sunrise watch online", locale: "en" },
      { retryDelaysMs: [1], sleep: instantSleep, now: frozenNow },
    );
    expect(result).toMatchObject({ outcome: "acquired" });
    expect(fake.requests).toEqual([
      { queryId: "q1", text: "Sunrise watch online", locale: "en" },
    ]);
    if (result.outcome === "acquired") {
      expect(result.rows).toEqual([
        { url: "https://a.example/x", title: "A", snippet: "s", rank: 1 },
      ]);
      expect(result.rawPayloadRef).toBe("fake:google:q1");
    }
  });

  it("plays a per-attempt script through the retry schedule", async () => {
    const fake = new FakeSerpAcquisitor("yandex", {
      scripts: { Рассвет: ["server_error", "rate_limited", "ok"] },
    });
    const result = await fake.acquire(
      { queryId: "q2", text: "Рассвет", locale: "ru" },
      { retryDelaysMs: [1, 1, 1], sleep: instantSleep, now: frozenNow },
    );
    expect(result.outcome).toBe("acquired");
    expect(fake.requests).toHaveLength(1);
  });
});

describe("the DataForSEO request shape", () => {
  it("posts one depth-20 desktop task with the locale's location and language", () => {
    expect(
      googleTaskPostBody({ queryId: "q", text: "Рассвет смотреть онлайн", locale: "ru" }),
    ).toEqual([
      {
        keyword: "Рассвет смотреть онлайн",
        location_name: "Russia",
        language_code: "ru",
        device: "desktop",
        depth: 20,
      },
    ]);
    expect(
      googleTaskPostBody({ queryId: "q", text: "Sunrise", locale: "en" }),
    ).toEqual([
      {
        keyword: "Sunrise",
        location_name: "United States",
        language_code: "en",
        device: "desktop",
        depth: 20,
      },
    ]);
  });

  it("authenticates with the account's login and password", () => {
    expect(dataForSeoAuthHeader("login", "secret")).toBe(
      `Basic ${Buffer.from("login:secret").toString("base64")}`,
    );
  });

  it("classifies the provider's status envelope", () => {
    expect(classifyDataForSeoStatus(200, 20000)).toBe("ok");
    expect(classifyDataForSeoStatus(200, 40200)).toBe("empty_balance");
    expect(classifyDataForSeoStatus(401, 40100)).toBe("authentication");
    expect(classifyDataForSeoStatus(403, 40300)).toBe("revoked_key");
    expect(classifyDataForSeoStatus(500, undefined)).toBe("retryable");
    expect(classifyDataForSeoStatus(429, undefined)).toBe("retryable");
  });

  it("parses organic items, the ready list, and the balance", () => {
    expect(
      parseGoogleItems({
        tasks: [
          {
            result: [
              {
                items: [
                  { type: "paid", url: "https://ad.example/a", rank_group: 1 },
                  {
                    type: "organic",
                    url: "https://b.example/watch",
                    title: "B",
                    description: "about b",
                    rank_group: 2,
                  },
                  {
                    type: "organic",
                    url: "https://c.example/watch",
                    title: "C",
                    description: "about c",
                    rank_group: 1,
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toEqual([
      { url: "https://c.example/watch", title: "C", snippet: "about c", rank: 1 },
      { url: "https://b.example/watch", title: "B", snippet: "about b", rank: 2 },
    ]);
    expect(parseReadyTaskIds({ tasks: [{ result: [{ id: "t1" }, "t2"] }] })).toEqual([
      "t1",
      "t2",
    ]);
    expect(
      parseDataForSeoBalance({ tasks: [{ result: [{ money: { balance: 12.34 } }] }] }),
    ).toBe(1234);
  });

  it("walks post → ready → get against a mocked fetch", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown; auth: string }> = [];
    const adapter = new DataForSeoAdapter(
      { login: "login", password: "secret" },
      {
        fetch: async (url, init) => {
          calls.push({
            url,
            method: init.method ?? "GET",
            body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
            auth: String((init.headers as Record<string, string>).authorization),
          });
          if (url.endsWith("/v3/serp/google/organic/task_post/json")) {
            return jsonResponse(200, {
              status_code: 20000,
              tasks: [{ status_code: 20100, id: "task-1", cost: 0.12 }],
            });
          }
          if (url.endsWith("/v3/serp/google/tasks_ready/json")) {
            return jsonResponse(200, {
              status_code: 20000,
              tasks: [{ result: [{ id: "task-1" }] }],
            });
          }
          return jsonResponse(200, {
            status_code: 20000,
            tasks: [
              {
                status_code: 20000,
                result: [
                  {
                    items: [
                      {
                        type: "organic",
                        url: "https://x.example/watch",
                        title: "X",
                        description: "d",
                        rank_group: 1,
                      },
                    ],
                  },
                ],
              },
            ],
          });
        },
        now: frozenNow,
        sleep: instantSleep,
        pollIntervalMs: 0,
        pollDeadlineMs: 60_000,
        baseUrl: "https://api.dataforseo.test",
        timeoutMs: 5_000,
      },
    );
    const result = await adapter.acquire(
      { queryId: "q3", text: "Sunrise watch online", locale: "en" },
      { retryDelaysMs: [1], sleep: instantSleep, now: frozenNow },
    );
    expect(result).toMatchObject({
      outcome: "acquired",
      rawPayloadRef: "dataforseo:google:task-1",
    });
    expect(calls).toEqual([
      {
        url: "https://api.dataforseo.test/v3/serp/google/organic/task_post/json",
        method: "POST",
        body: googleTaskPostBody({ queryId: "q3", text: "Sunrise watch online", locale: "en" }),
        auth: dataForSeoAuthHeader("login", "secret"),
      },
      {
        url: "https://api.dataforseo.test/v3/serp/google/tasks_ready/json",
        method: "GET",
        auth: dataForSeoAuthHeader("login", "secret"),
      },
      {
        url: "https://api.dataforseo.test/v3/serp/google/organic/task_get/json/task-1",
        method: "GET",
        auth: dataForSeoAuthHeader("login", "secret"),
      },
    ]);
  });

  it("sends the contactable User-Agent the deployment configures", async () => {
    expect(dataForSeoUserAgent("1.2.3", "ops@example.com")).toBe(
      "Patrol/1.2.3 (SERP enforcement tool; contact: ops@example.com)",
    );
    expect(dataForSeoUserAgent("1.2.3")).toBe(
      "Patrol/1.2.3 (SERP enforcement tool; contact unset)",
    );
    const seen: string[] = [];
    const adapter = new DataForSeoAdapter(
      { login: "login", password: "secret" },
      {
        fetch: async (url, init) => {
          seen.push(String((init.headers as Record<string, string>)["user-agent"]));
          if (url.endsWith("/v3/appendix/user_data/json")) {
            return jsonResponse(200, {
              status_code: 20000,
              tasks: [{ result: [{ money: { balance: 12.34 } }] }],
            });
          }
          return jsonResponse(200, { status_code: 20000, tasks: [] });
        },
        now: frozenNow,
        sleep: instantSleep,
        baseUrl: "https://api.dataforseo.test",
      },
      { buildVersion: "9.9.9", contactEmail: "ops@example.com" },
    );
    await adapter.probeRoute();
    expect(seen[0]).toBe("Patrol/9.9.9 (SERP enforcement tool; contact: ops@example.com)");
  });

  it("fails the route fast when the tasks_ready poll answers an auth or balance failure", async () => {
    const posts: string[] = [];
    const cases: Array<{
      ready: () => Response;
      expected: { outcome: "route_failed"; reason: string };
    }> = [
      {
        ready: () => jsonResponse(401, { status_code: 40100 }),
        expected: { outcome: "route_failed", reason: "authentication" },
      },
      {
        ready: () => jsonResponse(403, { status_code: 40300 }),
        expected: { outcome: "route_failed", reason: "revoked_key" },
      },
      {
        ready: () => jsonResponse(200, { status_code: 40200 }),
        expected: { outcome: "route_failed", reason: "empty_balance" },
      },
    ];
    for (const testCase of cases) {
      const adapter = new DataForSeoAdapter(
        { login: "login", password: "secret" },
        {
          fetch: async (url) => {
            if (url.endsWith("/v3/serp/google/organic/task_post/json")) {
              posts.push(url);
              return jsonResponse(200, {
                status_code: 20000,
                tasks: [{ status_code: 20100, id: "task-1" }],
              });
            }
            if (url.endsWith("/v3/serp/google/tasks_ready/json")) {
              return testCase.ready();
            }
            throw new Error(`unexpected call to ${url} — task_get must not follow a failed ready poll`);
          },
          now: frozenNow,
          sleep: instantSleep,
          pollIntervalMs: 0,
          pollDeadlineMs: 60_000,
          baseUrl: "https://api.dataforseo.test",
          timeoutMs: 5_000,
        },
      );
      const result = await adapter.acquire(
        { queryId: "q", text: "Sunrise", locale: "en" },
        { retryDelaysMs: [1], sleep: instantSleep, now: frozenNow },
      );
      expect(result).toMatchObject(testCase.expected);
    }
    // One accepted post per case; no task_get was ever issued.
    expect(posts).toHaveLength(3);
  });

  it("probes the route on the user_data call: up on a balance, auth-down on credentials", async () => {
    const routeProbe = async (
      respond: () => Response,
    ): Promise<ReturnType<DataForSeoAdapter["probeRoute"]>> => {
      const adapter = new DataForSeoAdapter(
        { login: "login", password: "secret" },
        {
          fetch: async () => respond(),
          now: frozenNow,
          sleep: instantSleep,
          baseUrl: "https://api.dataforseo.test",
        },
      );
      return adapter.probeRoute();
    };
    expect(
      await routeProbe(() =>
        jsonResponse(200, {
          status_code: 20000,
          tasks: [{ result: [{ money: { balance: 12.34 } }] }],
        }),
      ),
    ).toEqual({ outcome: "up" });
    expect(
      await routeProbe(() =>
        jsonResponse(200, {
          status_code: 20000,
          tasks: [{ result: [{ money: { balance: 0 } }] }],
        }),
      ),
    ).toEqual({ outcome: "down", reason: "provider balance empty" });
    expect(
      await routeProbe(() => jsonResponse(401, { status_code: 40100 })),
    ).toEqual({ outcome: "auth_down" });
    expect(
      await routeProbe(() => jsonResponse(500, {})),
    ).toMatchObject({ outcome: "down" });
  });
});

describe("the Yandex request shape", () => {
  it("carries the folder, query controls, flat grouping, and the ru region", () => {
    expect(
      yandexSearchBody("folder-1", {
        queryId: "q",
        text: "Рассвет смотреть онлайн",
        locale: "ru",
      }),
    ).toEqual({
      folderId: "folder-1",
      query: {
        queryText: "Рассвет смотреть онлайн",
        searchType: "SEARCH_TYPE_RU",
        l10n: "RU",
      },
      region: 225,
      grouping: { groupMode: "FLAT", groupsOnPage: 30, docsInGroup: 1 },
      responseFormat: "FORMAT_XML",
      userAgent: expect.any(String),
    });
  });

  it("omits the region for SEARCH_TYPE_COM", () => {
    const body = yandexSearchBody("folder-1", {
      queryId: "q",
      text: "Sunrise",
      locale: "en",
    }) as Record<string, unknown>;
    expect((body.query as Record<string, unknown>).searchType).toBe("SEARCH_TYPE_COM");
    expect(body.region).toBeUndefined();
  });

  it("parses the legacy XML document out of rawData", () => {
    const xml = [
      "<yandexsearch version=\"1.0\"><response>",
      "<grouping>",
      "<group><doc>",
      "<url>https://a.example/watch</url>",
      "<domain>a.example</domain>",
      "<title>Рассвет &lt;hlword&gt;смотреть&lt;/hlword&gt; онлайн</title>",
      "<passages><passage>Смотреть бесплатно</passage><passage>В хорошем качестве</passage></passages>",
      "</doc></group>",
      "<group><doc>",
      "<url>https://b.example/dl</url>",
      "<title>Скачать</title>",
      "</doc></group>",
      "</grouping></response></yandexsearch>",
    ].join("");
    expect(parseYandexXml(xml)).toEqual([
      {
        url: "https://a.example/watch",
        title: "Рассвет смотреть онлайн",
        snippet: "Смотреть бесплатно В хорошем качестве",
        rank: 1,
      },
      { url: "https://b.example/dl", title: "Скачать", snippet: "", rank: 2 },
    ]);
    expect(decodeRawData(Buffer.from(xml, "utf8").toString("base64"))).toBe(xml);
  });

  it("walks searchAsync → operation → rawData against a mocked fetch", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown; auth: string }> = [];
    const adapter = new YandexAdapter(
      { apiKey: "key", folderId: "folder-1" },
      {
        fetch: async (url, init) => {
          calls.push({
            url,
            method: init.method ?? "GET",
            body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
            auth: String((init.headers as Record<string, string>).authorization),
          });
          if (url.endsWith("/v2/web/searchAsync")) {
            return jsonResponse(200, { id: "op-1", done: false });
          }
          return jsonResponse(200, {
            id: "op-1",
            done: true,
            response: {
              rawData: Buffer.from(
                "<yandexsearch><response><grouping><group><doc><url>https://y.example/w</url><title>Y</title></doc></group></grouping></response></yandexsearch>",
                "utf8",
              ).toString("base64"),
            },
          });
        },
        now: frozenNow,
        sleep: instantSleep,
        pollIntervalMs: 0,
        pollDeadlineMs: 60_000,
        searchBaseUrl: "https://searchapi.test",
        operationsBaseUrl: "https://operations.test",
        timeoutMs: 5_000,
      },
    );
    const result = await adapter.acquire(
      { queryId: "q4", text: "Рассвет", locale: "ru" },
      { retryDelaysMs: [1], sleep: instantSleep, now: frozenNow },
    );
    expect(result).toMatchObject({
      outcome: "acquired",
      rawPayloadRef: "yandex:operation:op-1",
    });
    expect(calls[0]).toMatchObject({
      url: "https://searchapi.test/v2/web/searchAsync",
      method: "POST",
      auth: "Api-Key key",
    });
    expect(calls[0].body).toEqual(
      yandexSearchBody("folder-1", { queryId: "q4", text: "Рассвет", locale: "ru" }),
    );
    expect(calls[1]).toMatchObject({
      url: "https://operations.test/operations/op-1",
      method: "GET",
    });
    expect(await adapter.probeBalance()).toMatchObject({ outcome: "unavailable" });
  });

  it("probes the route with one abandoned searchAsync: up, auth-down, down", async () => {
    const probe = async (status: number): Promise<ReturnType<YandexAdapter["probeRoute"]>> => {
      const seen: Array<{ url: string; method: string }> = [];
      const adapter = new YandexAdapter(
        { apiKey: "key", folderId: "folder-1" },
        {
          fetch: async (url, init) => {
            seen.push({ url, method: init.method ?? "GET" });
            return jsonResponse(status, status === 200 ? { id: "op-probe" } : {});
          },
          now: frozenNow,
          sleep: instantSleep,
          searchBaseUrl: "https://searchapi.test",
          operationsBaseUrl: "https://operations.test",
        },
      );
      const result = await adapter.probeRoute();
      // The probe submits one deferred search and abandons it after the
      // status: no operation poll ever follows.
      expect(seen).toEqual([
        { url: "https://searchapi.test/v2/web/searchAsync", method: "POST" },
      ]);
      return result;
    };
    expect(await probe(200)).toEqual({ outcome: "up" });
    expect(await probe(401)).toEqual({ outcome: "auth_down" });
    expect(await probe(403)).toEqual({ outcome: "auth_down" });
    expect(await probe(500)).toEqual({ outcome: "down", reason: "provider status 500" });
  });
});

describe("the cron table", () => {
  it("pins the job cadences the implementation rules name", () => {
    expect(CRON_JOBS["scan.schedule"]).toBe("*/15 * * * *");
    expect(CRON_JOBS["recheck.schedule"]).toBe("*/15 * * * *");
    expect(CRON_JOBS["budget.rollover"]).toBe("0 0 1 * *");
    expect(CRON_JOBS["budget.balance"]).toBe("0 6 * * *");
    expect(CRON_JOBS["route.probe"]).toBe("0 * * * *");
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
