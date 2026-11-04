import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Contract } from "../contract.js";
import type { AuthGuards } from "../auth/guards.js";
import { queryPage, validatedBody } from "../http.js";
import type {
  EvidenceService,
  HostObjectionFilters,
} from "./service.js";

export function registerEvidenceRoutes(
  app: FastifyInstance,
  service: EvidenceService,
  contract: Contract,
  guards: AuthGuards,
): void {
  const operator = [guards.requireBootstrapped, guards.authenticate];

  function body<T>(request: FastifyRequest, name: string): T {
    return validatedBody<T>(contract, request, name);
  }

  app.get("/evidence/:evidenceId", { preHandler: operator }, async (request) => {
    const { evidenceId } = request.params as { evidenceId: string };
    return service.read(evidenceId);
  });

  app.get(
    "/evidence/:evidenceId/artifacts/:sha256/download",
    { preHandler: operator },
    async (request) => {
      const { evidenceId, sha256 } = request.params as {
        evidenceId: string;
        sha256: string;
      };
      return service.download(evidenceId, sha256);
    },
  );

  app.get("/host-objections", { preHandler: operator }, async (request) => {
    const query = request.query as { host?: string; active?: string };
    const filters: HostObjectionFilters = {
      host: query.host,
      active: query.active === undefined ? undefined : query.active === "true",
    };
    return service.listObjections(filters, queryPage(request));
  });

  app.post(
    "/host-objections/:hostObjectionId/clearance",
    { preHandler: operator },
    async (request) => {
      const { hostObjectionId } = request.params as {
        hostObjectionId: string;
      };
      const input = body<{ reason: string }>(
        request,
        "ClearHostObjectionRequest",
      );
      return service.clearObjection(
        hostObjectionId,
        input.reason,
        request.auth!.operator.id,
      );
    },
  );
}
