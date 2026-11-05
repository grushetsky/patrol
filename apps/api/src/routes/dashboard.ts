import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { requestLocale } from "../i18n.js";
import { readDashboardSummary } from "../domain/dashboard/summary.js";
import { readTitleChart, type ChartRequest } from "../domain/dashboard/chart.js";

/**
 * The Dashboard interface (Patrol.Http), slice 8's surface: the summary —
 * counters, engine quota row, activity feed — and the title chart with its
 * three metrics. Both are reads over the tables the earlier slices own; the
 * chart's query parameters are validated here so the domain receives parsed
 * values and the contract's BadRequest answers an unknown enum value.
 */

export interface DashboardRoutesDeps {
  config: AppConfig;
  pool: Pool;
}

/** Parses one enum-valued query parameter, answering its value or 400. */
function enumParam<T extends string>(
  query: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): T {
  const raw = query[name];
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    throw new ApiError(400, "validation_failed", {
      fieldErrors: [
        { path: `/${name}`, message: `must be one of ${allowed.join(", ")}` },
      ],
    });
  }
  return raw as T;
}

export function dashboardRoutes(deps: DashboardRoutesDeps): FastifyPluginAsync {
  const { config, pool } = deps;
  return async (app: FastifyInstance) => {
    app.get("/dashboard/summary", async (request) =>
      readDashboardSummary(pool, config.now, requestLocale(request)),
    );

    app.get("/dashboard/title-chart", async (request) => {
      const query = request.query as Record<string, unknown>;
      const metric = enumParam(query, "metric", [
        "tracked_titles",
        "titles_with_violations",
        "resolved_violations",
      ] as const);
      // windowDays is an int32 enum on the wire; anything but 7, 14, or 30
      // is refused, and its absence defaults to the design's 14.
      let windowDays: ChartRequest["windowDays"] = 14;
      if (query.windowDays !== undefined) {
        const raw = String(query.windowDays);
        if (raw !== "7" && raw !== "14" && raw !== "30") {
          throw new ApiError(400, "validation_failed", {
            fieldErrors: [
              { path: "/windowDays", message: "must be one of 7, 14, 30" },
            ],
          });
        }
        windowDays = Number(raw) as ChartRequest["windowDays"];
      }
      const groupBy =
        query.groupBy === undefined
          ? "none"
          : enumParam(query, "groupBy", ["none", "title_group", "engine", "recipient"] as const);
      const basis =
        query.basis === undefined
          ? "removed_and_closed"
          : enumParam(query, "basis", ["removed_and_closed", "closed_only"] as const);
      return readTitleChart(pool, config.now, requestLocale(request), {
        metric,
        windowDays,
        groupBy,
        basis,
      });
    });
  };
}
