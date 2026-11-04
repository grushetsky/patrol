import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Contract } from "../contract.js";
import type { AuthGuards } from "../auth/guards.js";
import { queryPage, validatedBody } from "../http.js";
import type {
  ApprovalInput,
  ComposeInput,
  NoticeFilters,
  NoticeService,
  SupersessionInput,
} from "./service.js";

export function registerNoticeRoutes(
  app: FastifyInstance,
  service: NoticeService,
  contract: Contract,
  guards: AuthGuards,
): void {
  const operator = [guards.requireBootstrapped, guards.authenticate];

  function body<T>(request: FastifyRequest, name: string): T {
    return validatedBody<T>(contract, request, name);
  }

  app.get("/notices", { preHandler: operator }, async (request) => {
    const query = request.query as { state?: string; recipient?: string };
    const filters: NoticeFilters = {
      state: query.state,
      recipient: query.recipient,
    };
    return service.list(filters, queryPage(request));
  });

  app.post("/notices", { preHandler: operator }, async (request, reply) => {
    const result = await service.compose(
      body<ComposeInput>(request, "CreateNoticeRequest"),
      request.auth!.operator.id,
    );
    return reply.status(201).send(result);
  });

  app.get("/notices/:noticeId", { preHandler: operator }, async (request) => {
    const { noticeId } = request.params as { noticeId: string };
    return service.read(noticeId);
  });

  app.post(
    "/notices/:noticeId/approval",
    { preHandler: operator },
    async (request) => {
      const { noticeId } = request.params as { noticeId: string };
      return service.approve(
        noticeId,
        body<ApprovalInput>(request, "NoticeApprovalRequest"),
        request.auth!.operator.id,
      );
    },
  );

  app.get(
    "/notices/:noticeId/pack",
    { preHandler: operator },
    async (request) => {
      const { noticeId } = request.params as { noticeId: string };
      return service.pack(noticeId);
    },
  );

  app.post(
    "/notices/:noticeId/withdrawal",
    { preHandler: operator },
    async (request) => {
      const { noticeId } = request.params as { noticeId: string };
      const input = body<{ reason?: string }>(
        request,
        "NoticeWithdrawalRequest",
      );
      return service.withdraw(
        noticeId,
        input.reason,
        request.auth!.operator.id,
      );
    },
  );

  app.post(
    "/notices/:noticeId/supersession",
    { preHandler: operator },
    async (request) => {
      const { noticeId } = request.params as { noticeId: string };
      return service.supersede(
        noticeId,
        body<SupersessionInput>(request, "NoticeSupersessionRequest"),
        request.auth!.operator.id,
      );
    },
  );
}
