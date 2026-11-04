import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Contract } from "../contract.js";
import type { AuthGuards } from "../auth/guards.js";
import { queryPage, validatedBody } from "../http.js";
import type {
  AcknowledgementInput,
  DeliveryInput,
  FailureInput,
  SubmissionFilters,
  SubmissionService,
} from "./service.js";

export function registerSubmissionRoutes(
  app: FastifyInstance,
  service: SubmissionService,
  contract: Contract,
  guards: AuthGuards,
): void {
  const operator = [guards.requireBootstrapped, guards.authenticate];

  function body<T>(request: FastifyRequest, name: string): T {
    return validatedBody<T>(contract, request, name);
  }

  app.get("/submissions", { preHandler: operator }, async (request) => {
    const query = request.query as {
      state?: string;
      noticeId?: string;
      olderThanDays?: string;
    };
    const filters: SubmissionFilters = {
      state: query.state,
      noticeId: query.noticeId,
      olderThanDays:
        query.olderThanDays === undefined
          ? undefined
          : Number(query.olderThanDays),
    };
    return service.list(filters, queryPage(request));
  });

  app.get(
    "/submissions/:submissionId",
    { preHandler: operator },
    async (request) => {
      const { submissionId } = request.params as { submissionId: string };
      return service.read(submissionId);
    },
  );

  app.post(
    "/submissions/:submissionId/delivery",
    { preHandler: operator },
    async (request) => {
      const { submissionId } = request.params as { submissionId: string };
      return service.deliver(
        submissionId,
        body<DeliveryInput>(request, "SubmissionDeliveryRequest"),
        request.auth!.operator.id,
      );
    },
  );

  app.post(
    "/submissions/:submissionId/acknowledgement",
    { preHandler: operator },
    async (request) => {
      const { submissionId } = request.params as { submissionId: string };
      return service.acknowledge(
        submissionId,
        body<AcknowledgementInput>(
          request,
          "AcknowledgementRecordRequest",
        ),
        request.auth!.operator.id,
      );
    },
  );

  app.post(
    "/submissions/:submissionId/failure",
    { preHandler: operator },
    async (request) => {
      const { submissionId } = request.params as { submissionId: string };
      return service.fail(
        submissionId,
        body<FailureInput>(request, "SubmissionFailureRequest"),
        request.auth!.operator.id,
      );
    },
  );

  app.post(
    "/submissions/:submissionId/retry",
    { preHandler: operator },
    async (request) => {
      const { submissionId } = request.params as { submissionId: string };
      return service.retry(submissionId, request.auth!.operator.id);
    },
  );
}
