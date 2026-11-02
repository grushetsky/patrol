import { queryOptions } from "@tanstack/react-query";
import type { paths } from "../../generated/openapi";
import { api } from "./client";

type CreateNoticeBody =
  paths["/violations/{id}/notices"]["post"]["requestBody"]["content"]["application/json"];

/**
 * Query options own the fetch; the router loader only decides when to await it.
 * The parameter types come from the generated OpenAPI types (`page` and
 * `pageSize` are required because TypeSpec defaults emit `required: true`).
 */
export const violationsQuery = queryOptions({
  queryKey: ["violations", { page: 1, pageSize: 20 }],
  queryFn: async () => {
    const { data, error, response } = await api.GET("/violations", {
      params: { query: { page: 1, pageSize: 20 } },
    });
    if (error) {
      throw new Error(`GET /violations failed: ${response.status}`);
    }
    return data;
  },
});

export const violationQuery = (id: string) =>
  queryOptions({
    queryKey: ["violations", id],
    queryFn: async () => {
      const { data, error, response } = await api.GET("/violations/{id}", {
        params: { path: { id } },
      });
      if (error) {
        throw new Error(`GET /violations/${id} failed: ${response.status}`);
      }
      return data;
    },
  });

export const createNotice = async (id: string, body: CreateNoticeBody) => {
  const { data, error, response } = await api.POST("/violations/{id}/notices", {
    params: { path: { id } },
    body,
  });
  if (error) {
    throw new Error(`POST /violations/${id}/notices failed: ${response.status}`);
  }
  return data;
};
