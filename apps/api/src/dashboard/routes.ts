import type { FastifyInstance } from "fastify";
import type { AuthGuards } from "../auth/guards.js";
import type { ChartQuery, DashboardService } from "./service.js";

export function registerDashboardRoutes(
  app: FastifyInstance,
  service: DashboardService,
  guards: AuthGuards,
): void {
  const operator = [guards.requireBootstrapped, guards.authenticate];

  app.get("/dashboard/summary", { preHandler: operator }, async (request) =>
    service.summary(request.auth!.operator.id),
  );

  app.get(
    "/dashboard/title-chart",
    { preHandler: operator },
    async (request) => {
      const query = request.query as {
        metric?: string;
        windowDays?: string;
        groupBy?: string;
        basis?: string;
      };
      const input: ChartQuery = {
        metric: query.metric ?? "",
        windowDays:
          query.windowDays === undefined ? undefined : Number(query.windowDays),
        groupBy: query.groupBy,
        basis: query.basis,
      };
      return service.chart(input);
    },
  );
}
