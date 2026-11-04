import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Contract } from "../contract.js";
import { ApiError } from "../errors.js";
import type { AuthGuards } from "../auth/guards.js";
import { queryPage, validatedBody } from "../http.js";
import type {
  CreateTitleGroupInput,
  CreateTrackedTitleInput,
  MergeTitlesInput,
  NewExternalIdentifierInput,
  NewTitleVariantInput,
  TitleListFilters,
  UpdateTitleGroupInput,
  UpdateTrackedTitleInput,
} from "./service.js";
import type { CatalogueService } from "./service.js";

export function registerCatalogueRoutes(
  app: FastifyInstance,
  service: CatalogueService,
  contract: Contract,
  guards: AuthGuards,
): void {
  const operator = [guards.requireBootstrapped, guards.authenticate];

  function body<T>(request: FastifyRequest, name: string): T {
    return validatedBody<T>(contract, request, name);
  }

  app.get(
    "/title-groups",
    { preHandler: operator },
    async (request) => service.listTitleGroups(queryPage(request)),
  );

  app.post(
    "/title-groups",
    { preHandler: operator },
    async (request, reply) => {
      const group = await service.createTitleGroup(
        body<CreateTitleGroupInput>(request, "CreateTitleGroupRequest"),
      );
      return reply.status(201).send(group);
    },
  );

  app.get(
    "/title-groups/:titleGroupId",
    { preHandler: operator },
    async (request) => {
      const { titleGroupId } = request.params as { titleGroupId: string };
      return service.readTitleGroup(titleGroupId);
    },
  );

  app.patch(
    "/title-groups/:titleGroupId",
    { preHandler: operator },
    async (request) => {
      const { titleGroupId } = request.params as { titleGroupId: string };
      return service.updateTitleGroup(
        titleGroupId,
        body<UpdateTitleGroupInput>(request, "UpdateTitleGroupRequest"),
      );
    },
  );

  app.get("/titles", { preHandler: operator }, async (request) => {
    const query = request.query as {
      titleGroupId?: string;
      query?: string;
      paused?: string;
    };
    const filters: TitleListFilters = {
      titleGroupId: query.titleGroupId,
      query: query.query,
      paused:
        query.paused === undefined ? undefined : query.paused === "true",
    };
    return service.listTitles(filters, queryPage(request));
  });

  app.post("/titles", { preHandler: operator }, async (request, reply) => {
    const title = await service.createTitle(
      body<CreateTrackedTitleInput>(request, "CreateTrackedTitleRequest"),
      request.auth!.operator.id,
    );
    return reply.status(201).send(title);
  });

  app.get("/titles/:trackedTitleId", { preHandler: operator }, async (request) => {
    const { trackedTitleId } = request.params as { trackedTitleId: string };
    return service.readTitle(trackedTitleId);
  });

  app.patch(
    "/titles/:trackedTitleId",
    { preHandler: operator },
    async (request) => {
      const { trackedTitleId } = request.params as { trackedTitleId: string };
      return service.updateTitle(
        trackedTitleId,
        body<UpdateTrackedTitleInput>(request, "UpdateTrackedTitleRequest"),
        request.auth!.operator.id,
      );
    },
  );

  app.post(
    "/titles/:trackedTitleId/variants",
    { preHandler: operator },
    async (request, reply) => {
      const { trackedTitleId } = request.params as { trackedTitleId: string };
      const recorded = await service.addVariant(
        trackedTitleId,
        body<NewTitleVariantInput>(request, "NewTitleVariant"),
        request.auth!.operator.id,
      );
      return reply.status(201).send(recorded);
    },
  );

  app.post(
    "/titles/:trackedTitleId/external-identifiers",
    { preHandler: operator },
    async (request, reply) => {
      const { trackedTitleId } = request.params as { trackedTitleId: string };
      const identifier = await service.addExternalIdentifier(
        trackedTitleId,
        body<NewExternalIdentifierInput>(request, "NewExternalIdentifier"),
      );
      return reply.status(201).send(identifier);
    },
  );

  app.delete(
    "/titles/:trackedTitleId/external-identifiers/:externalIdentifierId",
    { preHandler: operator },
    async (request, reply) => {
      const { trackedTitleId, externalIdentifierId } = request.params as {
        trackedTitleId: string;
        externalIdentifierId: string;
      };
      await service.removeExternalIdentifier(trackedTitleId, externalIdentifierId);
      return reply.status(204).send();
    },
  );

  app.post(
    "/titles/:trackedTitleId/merge",
    { preHandler: operator },
    async (request) => {
      const { trackedTitleId } = request.params as { trackedTitleId: string };
      return service.mergeTitles(
        trackedTitleId,
        body<MergeTitlesInput>(request, "MergeTitlesRequest"),
        request.auth!.operator.id,
      );
    },
  );

  app.get(
    "/catalogue/suggestions",
    { preHandler: operator },
    async (request) => {
      const query = request.query as { query?: string; titleGroupId?: string };
      return service.search(query.query ?? "", query.titleGroupId);
    },
  );

  app.get(
    "/catalogue/wikidata-suggestions",
    { preHandler: operator },
    async (request) => {
      const query = request.query as { query?: string; locale?: string };
      const suggestions = await service.searchWikidata(
        query.query ?? "",
        query.locale ?? "en",
      );
      return { query: (query.query ?? "").trim(), suggestions };
    },
  );

  app.get(
    "/catalogue/wikidata-entities/:qid",
    { preHandler: operator },
    async (request) => {
      const { qid } = request.params as { qid: string };
      if (!/^Q\d+$/.test(qid)) {
        throw new ApiError(404, "not_found", "No such Wikidata entity.");
      }
      return service.readWikidataEntity(qid);
    },
  );
}
