import { setTimeout as sleep } from "node:timers/promises";
import { ApiError } from "../errors.js";

export interface WikidataSuggestion {
  qid: string;
  label: string;
  description?: string;
  matchedAlias?: string;
  matchedAliasLanguage?: string;
}

export interface WikidataIdentifierSuggestion {
  scheme: "imdb" | "kinopoisk";
  value: string;
  property: string;
}

export interface WikidataEntityFacts {
  qid: string;
  label: string;
  description?: string;
  identifiers: WikidataIdentifierSuggestion[];
}

/** The two Wikidata reads the add-title field performs. */
export interface WikidataSource {
  search(query: string, locale: string): Promise<WikidataSuggestion[]>;
  entity(qid: string): Promise<WikidataEntityFacts>;
}

interface SearchResponse {
  search?: Array<{
    id?: string;
    label?: string;
    description?: string;
    match?: { type?: string; language?: string; text?: string };
  }>;
}

interface EntityResponse {
  entities?: Record<
    string,
    {
      missing?: string;
      labels?: Record<string, { value?: string }>;
      descriptions?: Record<string, { value?: string }>;
      claims?: Record<
        string,
        Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>
      >;
    }
  >;
}

const MIN_QUERY_LENGTH = 3;
const MIN_INTERVAL_MS = 300;
const REQUEST_TIMEOUT_MS = 5_000;
const IDENTIFIER_PROPERTIES: Array<{
  property: string;
  scheme: "imdb" | "kinopoisk";
}> = [
  { property: "P345", scheme: "imdb" },
  { property: "P2603", scheme: "kinopoisk" },
];

/**
 * A serialized Wikidata client. The design requires entry lookups to run one
 * at a time with a 300 ms pause, identified by a contactable user agent.
 */
export class WikidataClient implements WikidataSource {
  private tail: Promise<unknown> = Promise.resolve();
  private lastStartedAt = 0;

  constructor(
    private readonly endpoint = "https://www.wikidata.org/w/api.php",
    private readonly userAgent = process.env.PATROL_WIKIDATA_USER_AGENT ??
      "PatrolBot/0.1 (https://patrol.example; legal@patrol.example)",
    private readonly minimumIntervalMs = MIN_INTERVAL_MS,
  ) {}

  search(query: string, locale: string): Promise<WikidataSuggestion[]> {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      return Promise.resolve([]);
    }
    const language = locale.split("-")[0] || "en";
    return this.serial(async () => {
      const params = new URLSearchParams({
        action: "wbsearchentities",
        search: trimmed,
        language,
        uselang: language,
        type: "item",
        limit: "10",
        format: "json",
      });
      const body = await this.read<SearchResponse>(params);
      return (body.search ?? [])
        .filter((item) => item.id && item.label)
        .map((item) => {
          const alias =
            item.match?.type === "alias" ? item.match.text : undefined;
          return {
            qid: String(item.id),
            label: String(item.label),
            description: item.description,
            matchedAlias: alias,
            matchedAliasLanguage: alias ? item.match?.language : undefined,
          };
        });
    });
  }

  entity(qid: string): Promise<WikidataEntityFacts> {
    return this.serial(async () => {
      const params = new URLSearchParams({
        action: "wbgetentities",
        ids: qid,
        props: "labels|descriptions|claims",
        format: "json",
      });
      const body = await this.read<EntityResponse>(params);
      const entity = body.entities?.[qid];
      if (!entity || entity.missing !== undefined) {
        throw new ApiError(404, "not_found", "No such Wikidata entity.");
      }
      const label =
        entity.labels?.en?.value ??
        Object.values(entity.labels ?? {})[0]?.value ??
        qid;
      const identifiers: WikidataIdentifierSuggestion[] = [];
      for (const { property, scheme } of IDENTIFIER_PROPERTIES) {
        const value = entity.claims?.[property]?.[0]?.mainsnak?.datavalue?.value;
        if (typeof value === "string") {
          identifiers.push({ scheme, value, property });
        }
      }
      return {
        qid,
        label,
        description:
          entity.descriptions?.en?.value ??
          Object.values(entity.descriptions ?? {})[0]?.value,
        identifiers,
      };
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const pause = this.lastStartedAt + this.minimumIntervalMs - Date.now();
      if (pause > 0) {
        await sleep(pause);
      }
      this.lastStartedAt = Date.now();
      return operation();
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async read<T>(params: URLSearchParams): Promise<T> {
    params.set("origin", "*");
    let response: Response;
    try {
      response = await fetch(`${this.endpoint}?${params.toString()}`, {
        headers: { "user-agent": this.userAgent },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ApiError(
        503,
        "upstream_unavailable",
        "Wikidata is unreachable.",
      );
    }
    if (!response.ok) {
      throw new ApiError(
        503,
        "upstream_unavailable",
        "Wikidata answered with an error.",
      );
    }
    return (await response.json()) as T;
  }
}
