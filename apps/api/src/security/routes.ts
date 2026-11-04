import type { FastifyInstance } from "fastify";
import type { AuthGuards } from "../auth/guards.js";
import { queryPage } from "../http.js";
import type { SecurityEventFilters, SecurityEventService } from "./service.js";

export function registerSecurityRoutes(
  app: FastifyInstance,
  service: SecurityEventService,
  guards: AuthGuards,
): void {
  const administrator = [
    guards.requireBootstrapped,
    guards.authenticate,
    guards.requireAdmin,
  ];

  app.get("/security-events", { preHandler: administrator }, async (request) => {
    const query = request.query as { kind?: string; operatorId?: string };
    const filters: SecurityEventFilters = {
      kind: query.kind,
      operatorId: query.operatorId,
    };
    return service.list(filters, queryPage(request));
  });
}
