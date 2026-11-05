import { queryOptions } from "@tanstack/react-query";
import { api, ApiError } from "./client";
import type { components } from "../generated/openapi";

type Schemas = components["schemas"];
export type NoticePage = Schemas["Http.NoticePage"];
export type NoticeCard = Schemas["Http.NoticeCard"];
export type NoticeDetail = Schemas["Http.NoticeDetail"];
export type TrackedTitlePage = Schemas["Http.TrackedTitlePage"];
export type TrackedTitleCard = Schemas["Http.TrackedTitleCard"];
export type AllowlistPage = Schemas["Http.AllowlistEntryPage"];
export type BudgetOverview = Schemas["Http.BudgetOverview"];

function unwrap<T>(result: {
  data?: T;
  error?: unknown;
  response: Response;
}): T {
  if (result.error || result.data === undefined) {
    throw new ApiError(result.response.status, result.error);
  }
  return result.data;
}

export const noticesQuery = queryOptions({
  queryKey: ["notices"],
  queryFn: async () =>
    unwrap(await api.GET("/notices", { params: { query: { pageSize: 100 } } })),
});

export function noticeDetailQuery(noticeId: string) {
  return queryOptions({
    queryKey: ["notice", noticeId],
    queryFn: async () =>
      unwrap(
        await api.GET("/notices/{noticeId}", {
          params: { path: { noticeId } },
        }),
      ),
  });
}

export async function approveNotice(
  noticeId: string,
  csrfToken: string,
  statementVersion: string,
) {
  return unwrap(
    await api.POST("/notices/{noticeId}/approval", {
      params: {
        path: { noticeId },
        header: { "X-Patrol-CSRF": csrfToken },
      },
      body: {
        statementVersion,
        attestation: {
          reviewedViolations: true,
          currentStatements: true,
          authorizedSignatory: true,
        },
      },
    }),
  );
}

export async function withdrawNotice(
  noticeId: string,
  csrfToken: string,
  reason: string,
) {
  return unwrap(
    await api.POST("/notices/{noticeId}/withdrawal", {
      params: {
        path: { noticeId },
        header: { "X-Patrol-CSRF": csrfToken },
      },
      body: reason ? { reason } : {},
    }),
  );
}

export async function noticePack(noticeId: string) {
  return unwrap(
    await api.GET("/notices/{noticeId}/pack", {
      params: { path: { noticeId } },
    }),
  );
}

export const titlesQuery = queryOptions({
  queryKey: ["titles"],
  queryFn: async () =>
    unwrap(await api.GET("/titles", { params: { query: { pageSize: 200 } } })),
});

export async function setTitlePaused(
  trackedTitleId: string,
  csrfToken: string,
  paused: boolean,
) {
  return unwrap(
    await api.PATCH("/titles/{trackedTitleId}", {
      params: {
        path: { trackedTitleId },
        header: { "X-Patrol-CSRF": csrfToken },
      },
      body: { paused },
    }),
  );
}

export const allowlistQuery = queryOptions({
  queryKey: ["allowlist"],
  queryFn: async () =>
    unwrap(
      await api.GET("/settings/allowlist", {
        params: { query: { pageSize: 200 } },
      }),
    ),
});

export async function createAllowlistEntry(
  csrfToken: string,
  input: Schemas["Http.CreateAllowlistEntryRequest"],
) {
  return unwrap(
    await api.POST("/settings/allowlist", {
      params: { header: { "X-Patrol-CSRF": csrfToken } },
      body: input,
    }),
  );
}

export async function removeAllowlistEntry(
  allowlistEntryId: string,
  csrfToken: string,
) {
  const result = await api.DELETE("/settings/allowlist/{allowlistEntryId}", {
    params: {
      path: { allowlistEntryId },
      header: { "X-Patrol-CSRF": csrfToken },
    },
  });
  if (result.error) throw new ApiError(result.response.status, result.error);
}

export const budgetQuery = queryOptions({
  queryKey: ["budget"],
  queryFn: async () => unwrap(await api.GET("/settings/budget")),
});
