import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Contract } from "../contract.js";
import type { AuthGuards } from "../auth/guards.js";
import { queryPage, validatedBody } from "../http.js";
import type {
  CandidateFilters,
  CandidateService,
  ManualCandidateInput,
  ReviewDecisionInput,
} from "./service.js";

export function registerCandidateRoutes(
  app: FastifyInstance,
  service: CandidateService,
  contract: Contract,
  guards: AuthGuards,
): void {
  const operator = [guards.requireBootstrapped, guards.authenticate];

  function body<T>(request: FastifyRequest, name: string): T {
    return validatedBody<T>(contract, request, name);
  }

  app.get("/candidates", { preHandler: operator }, async (request) => {
    const query = request.query as {
      state?: string;
      titleGroupId?: string;
      engine?: string;
      band?: string;
      allowlistHit?: string;
      hostObjectionId?: string;
    };
    const filters: CandidateFilters = {
      state: query.state,
      titleGroupId: query.titleGroupId,
      engine: query.engine,
      band: query.band,
      allowlistHit:
        query.allowlistHit === undefined
          ? undefined
          : query.allowlistHit === "true",
      hostObjectionId: query.hostObjectionId,
    };
    return service.list(filters, queryPage(request));
  });

  app.post("/candidates", { preHandler: operator }, async (request, reply) => {
    const result = await service.create(
      body<ManualCandidateInput>(request, "ManualCandidateRequest"),
      request.auth!.operator.id,
    );
    return reply.status(result.created ? 201 : 200).send(result.candidate);
  });

  app.get("/candidates/:candidateId", { preHandler: operator }, async (request) => {
    const { candidateId } = request.params as { candidateId: string };
    return service.read(candidateId);
  });

  app.post(
    "/candidates/:candidateId/review-decisions",
    { preHandler: operator },
    async (request, reply) => {
      const { candidateId } = request.params as { candidateId: string };
      const result = await service.decide(
        candidateId,
        body<ReviewDecisionInput>(request, "ReviewDecisionRequest"),
        request.auth!.operator.id,
      );
      return reply.status(201).send(result);
    },
  );

  app.post(
    "/candidates/:candidateId/reopen",
    { preHandler: operator },
    async (request) => {
      const { candidateId } = request.params as { candidateId: string };
      const input = body<{ note?: string }>(
        request,
        "CandidateReopenRequest",
      );
      return service.reopen(
        candidateId,
        input.note,
        request.auth!.operator.id,
      );
    },
  );

  app.post(
    "/candidates/:candidateId/captures",
    { preHandler: operator },
    async (request, reply) => {
      const { candidateId } = request.params as { candidateId: string };
      const input = body<{ reason: string }>(request, "CaptureRequest");
      const result = await service.capture(candidateId, input.reason);
      return reply.status(202).send(result);
    },
  );
}
