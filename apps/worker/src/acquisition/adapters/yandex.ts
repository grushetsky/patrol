import {
  AdapterError,
  type SearchAdapter,
  type SearchBatch,
  type SearchContext,
} from "../types.js";
import type { PlannedQuery } from "../types.js";

interface YandexResponse {
  rawData?: string;
}

const SEARCH_TYPE: Record<string, string> = {
  ru: "SEARCH_TYPE_RU",
  en: "SEARCH_TYPE_COM",
};

/** Yandex Search API v2 on the deferred route; it answers base64 XML. */
export class YandexAdapter implements SearchAdapter {
  readonly engine = "yandex" as const;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly options: {
      apiKey: string;
      folderId: string;
      endpoint?: string;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.endpoint =
      options.endpoint ?? "https://searchapi.api.cloud.yandex.net/v2/web/search";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(
    query: PlannedQuery,
    context: SearchContext,
  ): Promise<SearchBatch> {
    const language = query.locale.split("-")[0].toLowerCase();
    const response = await this.request({
      folderId: this.options.folderId,
      query: {
        searchType: SEARCH_TYPE[language] ?? "SEARCH_TYPE_COM",
        queryText: query.text,
        families: [{ family: "strict" }],
      },
      sortBy: "RLV",
      groupBy: {
        groupsOnPage: context.limit,
        docsInGroup: 1,
        groupMode: "FLAT",
      },
      ...(language === "ru" ? { region: 225 } : {}),
      l10n: language,
    });
    const xml = Buffer.from(response.rawData ?? "", "base64").toString("utf8");
    return {
      rawBody: xml,
      rows: parseYandexXml(xml).map((row, index) => ({
        ...row,
        position: index + 1,
        engine: this.engine,
        retrievedAt: new Date().toISOString(),
      })),
    };
  }

  async probe(): Promise<void> {
    await this.request({
      folderId: this.options.folderId,
      query: {
        searchType: "SEARCH_TYPE_COM",
        queryText: "patrol route probe",
        families: [{ family: "strict" }],
      },
    });
  }

  private async request(body: unknown): Promise<YandexResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Api-Key ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new AdapterError("retryable", "Yandex is unreachable.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new AdapterError("auth", "Yandex rejected the credentials.");
    }
    if (response.status === 429 || response.status >= 500) {
      throw new AdapterError("retryable", `Yandex answered ${response.status}.`);
    }
    if (!response.ok) {
      throw new AdapterError("retryable", `Yandex answered ${response.status}.`);
    }
    return (await response.json()) as YandexResponse;
  }
}

function parseYandexXml(xml: string): Array<{
  url: string;
  title: string;
  snippet: string;
  host: string;
}> {
  const rows: Array<{
    url: string;
    title: string;
    snippet: string;
    host: string;
  }> = [];
  for (const document of xml.matchAll(/<doc[^>]*>([\s\S]*?)<\/doc>/gi)) {
    const body = document[1];
    const url = textOf(body, "url");
    if (!url) {
      continue;
    }
    rows.push({
      url,
      title: stripTags(textOf(body, "title") ?? ""),
      snippet: stripTags(
        [...body.matchAll(/<passage[^>]*>([\s\S]*?)<\/passage>/gi)]
          .map((match) => match[1])
          .join(" "),
      ).trim(),
      host: new URL(url).hostname.toLowerCase(),
    });
  }
  return rows;
}

function textOf(body: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(body);
  return match ? match[1].trim() : undefined;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
