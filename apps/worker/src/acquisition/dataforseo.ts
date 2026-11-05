import type { ProviderBalanceResult } from "@patrol/budget";
import { GOOGLE_DEPTH, localeRequestParams } from "@patrol/domain";
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
 * The Google route: DataForSEO's Google Organic standard (asynchronous)
 * queue at $0.60 per 1,000 SERPs, one task per query at `depth` 20 — two
 * billable units, no second page (docs/design/serp-acquisition-route.md;
 * implementation rules "Google request"). One task is posted, its
 * completion is observed on the ready list, and the parsed organic items
 * are fetched by task id — DataForSEO keeps standard-queue results for
 * thirty days on their side, so the task id itself is the raw payload
 * reference an observation can be reproduced from without re-querying.
 *
 * The request and response shapes below are pinned as pure functions so
 * tests assert them against the documented bodies with `fetch` mocked; no
 * test ever reaches the network.
 */

export const DATAFORSEO_BASE_URL = "https://api.dataforseo.com";
export const GOOGLE_TASK_POST_PATH = "/v3/serp/google/organic/task_post/json";
export const GOOGLE_TASKS_READY_PATH = "/v3/serp/google/tasks_ready/json";
export const GOOGLE_TASK_GET_PATH = "/v3/serp/google/organic/task_get/json";
export const USER_DATA_PATH = "/v3/appendix/user_data/json";

/**
 * The contactable agent DataForSEO requests for API identification, in the
 * deployment's User-Agent format (docs/design/catalogue-entry.md): the
 * product, what it is, and a contactable address when one is configured —
 * never a browser masquerade.
 */
export function dataForSeoUserAgent(
  buildVersion: string,
  contactEmail?: string,
): string {
  return contactEmail === undefined || contactEmail === ""
    ? `Patrol/${buildVersion} (SERP enforcement tool; contact unset)`
    : `Patrol/${buildVersion} (SERP enforcement tool; contact: ${contactEmail})`;
}

/** Basic authentication over the account's login and password. */
export function dataForSeoAuthHeader(login: string, password: string): string {
  return `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
}

/**
 * The task_post body for one query: the issued keyword, the locale's
 * location and language, a desktop device, and depth 20 — two SERPs of up
 * to ten organic results, billed as two units. No freshness filter, no
 * operators (the plan already stripped them), no second page.
 */
export function googleTaskPostBody(request: AcquireRequest): unknown {
  const params = localeRequestParams(request.locale);
  return [
    {
      keyword: request.text,
      location_name: params.google.locationName,
      language_code: params.google.languageCode,
      device: "desktop",
      depth: GOOGLE_DEPTH,
    },
  ];
}

/**
 * DataForSEO's status envelope: a 20000-family code is success, 40200 is
 * the prepaid balance running out, 401/403 the credentials, and 5xx with
 * a retry later.
 */
export type DataForSeoStatusClass =
  | "ok"
  | "empty_balance"
  | "authentication"
  | "revoked_key"
  | "retryable";

export function classifyDataForSeoStatus(
  httpStatus: number,
  statusCode: number | undefined,
): DataForSeoStatusClass {
  if (statusCode === undefined) {
    if (httpStatus >= 500 || httpStatus === 429) {
      return "retryable";
    }
    if (httpStatus === 401) {
      return "authentication";
    }
    if (httpStatus === 403) {
      return "revoked_key";
    }
    return "retryable";
  }
  if (statusCode === 40200) {
    return "empty_balance";
  }
  if (statusCode === 40100 || statusCode === 40300) {
    return httpStatus === 403 ? "revoked_key" : "authentication";
  }
  if (statusCode >= 50000) {
    return "retryable";
  }
  return "ok";
}

/** The organic items a task_get response carries, as ranked rows. */
export function parseGoogleItems(taskGet: unknown): AcquiredRow[] {
  const envelope = taskGet as {
    tasks?: Array<{
      result?: Array<{
        items?: Array<{
          type?: string;
          rank_group?: number;
          url?: string;
          title?: string;
          description?: string;
        }>;
      }>;
    }>;
  };
  const items = envelope.tasks?.[0]?.result?.[0]?.items ?? [];
  const rows: AcquiredRow[] = [];
  for (const item of items) {
    if (item.type !== "organic" || typeof item.url !== "string") {
      continue;
    }
    rows.push({
      url: item.url,
      title: item.title ?? "",
      snippet: item.description ?? "",
      rank: item.rank_group ?? rows.length + 1,
    });
  }
  return rows.sort((left, right) => left.rank - right.rank);
}

/** The account balance a user_data response carries, in minor units. */
export function parseDataForSeoBalance(userData: unknown): number {
  const envelope = userData as {
    tasks?: Array<{ result?: Array<{ money?: { balance?: number } }> }>;
  };
  const balance = envelope.tasks?.[0]?.result?.[0]?.money?.balance ?? 0;
  return Math.round(balance * 100);
}

/** The task ids a tasks_ready response lists as completed. */
export function parseReadyTaskIds(tasksReady: unknown): string[] {
  const envelope = tasksReady as {
    tasks?: Array<{ result?: Array<{ id?: string } | string> }>;
  };
  const result = envelope.tasks?.[0]?.result ?? [];
  return result
    .map((entry) => (typeof entry === "string" ? entry : entry.id))
    .filter((id): id is string => typeof id === "string");
}

/** Injectable transport, so tests pin request shapes with fetch mocked. */
export interface AdapterTransport {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollIntervalMs: number;
  pollDeadlineMs: number;
  baseUrl: string;
}

export const defaultTransport: Pick<AdapterTransport, "timeoutMs" | "pollIntervalMs" | "pollDeadlineMs" | "baseUrl"> = {
  timeoutMs: 30_000,
  pollIntervalMs: 15_000,
  pollDeadlineMs: 3_300_000,
  baseUrl: DATAFORSEO_BASE_URL,
};

/**
 * The DataForSEO adapter. Constructed only behind configured credentials:
 * the boot registers it when DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD
 * exist, and never in a test.
 */
export class DataForSeoAdapter implements SerpAcquisitor {
  readonly engine = "google" as const;
  private readonly credentials: { login: string; password: string };
  private readonly transport: AdapterTransport;
  private readonly userAgent: string;

  constructor(
    credentials: { login: string; password: string },
    overrides: Partial<AdapterTransport> = {},
    options: { buildVersion?: string; contactEmail?: string } = {},
  ) {
    this.credentials = credentials;
    this.transport = {
      fetch: (url, init) => fetch(url, init),
      now: () => new Date(),
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      ...defaultTransport,
      ...overrides,
    };
    this.userAgent = dataForSeoUserAgent(
      options.buildVersion ?? "dev",
      options.contactEmail,
    );
  }

  private async call(
    path: string,
    init: RequestInit,
  ): Promise<{ httpStatus: number; body: unknown; statusCode?: number }> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.transport.timeoutMs,
    );
    try {
      const response = await this.transport.fetch(
        `${this.transport.baseUrl}${path}`,
        {
          ...init,
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            authorization: dataForSeoAuthHeader(
              this.credentials.login,
              this.credentials.password,
            ),
            "user-agent": this.userAgent,
            ...(init.headers ?? {}),
          },
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        status_code?: number;
        tasks?: Array<{ status_code?: number }>;
      };
      return {
        httpStatus: response.status,
        body,
        statusCode:
          body.status_code ?? body.tasks?.[0]?.status_code,
      };
    } catch (error) {
      throw new TransportError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  /** One provider round: classify, or hand back the transport's failure. */
  private async attempt(path: string, init: RequestInit): Promise<
    | {
        class: DataForSeoStatusClass;
        body: unknown;
        httpStatus: number;
        statusCode?: number;
      }
    | { class: "transport"; body: null; httpStatus: 0; message: string }
  > {
    try {
      const response = await this.call(path, init);
      return {
        class: classifyDataForSeoStatus(response.httpStatus, response.statusCode),
        body: response.body,
        httpStatus: response.httpStatus,
        statusCode: response.statusCode,
      };
    } catch (error) {
      return {
        class: "transport",
        body: null,
        httpStatus: 0,
        message: error instanceof Error ? error.message : String(error),
      };
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

  /** post → poll ready → get, the standard queue's asynchronous round. */
  private async acquireOnce(request: AcquireRequest): Promise<ProviderAttempt> {
    const posted = await this.attempt(GOOGLE_TASK_POST_PATH, {
      method: "POST",
      body: JSON.stringify(googleTaskPostBody(request)),
    });
    if (posted.class === "transport") {
      return { kind: "retryable", reason: "provider timeout" };
    }
    if (posted.class === "empty_balance") {
      return { kind: "route", reason: "empty_balance" };
    }
    if (posted.class === "authentication") {
      return { kind: "route", reason: "authentication" };
    }
    if (posted.class === "revoked_key") {
      return { kind: "route", reason: "revoked_key" };
    }
    if (posted.class === "retryable") {
      return { kind: "retryable", reason: "provider 5xx or 429" };
    }
    const taskId = taskIdOf(posted.body);
    if (taskId === null) {
      // An acceptance without a task id cannot be collected; retrying the
      // post is the only mend the schedule has.
      return { kind: "retryable", reason: "task_post returned no task id" };
    }

    const deadline = this.transport.now().getTime() + this.transport.pollDeadlineMs;
    while (this.transport.now().getTime() < deadline) {
      await this.transport.sleep(this.transport.pollIntervalMs);
      const ready = await this.attempt(GOOGLE_TASKS_READY_PATH, { method: "GET" });
      // The ready poll classifies its failures exactly as task_get does:
      // an authentication, revoked-key, or empty-balance answer is a route
      // failure that no amount of polling mends, so it fails fast into the
      // route-disable path instead of looping until the deadline.
      if (ready.class === "empty_balance") {
        return { kind: "route", reason: "empty_balance" };
      }
      if (ready.class === "authentication" || ready.class === "revoked_key") {
        return { kind: "route", reason: ready.class };
      }
      if (ready.class !== "ok") {
        continue;
      }
      if (!parseReadyTaskIds(ready.body).includes(taskId)) {
        continue;
      }
      const got = await this.attempt(`${GOOGLE_TASK_GET_PATH}/${taskId}`, {
        method: "GET",
      });
      if (got.class === "empty_balance") {
        return { kind: "route", reason: "empty_balance" };
      }
      if (got.class === "authentication" || got.class === "revoked_key") {
        return { kind: "route", reason: got.class };
      }
      if (got.class !== "ok") {
        return { kind: "retryable", reason: "task_get retryable status" };
      }
      return {
        kind: "rows",
        rows: parseGoogleItems(got.body),
        rawPayloadRef: `dataforseo:google:${taskId}`,
        observedAt: this.transport.now().toISOString(),
      };
    }
    return { kind: "retryable", reason: "task results not ready before deadline" };
  }

  async probeBalance(): Promise<ProviderBalanceResult> {
    const probed = await this.attempt(USER_DATA_PATH, { method: "GET" });
    if (probed.class === "transport") {
      return { outcome: "unavailable", reason: "provider timeout" };
    }
    if (probed.class === "empty_balance") {
      return { outcome: "balance", balanceMinor: 0 };
    }
    if (probed.class !== "ok") {
      return {
        outcome: "unavailable",
        reason: `provider status ${probed.httpStatus}`,
      };
    }
    return { outcome: "balance", balanceMinor: parseDataForSeoBalance(probed.body) };
  }

  /**
   * The route's liveness on the same user_data call the balance probe
   * makes: an answered account is up, and an account whose balance reads
   * zero is not — re-enabling it would only fail the first task_post with
   * the empty balance again. Credential classes are auth-down; everything
   * else (5xx, 429, transport) is a plain outage the next hourly probe
   * retries.
   */
  async probeRoute(): Promise<RouteProbeResult> {
    const probed = await this.attempt(USER_DATA_PATH, { method: "GET" });
    if (probed.class === "transport") {
      return { outcome: "down", reason: "provider timeout" };
    }
    if (probed.class === "authentication" || probed.class === "revoked_key") {
      return { outcome: "auth_down" };
    }
    if (probed.class === "empty_balance") {
      return { outcome: "down", reason: "provider balance empty" };
    }
    if (probed.class !== "ok") {
      return { outcome: "down", reason: `provider status ${probed.httpStatus}` };
    }
    if (parseDataForSeoBalance(probed.body) <= 0) {
      return { outcome: "down", reason: "provider balance empty" };
    }
    return { outcome: "up" };
  }
}

/** The transport's own failure marker. */
class TransportError extends Error {}

/** The accepted task's id out of a task_post envelope. */
function taskIdOf(body: unknown): string | null {
  const envelope = body as {
    tasks?: Array<{ id?: string }>;
  };
  const id = envelope.tasks?.[0]?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
