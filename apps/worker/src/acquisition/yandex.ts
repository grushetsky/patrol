import type { ProviderBalanceResult } from "@patrol/budget";
import {
  YANDEX_DOCS_IN_GROUP,
  YANDEX_GROUP_MODE,
  YANDEX_GROUPS_ON_PAGE,
  localeRequestParams,
} from "@patrol/domain";
import {
  type AcquireOutcome,
  type AcquireRequest,
  type AcquiredRow,
  type RetryTiming,
  type RouteProbeResult,
  type SerpAcquisitor,
} from "./port.js";
import { runWithRetry, type ProviderAttempt } from "./retry.js";

/**
 * The Yandex route: Yandex Search API v2 in deferred (asynchronous) mode
 * at $0.25 per 1,000 requests — one billable unit per request,
 * `groupsOnPage` 30, `docsInGroup` 1, `groupMode` FLAT, no second page
 * (docs/design/serp-acquisition-route.md; implementation rules
 * "Yandex request"). Auth is a folder-scoped API key; the folder id rides
 * in the request body. The response's `rawData` is base64-encoded XML —
 * the legacy `<yandexsearch>` document the v2 sample carries — and the
 * parser below stays deliberately tolerant because the design requires
 * validating it against a live response before freezing the contract.
 *
 * Request and response shapes are pinned as pure functions so tests
 * assert them against the documented bodies with `fetch` mocked; no test
 * ever reaches the network.
 */

export const YANDEX_SEARCH_API_BASE_URL =
  "https://searchapi.api.cloud.yandex.net";
export const YANDEX_SEARCH_ASYNC_PATH = "/v2/web/searchAsync";
export const YANDEX_OPERATIONS_BASE_URL = "https://operation.api.cloud.yandex.net";

/** A desktop user agent, so the route's device stays desktop. */
export const YANDEX_DESKTOP_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** The v2 request body for one query. */
export function yandexSearchBody(
  folderId: string,
  request: AcquireRequest,
): unknown {
  const params = localeRequestParams(request.locale);
  const body: Record<string, unknown> = {
    folderId,
    query: {
      queryText: request.text,
      searchType: params.yandex.searchType,
      // l10n values are the response language's upper-case enum.
      l10n: params.yandex.l10n.toUpperCase(),
    },
    grouping: {
      groupMode: YANDEX_GROUP_MODE === "flat" ? "FLAT" : "DEEP",
      groupsOnPage: YANDEX_GROUPS_ON_PAGE,
      docsInGroup: YANDEX_DOCS_IN_GROUP,
    },
    responseFormat: "FORMAT_XML",
    userAgent: YANDEX_DESKTOP_USER_AGENT,
  };
  if (params.yandex.region !== undefined) {
    // The proto field is `region`; the regions reference and legacy XML
    // call it `lr`. ru carries 225 (Russia); SEARCH_TYPE_COM carries none.
    body.region = params.yandex.region;
  }
  return body;
}

/**
 * The `<yandexsearch>` document's documents as ranked rows: each `doc`'s
 * url, title (query words arrive wrapped in `hlword`, so the tags are
 * unwrapped), the passages joined as the snippet, and an ordinal rank.
 * Tolerant by design — see the module note about live validation.
 */
export function parseYandexXml(xml: string): AcquiredRow[] {
  const rows: AcquiredRow[] = [];
  const docs = xml.match(/<doc>[\s\S]*?<\/doc>/g) ?? [];
  for (const doc of docs) {
    const url = tagText(doc, "url");
    if (url === null) {
      continue;
    }
    const title = tagText(doc, "title") ?? "";
    const passages = [...doc.matchAll(/<passage>([\s\S]*?)<\/passage>/g)].map(
      (match) => unwrapInline(match[1]),
    );
    rows.push({
      url,
      title: unwrapInline(title),
      snippet: passages.join(" "),
      rank: rows.length + 1,
    });
  }
  return rows;
}

/** One element's inner text, entities decoded; null when absent. */
function tagText(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return match === null ? null : unwrapInline(match[1]);
}

/** Strips the inline markup (hlword and friends) and decodes entities. */
function unwrapInline(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Decodes the base64 `rawData` of a completed search operation. */
export function decodeRawData(rawData: string): string {
  return Buffer.from(rawData, "base64").toString("utf8");
}

/** Injectable transport, so tests pin request shapes with fetch mocked. */
export interface YandexTransport {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollIntervalMs: number;
  pollDeadlineMs: number;
  searchBaseUrl: string;
  operationsBaseUrl: string;
}

export const defaultYandexTransport: Pick<
  YandexTransport,
  "timeoutMs" | "pollIntervalMs" | "pollDeadlineMs" | "searchBaseUrl" | "operationsBaseUrl"
> = {
  timeoutMs: 30_000,
  pollIntervalMs: 15_000,
  pollDeadlineMs: 3_300_000,
  searchBaseUrl: YANDEX_SEARCH_API_BASE_URL,
  operationsBaseUrl: YANDEX_OPERATIONS_BASE_URL,
};

/**
 * The Yandex adapter. Constructed only behind configured credentials: the
 * boot registers it when YANDEX_SEARCH_API_KEY and YANDEX_FOLDER_ID
 * exist, and never in a test. Deferred mode has a five-minute minimum, so
 * the poll waits long by default; the engine queue's concurrency one
 * holds the slot while the operation matures.
 */
export class YandexAdapter implements SerpAcquisitor {
  readonly engine = "yandex" as const;
  private readonly credentials: { apiKey: string; folderId: string };
  private readonly transport: YandexTransport;

  constructor(
    credentials: { apiKey: string; folderId: string },
    overrides: Partial<YandexTransport> = {},
  ) {
    this.credentials = credentials;
    this.transport = {
      fetch: (url, init) => fetch(url, init),
      now: () => new Date(),
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      ...defaultYandexTransport,
      ...overrides,
    };
  }

  private async call(
    url: string,
    init: RequestInit,
  ): Promise<{ httpStatus: number; body: unknown; ok: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.transport.timeoutMs,
    );
    try {
      const response = await this.transport.fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Api-Key ${this.credentials.apiKey}`,
          ...(init.headers ?? {}),
        },
      });
      const body = (await response.json().catch(() => ({}))) as unknown;
      return { httpStatus: response.status, body, ok: response.ok };
    } catch (error) {
      throw new Error(
        `yandex transport failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async acquire(
    request: AcquireRequest,
    timing?: RetryTiming,
  ): Promise<AcquireOutcome> {
    const result = await runWithRetry(
      () => this.acquireOnce(request),
      timing ?? {
        sleep: (ms) => this.transport.sleep(ms),
        now: () => this.transport.now(),
      },
    );
    if (result.outcome === "acquired") {
      return {
        outcome: "acquired",
        rows: result.rows,
        rawPayloadRef: result.rawPayloadRef,
        observedAt: result.observedAt,
      };
    }
    if (result.outcome === "route_failed") {
      return { outcome: "route_failed", reason: result.reason };
    }
    return {
      outcome: "query_failed",
      reason: result.reason,
      attempts: result.attempts,
      attemptLog: result.attemptLog,
    };
  }

  /** searchAsync → poll the operation → decode rawData. */
  private async acquireOnce(request: AcquireRequest): Promise<ProviderAttempt> {
    let submitted: { httpStatus: number; body: unknown; ok: boolean };
    try {
      submitted = await this.call(
        `${this.transport.searchBaseUrl}${YANDEX_SEARCH_ASYNC_PATH}`,
        {
          method: "POST",
          body: JSON.stringify(yandexSearchBody(this.credentials.folderId, request)),
        },
      );
    } catch {
      return { kind: "retryable", reason: "provider timeout" };
    }
    const operationId = operationIdOf(submitted.body);
    if (submitted.httpStatus === 401 || submitted.httpStatus === 403) {
      return {
        kind: "route",
        reason: submitted.httpStatus === 403 ? "revoked_key" : "authentication",
      };
    }
    if (submitted.httpStatus === 402) {
      return { kind: "route", reason: "empty_balance" };
    }
    if (!submitted.ok || operationId === null) {
      return { kind: "retryable", reason: `provider status ${submitted.httpStatus}` };
    }

    const deadline = this.transport.now().getTime() + this.transport.pollDeadlineMs;
    while (this.transport.now().getTime() < deadline) {
      await this.transport.sleep(this.transport.pollIntervalMs);
      let operation: { httpStatus: number; body: unknown; ok: boolean };
      try {
        operation = await this.call(
          `${this.transport.operationsBaseUrl}/operations/${operationId}`,
          { method: "GET" },
        );
      } catch {
        return { kind: "retryable", reason: "provider timeout" };
      }
      if (operation.httpStatus === 401 || operation.httpStatus === 403) {
        return {
          kind: "route",
          reason: operation.httpStatus === 403 ? "revoked_key" : "authentication",
        };
      }
      const envelope = operation.body as {
        done?: boolean;
        response?: { rawData?: string };
        error?: { code?: number; message?: string };
      };
      if (envelope.error !== undefined) {
        const code = envelope.error.code ?? 0;
        if (code === 16 || code === 7) {
          return { kind: "route", reason: "authentication" };
        }
        if (code === 8 || code === 13) {
          return { kind: "route", reason: "empty_balance" };
        }
        return {
          kind: "retryable",
          reason: `operation error ${code}: ${envelope.error.message ?? ""}`,
        };
      }
      if (envelope.done !== true || envelope.response?.rawData === undefined) {
        continue;
      }
      return {
        kind: "rows",
        rows: parseYandexXml(decodeRawData(envelope.response.rawData)),
        rawPayloadRef: `yandex:operation:${operationId}`,
        observedAt: this.transport.now().toISOString(),
      };
    }
    return { kind: "retryable", reason: "operation not done before deadline" };
  }

  /**
   * Yandex Cloud bills by invoice rather than a prepaid balance the API
   * exposes, so the daily balance probe records an explicit
   * unavailability instead of inventing a reading; the ledger stays the
   * budget authority either way.
   */
  async probeBalance(): Promise<ProviderBalanceResult> {
    return {
      outcome: "unavailable",
      reason: "yandex cloud exposes no prepaid balance endpoint",
    };
  }

  /**
   * The route's liveness, which the balance endpoint cannot answer: one
   * minimal deferred searchAsync request, abandoned the moment its status
   * arrives. A 2xx means the credentials and the folder admit requests —
   * the abandoned operation is never fetched and bills at most its single
   * deferred request; 401/403 mean auth-down; anything else is an outage.
   */
  async probeRoute(): Promise<RouteProbeResult> {
    let submitted: { httpStatus: number; body: unknown; ok: boolean };
    try {
      submitted = await this.call(
        `${this.transport.searchBaseUrl}${YANDEX_SEARCH_ASYNC_PATH}`,
        {
          method: "POST",
          // The probe's own query, never a scan's: one short text in the
          // com locale so no region rides along.
          body: JSON.stringify(
            yandexSearchBody(this.credentials.folderId, {
              queryId: "route-probe",
              text: "patrol route probe",
              locale: "en",
            }),
          ),
        },
      );
    } catch (error) {
      return {
        outcome: "down",
        reason: `provider timeout: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (submitted.httpStatus === 401 || submitted.httpStatus === 403) {
      return { outcome: "auth_down" };
    }
    if (!submitted.ok) {
      return { outcome: "down", reason: `provider status ${submitted.httpStatus}` };
    }
    return { outcome: "up" };
  }
}

/** The submitted operation's id out of a searchAsync response. */
function operationIdOf(body: unknown): string | null {
  const envelope = body as { id?: string };
  return typeof envelope.id === "string" && envelope.id.length > 0
    ? envelope.id
    : null;
}
