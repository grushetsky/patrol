import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Contract } from "../contract.js";
import type { AuthGuards } from "../auth/guards.js";
import { queryPage, validatedBody } from "../http.js";
import type {
  AcquisitionBudgetInput,
  AllowlistFilters,
  CapacityQuery,
  CreateAllowlistEntryInput,
  UpdateRecipientProfileInput,
  UpdateRightsHolderInput,
} from "./service.js";
import type { SettingsService } from "./service.js";

export function registerSettingsRoutes(
  app: FastifyInstance,
  service: SettingsService,
  contract: Contract,
  guards: AuthGuards,
): void {
  const operator = [guards.requireBootstrapped, guards.authenticate];
  const administrator = [
    guards.requireBootstrapped,
    guards.authenticate,
    guards.requireAdmin,
  ];

  function body<T>(request: FastifyRequest, name: string): T {
    return validatedBody<T>(contract, request, name);
  }

  app.get(
    "/settings/rights-holder",
    { preHandler: operator },
    async (request) =>
      service.readRightsHolder(request.auth!.operator.id),
  );

  app.patch(
    "/settings/rights-holder",
    { preHandler: administrator },
    async (request) =>
      service.updateRightsHolder(
        body<UpdateRightsHolderInput>(request, "UpdateRightsHolderRequest"),
        request.auth!.operator.id,
      ),
  );

  app.get(
    "/settings/budget",
    { preHandler: operator },
    async (request) => service.readBudget(request.auth!.operator.id),
  );

  app.put(
    "/settings/budget",
    { preHandler: administrator },
    async (request) =>
      service.updateBudget(
        body<AcquisitionBudgetInput>(request, "AcquisitionBudget"),
        request.auth!.operator.id,
      ),
  );

  app.get(
    "/settings/budget/capacity",
    { preHandler: operator },
    async (request) => {
      const query = request.query as { locales?: string; cadence?: string };
      const capacity: CapacityQuery = {
        locales: query.locales === undefined ? undefined : Number(query.locales),
        cadence: query.cadence,
      };
      return service.readCapacity(capacity, request.auth!.operator.id);
    },
  );

  app.get(
    "/settings/recipient-profiles",
    { preHandler: operator },
    async (request) =>
      service.listRecipientProfiles(queryPage(request), request.auth!.operator.id),
  );

  app.patch(
    "/settings/recipient-profiles/:recipientProfileId",
    { preHandler: administrator },
    async (request) => {
      const { recipientProfileId } = request.params as {
        recipientProfileId: string;
      };
      return service.updateRecipientProfile(
        recipientProfileId,
        body<UpdateRecipientProfileInput>(
          request,
          "UpdateRecipientProfileRequest",
        ),
        request.auth!.operator.id,
      );
    },
  );

  app.post(
    "/settings/recipient-profiles/:recipientProfileId/clearance",
    { preHandler: administrator },
    async (request) => {
      const { recipientProfileId } = request.params as {
        recipientProfileId: string;
      };
      const input = body<{ reason: string }>(
        request,
        "ClearProfilePauseRequest",
      );
      return service.clearProfilePause(
        recipientProfileId,
        input.reason,
        request.auth!.operator.id,
      );
    },
  );

  app.get(
    "/settings/allowlist",
    { preHandler: operator },
    async (request) => {
      const query = request.query as {
        kind?: string;
        scope?: string;
        territory?: string;
      };
      const filters: AllowlistFilters = {
        kind: query.kind,
        scope: query.scope,
        territory: query.territory,
      };
      return service.listAllowlist(filters, queryPage(request));
    },
  );

  app.post(
    "/settings/allowlist",
    { preHandler: operator },
    async (request, reply) => {
      const entry = await service.createAllowlistEntry(
        body<CreateAllowlistEntryInput>(request, "CreateAllowlistEntryRequest"),
        request.auth!.operator.id,
      );
      return reply.status(201).send(entry);
    },
  );

  app.delete(
    "/settings/allowlist/:allowlistEntryId",
    { preHandler: operator },
    async (request, reply) => {
      const { allowlistEntryId } = request.params as {
        allowlistEntryId: string;
      };
      await service.removeAllowlistEntry(
        allowlistEntryId,
        request.auth!.operator.id,
      );
      return reply.status(204).send();
    },
  );
}
