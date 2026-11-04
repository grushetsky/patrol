import { queryOptions } from "@tanstack/react-query";
import { api, ApiError } from "./client";
import type { components } from "../generated/openapi";

type Schemas = components["schemas"];
export type CandidatePage = Schemas["Http.CandidatePage"];
export type CandidateReviewRow = Schemas["Http.CandidateReviewRow"];
export type ViolationPage = Schemas["Http.ViolationPage"];
export type ViolationRow = Schemas["Http.ViolationRow"];
export type RecipientProfilePage = Schemas["Http.RecipientProfilePage"];
export type ReviewDecisionAction = Schemas["Domain.ReviewDecisionAction"];
export type ReviewDecisionResult = Schemas["Http.ReviewDecisionResult"];
export type EvidenceDetail = Schemas["Http.EvidenceDetail"];

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

export const candidatesQuery = queryOptions({
  queryKey: ["candidates", "pending"],
  queryFn: async () =>
    unwrap(
      await api.GET("/candidates", {
        params: { query: { state: "pending", pageSize: 100 } },
      }),
    ),
});

export const violationsQuery = queryOptions({
  queryKey: ["violations", "open"],
  queryFn: async () =>
    unwrap(
      await api.GET("/violations", {
        params: { query: { state: "open", pageSize: 200 } },
      }),
    ),
});

export const recipientProfilesQuery = queryOptions({
  queryKey: ["recipient-profiles"],
  queryFn: async () =>
    unwrap(
      await api.GET("/settings/recipient-profiles", {
        params: { query: { pageSize: 50 } },
      }),
    ),
});

export function evidenceQuery(evidenceId: string) {
  return queryOptions({
    queryKey: ["evidence", evidenceId],
    queryFn: async () =>
      unwrap(await api.GET("/evidence/{evidenceId}", {
        params: { path: { evidenceId } },
      })),
  });
}

export async function decideCandidate(
  candidateId: string,
  csrfToken: string,
  input: {
    action: ReviewDecisionAction;
    evidenceIds: string[];
    note?: string;
    rematchedTrackedTitleId?: string;
  },
): Promise<ReviewDecisionResult> {
  return unwrap(
    await api.POST("/candidates/{candidateId}/review-decisions", {
      params: {
        path: { candidateId },
        header: { "X-Patrol-CSRF": csrfToken },
      },
      body: input,
    }),
  );
}

export async function createNotice(
  csrfToken: string,
  input: {
    recipient: string;
    recipientProfileId: string;
    violationIds: string[];
  },
) {
  return unwrap(
    await api.POST("/notices", {
      params: { header: { "X-Patrol-CSRF": csrfToken } },
      body: input as never,
    }),
  );
}

export async function closeViolation(
  violationId: string,
  csrfToken: string,
  input: { reason: "url_removed" | "operator_closed"; note?: string },
) {
  return unwrap(
    await api.POST("/violations/{violationId}/closure", {
      params: {
        path: { violationId },
        header: { "X-Patrol-CSRF": csrfToken },
      },
      body: input,
    }),
  );
}
