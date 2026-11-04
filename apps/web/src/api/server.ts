import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { components } from "../generated/openapi";

type Schemas = components["schemas"];
export type DashboardSummary = Schemas["Http.DashboardSummary"];
export type TitleChart = Schemas["Http.TitleChartResponse"];
export type AuthenticatedSession = Schemas["Http.AuthenticatedSession"];
export type SetupState = Schemas["Http.SetupState"];
export type ChartGrouping = Schemas["Http.ChartGrouping"];
export type ChartMetric = Schemas["Http.ChartMetric"];
export type ChartWindow = Schemas["Http.ChartWindow"];
export type ResolvedBasis = Schemas["Http.ResolvedBasis"];

export interface ChartInput {
  metric: ChartMetric;
  windowDays?: ChartWindow;
  groupBy?: ChartGrouping;
  basis?: ResolvedBasis;
}

const API_URL = process.env.API_URL ?? "http://localhost:3000/api";

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API request failed with ${status}`);
    this.name = "ApiClientError";
  }
}

async function fetchApi<T>(path: string): Promise<T> {
  const request = getRequest();
  const cookie = request.headers.get("cookie");
  const response = await fetch(`${API_URL}${path}`, {
    headers: cookie ? { cookie } : undefined,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiClientError(response.status, body);
  }
  return body as T;
}

export const sessionFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuthenticatedSession | null> => {
    try {
      return await fetchApi<AuthenticatedSession>("/auth/session");
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        return null;
      }
      throw error;
    }
  },
);

export const setupFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<SetupState> => fetchApi<SetupState>("/system/setup"),
);

export const dashboardSummaryFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<DashboardSummary> =>
    fetchApi<DashboardSummary>("/dashboard/summary"),
);

export const titleChartFn = createServerFn({ method: "GET" })
  .validator((input: ChartInput) => input)
  .handler(async ({ data }): Promise<TitleChart> => {
    const query = new URLSearchParams({ metric: data.metric });
    if (data.windowDays) query.set("windowDays", String(data.windowDays));
    if (data.groupBy) query.set("groupBy", data.groupBy);
    if (data.basis) query.set("basis", data.basis);
    return fetchApi<TitleChart>(`/dashboard/title-chart?${query.toString()}`);
  });

export const requestLanguageFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<"en" | "ru"> => {
    const request = getRequest();
    const header = request.headers.get("accept-language");
    return header?.toLowerCase().startsWith("ru") ? "ru" : "en";
  },
);
