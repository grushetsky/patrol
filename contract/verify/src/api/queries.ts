import { queryOptions } from "@tanstack/react-query";
import type { paths } from "../generated/openapi";
import { api } from "./client";

/**
 * The decision body's type comes from the generated OpenAPI document, so a
 * change to the TypeSpec request model breaks this file at compile time.
 */
export type ReviewDecisionBody = NonNullable<
  paths["/candidates/{candidateId}/review-decisions"]["post"]["requestBody"]
>["content"]["application/json"];

/**
 * Query options own the fetch; the route loader only decides when to await it.
 * Every parameter is optional in the contract, so no page or size argument is
 * required by the generated client.
 */
export const candidatesQuery = queryOptions({
  queryKey: ["candidates", { page: 1, pageSize: 50 }],
  queryFn: async () => {
    const { data, error, response } = await api.GET("/candidates", {
      params: { query: { page: 1, pageSize: 50 } },
    });
    if (error) {
      throw new Error(`GET /candidates failed: ${response.status}`);
    }
    return data;
  },
});

/**
 * The mutation carries the double-submit token the contract requires on every
 * state-changing request.
 */
export async function decideCandidate(
  candidateId: string,
  body: ReviewDecisionBody,
  csrfToken: string,
) {
  const { data, error, response } = await api.POST(
    "/candidates/{candidateId}/review-decisions",
    {
      params: {
        path: { candidateId },
        header: { "X-Patrol-CSRF": csrfToken },
      },
      body,
    },
  );
  if (error) {
    throw new Error(
      `POST /candidates/${candidateId}/review-decisions failed: ${response.status} ${error.code}`,
    );
  }
  return data;
}
