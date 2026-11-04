import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Contract } from "../contract.js";
import type { AuthGuards } from "../auth/guards.js";
import { queryPage, validatedBody } from "../http.js";
import type {
  ManualScanInput,
  RecheckFilters,
  ScanFilters,
  ScanService,
} from "./service.js";

export function registerScanRoutes(
  app: FastifyInstance,
  service: ScanService,
  contract: Contract,
  guards: AuthGuards,
): void {
  const operator = [guards.requireBootstrapped, guards.authenticate];

  function body<T>(request: FastifyRequest, name: string): T {
    return validatedBody<T>(contract, request, name);
  }

  app.get("/scans", { preHandler: operator }, async (request) => {
    const query = request.query as {
      titleGroupId?: string;
      engine?: string;
      state?: string;
      trigger?: string;
      dueDate?: string;
    };
    const filters: ScanFilters = {
      titleGroupId: query.titleGroupId,
      engine: query.engine,
      state: query.state,
      trigger: query.trigger,
      dueDate: query.dueDate,
    };
    return service.list(filters, queryPage(request));
  });

  app.post("/scans", { preHandler: operator }, async (request, reply) => {
    const result = await service.request(
      body<ManualScanInput>(request, "ManualScanRequest"),
      request.auth!.operator.id,
    );
    return reply.status(202).send(result);
  });

  app.get("/scans/:scanId", { preHandler: operator }, async (request) => {
    const { scanId } = request.params as { scanId: string };
    return service.read(scanId);
  });

  app.get(
    "/scans/:scanId/results",
    { preHandler: operator },
    async (request) => {
      const { scanId } = request.params as { scanId: string };
      return service.results(scanId, queryPage(request));
    },
  );

  app.get("/rechecks", { preHandler: operator }, async (request) => {
    const query = request.query as {
      titleGroupId?: string;
      engine?: string;
    };
    const filters: RecheckFilters = {
      titleGroupId: query.titleGroupId,
      engine: query.engine,
    };
    return service.rechecks(filters, queryPage(request));
  });
}
