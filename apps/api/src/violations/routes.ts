import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Contract } from "../contract.js";
import type { AuthGuards } from "../auth/guards.js";
import { queryPage, validatedBody } from "../http.js";
import type {
  ViolationClosureInput,
  ViolationFilters,
  ViolationService,
} from "./service.js";

export function registerViolationRoutes(
  app: FastifyInstance,
  service: ViolationService,
  contract: Contract,
  guards: AuthGuards,
): void {
  const operator = [guards.requireBootstrapped, guards.authenticate];

  function body<T>(request: FastifyRequest, name: string): T {
    return validatedBody<T>(contract, request, name);
  }

  app.get("/violations", { preHandler: operator }, async (request) => {
    const query = request.query as {
      trackedTitleId?: string;
      state?: string;
      noticeId?: string;
    };
    const filters: ViolationFilters = {
      trackedTitleId: query.trackedTitleId,
      state: query.state,
      noticeId: query.noticeId,
    };
    return service.list(filters, queryPage(request));
  });

  app.get(
    "/violations/:violationId",
    { preHandler: operator },
    async (request) => {
      const { violationId } = request.params as { violationId: string };
      return service.read(violationId);
    },
  );

  app.post(
    "/violations/:violationId/captures",
    { preHandler: operator },
    async (request, reply) => {
      const { violationId } = request.params as { violationId: string };
      const input = body<{ reason: string }>(request, "CaptureRequest");
      const result = await service.capture(violationId, input.reason);
      return reply.status(202).send(result);
    },
  );

  app.post(
    "/violations/:violationId/closure",
    { preHandler: operator },
    async (request) => {
      const { violationId } = request.params as { violationId: string };
      return service.close(
        violationId,
        body<ViolationClosureInput>(request, "ViolationClosureRequest"),
        request.auth!.operator.id,
      );
    },
  );
}
