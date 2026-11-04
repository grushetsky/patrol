import {
  AdapterError,
  type SearchAdapter,
  type SearchBatch,
  type SearchContext,
} from "../types.js";
import type { PlannedQuery } from "../types.js";

interface DataForSeoTask {
  id?: string;
  status_code?: number;
  status_message?: string;
  result?: Array<{
    items?: Array<{
      type?: string;
      url?: string;
      title?: string;
      description?: string;
      rank_group?: number;
      domain?: string;
    }>;
  }>;
}

interface DataForSeoResponse {
  status_code?: number;
  status_message?: string;
  tasks?: DataForSeoTask[];
}

const LOCATION_NAMES: Record<string, string> = {
  RU: "Russia",
  US: "United States",
  GB: "United Kingdom",
  DE: "Germany",
  FR: "France",
  ES: "Spain",
  IT: "Italy",
  NL: "Netherlands",
  BR: "Brazil",
  MX: "Mexico",
  TR: "Turkey",
  JP: "Japan",
  KR: "South Korea",
  IN: "India",
  ZA: "South Africa",
  AU: "Australia",
  NZ: "New Zealand",
  CA: "Canada",
};

export interface DataForSeoOptions {
  login: string;
  password: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  pollAttempts?: number;
  pollDelayMs?: number;
}

/** The DataForSEO Google Organic adapter on the standard asynchronous queue. */
export class DataForSeoGoogleAdapter implements SearchAdapter {
  readonly engine = "google" as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollAttempts: number;
  private readonly pollDelayMs: number;

  constructor(private readonly options: DataForSeoOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.dataforseo.com";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pollAttempts = options.pollAttempts ?? 60;
    this.pollDelayMs = options.pollDelayMs ?? 5_000;
  }

  async search(
    query: PlannedQuery,
    context: SearchContext,
  ): Promise<SearchBatch> {
    const language = query.locale.split("-")[0];
    const location = context.territory
      ? LOCATION_NAMES[context.territory]
      : undefined;
    const task = {
      keyword: query.text,
      language_code: language,
      ...(location ? { location_name: location } : {}),
      depth: context.limit,
      device: "desktop",
    };
    const posted = await this.request<DataForSeoResponse>(
      "POST",
      "/v3/serp/google/organic/task_post",
      [task],
    );
    const taskId = posted.tasks?.[0]?.id;
    if (!taskId) {
      throw new AdapterError(
        "retryable",
        `DataForSEO did not return a task id: ${posted.status_message ?? "unknown"}`,
      );
    }

    let response = posted;
    let settled = false;
    for (let attempt = 0; attempt < this.pollAttempts; attempt += 1) {
      try {
        response = await this.request<DataForSeoResponse>(
          "GET",
          `/v3/serp/google/organic/task_get/${taskId}`,
        );
      } catch (error) {
        if (error instanceof AdapterError && error.kind === "retryable") {
          await new Promise((resolve) => setTimeout(resolve, this.pollDelayMs));
          continue;
        }
        throw error;
      }
      const status = response.tasks?.[0]?.status_code;
      if (status === 20000 || response.tasks?.[0]?.result) {
        settled = true;
        break;
      }
      if (status && status >= 40000 && status < 50000) {
        throw new AdapterError(
          status === 40102 || status === 40103 ? "auth" : "retryable",
          response.tasks?.[0]?.status_message ?? "DataForSEO task failed.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollDelayMs));
    }
    if (!settled) {
      throw new AdapterError(
        "retryable",
        "DataForSEO did not return the task result in time.",
      );
    }

    const items = response.tasks?.[0]?.result?.[0]?.items ?? [];
    return {
      rawBody: JSON.stringify(response),
      rows: items
        .filter((item) => item.type === "organic" && item.url)
        .map((item, index) => ({
          url: String(item.url),
          title: String(item.title ?? ""),
          snippet: String(item.description ?? ""),
          host: String(item.domain ?? ""),
          position: Number(item.rank_group ?? index + 1),
          engine: this.engine,
          retrievedAt: new Date().toISOString(),
        })),
    };
  }

  async probe(): Promise<void> {
    const balance = await this.balanceMinor();
    if (balance !== undefined && balance <= 0) {
      throw new AdapterError("balance", "DataForSEO balance is exhausted.");
    }
  }

  async balanceMinor(): Promise<number | undefined> {
    const response = await this.request<DataForSeoResponse>(
      "GET",
      "/v3/appendix/user_data",
    );
    const value = (
      response.tasks?.[0]?.result?.[0] as
        | { money?: { balance?: number } }
        | undefined
    )?.money?.balance;
    return typeof value === "number" ? Math.round(value * 100) : undefined;
  }

  private async request<T = unknown>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const auth = Buffer.from(
      `${this.options.login}:${this.options.password}`,
    ).toString("base64");
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new AdapterError("retryable", "DataForSEO is unreachable.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new AdapterError("auth", "DataForSEO rejected the credentials.");
    }
    if (response.status === 429 || response.status >= 500) {
      throw new AdapterError(
        "retryable",
        `DataForSEO answered ${response.status}.`,
      );
    }
    if (!response.ok) {
      throw new AdapterError(
        "retryable",
        `DataForSEO answered ${response.status}.`,
      );
    }
    return (await response.json()) as T;
  }
}
