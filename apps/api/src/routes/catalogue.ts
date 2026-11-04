import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { resolveLocale } from "../i18n.js";
import { pageParams } from "./support.js";
import {
  createTitleGroup,
  findTitleGroup,
  listTitleGroups,
  updateTitleGroup,
} from "../domain/catalogue/title-groups.js";
import {
  createTrackedTitle,
  listTrackedTitles,
  readTitleDetail,
  titleDetailJson,
  updateTrackedTitle,
} from "../domain/catalogue/tracked-titles.js";
import { addTitleVariant } from "../domain/catalogue/variants.js";
import {
  addExternalIdentifier,
  removeExternalIdentifier,
} from "../domain/catalogue/identifiers.js";
import { mergeTitles } from "../domain/catalogue/merge.js";
import { searchCatalogue } from "../domain/catalogue/suggestions.js";
import {
  WikidataUnavailableError,
  readWikidataEntity,
  searchWikidata,
} from "../upstream/wikidata.js";
import { titleGroupJson } from "../domain/catalogue/serialize.js";

/**
 * The Catalogue interfaces (Patrol.Http): title groups, tracked titles
 * with their variants and identifiers, the merge, and the two search
 * indexes behind the add-title field. Roles come from the contract's
 * x-patrol-roles; nothing here declares manual role metadata, so the
 * contract is the single source.
 */

export interface CatalogueRoutesDeps {
  config: AppConfig;
  pool: Pool;
}

export function catalogueRoutes(deps: CatalogueRoutesDeps): FastifyPluginAsync {
  const { config, pool } = deps;

  /** The interface language the request resolved to, for the Wikidata reads. */
  const requestLocale = (request: FastifyRequest): string =>
    request.locale ?? resolveLocale(undefined, request.headers["accept-language"]);

  return async (app: FastifyInstance) => {
    // -----------------------------------------------------------------
    // Title groups.

    app.get("/title-groups", async (request) =>
      listTitleGroups(pool, request.query as Record<string, unknown>),
    );

    app.post("/title-groups", async (request, reply) => {
      const body = app.validate(request.body, "CreateTitleGroupRequest") as {
        name: string;
        locales: string[];
        scanTime: string;
        priority: "high" | "normal" | "low";
      };
      const created = await createTitleGroup(pool, {
        name: body.name,
        locales: body.locales,
        scanTime: body.scanTime,
        priority: body.priority,
      });
      reply.status(201);
      return created;
    });

    app.get("/title-groups/:titleGroupId", async (request) => {
      const { titleGroupId } = request.params as { titleGroupId: string };
      const group = await findTitleGroup(pool, titleGroupId);
      if (group === null) {
        throw new ApiError(404, "not_found");
      }
      return titleGroupJson(group);
    });

    app.patch("/title-groups/:titleGroupId", async (request) => {
      const { titleGroupId } = request.params as { titleGroupId: string };
      const body = app.validate(request.body, "UpdateTitleGroupRequest") as {
        name?: string;
        locales?: string[];
        scanTime?: string;
        priority?: "high" | "normal" | "low";
      };
      return updateTitleGroup(pool, titleGroupId, {
        name: body.name,
        locales: body.locales,
        scanTime: body.scanTime,
        priority: body.priority,
      });
    });

    // -----------------------------------------------------------------
    // Tracked titles.

    app.get("/titles", async (request) => {
      const query = request.query as Record<string, unknown>;
      return listTrackedTitles(
        pool,
        {
          titleGroupId:
            typeof query.titleGroupId === "string" ? query.titleGroupId : undefined,
          query: typeof query.query === "string" ? query.query : undefined,
          paused: parseBoolean(query.paused),
        },
        pageParams(query),
      );
    });

    app.post("/titles", async (request, reply) => {
      const actor = request.session!;
      const body = app.validate(request.body, "CreateTrackedTitleRequest") as {
        titleGroupId: string;
        originalVariant: { text: string; language: string; script: string };
        releaseYear: number;
        titleType: "film" | "series" | "miniseries" | "other";
        runtimeMinutes?: number;
        additionalVariants: Array<{
          text: string;
          kind: "localized" | "transliterated" | "alternate";
          language: string;
          script: string;
          territory?: string;
          source: "rights_holder_record" | "operator_knowledge" | "wikidata";
        }>;
        externalIdentifiers: Array<{
          scheme: "wikidata" | "imdb" | "kinopoisk";
          value: string;
        }>;
        source: "rights_holder_record" | "operator_knowledge" | "wikidata";
      };
      const titleId = await createTrackedTitle(pool, config.now, actor.operator.id, {
        titleGroupId: body.titleGroupId,
        originalVariant: body.originalVariant,
        releaseYear: body.releaseYear,
        titleType: body.titleType,
        runtimeMinutes: body.runtimeMinutes,
        additionalVariants: body.additionalVariants,
        externalIdentifiers: body.externalIdentifiers,
        source: body.source,
      });
      reply.status(201);
      return titleDetailJson(await readTitleDetail(pool, titleId));
    });

    app.get("/titles/:trackedTitleId", async (request) => {
      const { trackedTitleId } = request.params as { trackedTitleId: string };
      return titleDetailJson(await readTitleDetail(pool, trackedTitleId));
    });

    app.patch("/titles/:trackedTitleId", async (request) => {
      const actor = request.session!;
      const { trackedTitleId } = request.params as { trackedTitleId: string };
      const body = app.validate(request.body, "UpdateTrackedTitleRequest") as {
        titleGroupId?: string;
        releaseYear?: number;
        titleType?: "film" | "series" | "miniseries" | "other";
        runtimeMinutes?: number;
        paused?: boolean;
      };
      await updateTrackedTitle(pool, config.now, trackedTitleId, actor.operator.id, {
        titleGroupId: body.titleGroupId,
        releaseYear: body.releaseYear,
        titleType: body.titleType,
        runtimeMinutes: body.runtimeMinutes,
        paused: body.paused,
      });
      return titleDetailJson(await readTitleDetail(pool, trackedTitleId));
    });

    app.post("/titles/:trackedTitleId/variants", async (request, reply) => {
      const actor = request.session!;
      const { trackedTitleId } = request.params as { trackedTitleId: string };
      const body = app.validate(request.body, "NewTitleVariant") as {
        text: string;
        kind: "original" | "localized" | "transliterated" | "alternate";
        language: string;
        script: string;
        territory?: string;
        source: "rights_holder_record" | "operator_knowledge" | "wikidata";
      };
      const added = await addTitleVariant(
        pool,
        config.now,
        trackedTitleId,
        actor.operator.id,
        body,
      );
      reply.status(201);
      return added;
    });

    app.post(
      "/titles/:trackedTitleId/external-identifiers",
      async (request, reply) => {
        const { trackedTitleId } = request.params as { trackedTitleId: string };
        const body = app.validate(request.body, "NewExternalIdentifier") as {
          scheme: "wikidata" | "imdb" | "kinopoisk";
          value: string;
        };
        reply.status(201);
        // Identifier facts recorded through creation carry the title's own
        // source; a standalone addition is operator knowledge by definition
        // — the operator typed it on the title's page.
        return addExternalIdentifier(pool, config.now, trackedTitleId, {
          scheme: body.scheme,
          value: body.value,
          source: "operator_knowledge",
        });
      },
    );

    app.delete(
      "/titles/:trackedTitleId/external-identifiers/:externalIdentifierId",
      async (request, reply) => {
        const { trackedTitleId, externalIdentifierId } = request.params as {
          trackedTitleId: string;
          externalIdentifierId: string;
        };
        await removeExternalIdentifier(pool, trackedTitleId, externalIdentifierId);
        reply.status(204);
        return null;
      },
    );

    app.post("/titles/:trackedTitleId/merge", async (request) => {
      const actor = request.session!;
      const { trackedTitleId } = request.params as { trackedTitleId: string };
      const body = app.validate(request.body, "MergeTitlesRequest") as {
        survivingTitleId: string;
      };
      return mergeTitles(pool, config.now, actor.operator.id, {
        duplicateId: trackedTitleId,
        survivingTitleId: body.survivingTitleId,
      });
    });

    // -----------------------------------------------------------------
    // The add-title field's two indexes.

    app.get("/catalogue/suggestions", async (request) => {
      const query = request.query as Record<string, unknown>;
      const text = typeof query.query === "string" ? query.query : "";
      // The contract's union here (ReadErrors | ServiceUnavailable) declares
      // no BadRequest, so an empty or absent query is not refused: the
      // search itself answers an empty result that still offers free-text
      // creation, exactly as the design's "always offers creation" puts it.
      return searchCatalogue(pool, {
        query: text,
        titleGroupId:
          typeof query.titleGroupId === "string" ? query.titleGroupId : undefined,
      });
    });

    app.get("/catalogue/wikidata-suggestions", async (request) => {
      const query = request.query as Record<string, unknown>;
      const text = typeof query.query === "string" ? query.query : "";
      const rawLocale = typeof query.locale === "string" ? query.locale : "";
      // The contract's union (ReadErrors | ServiceUnavailable) declares no
      // BadRequest and no NotFound, so neither an empty query nor a bad
      // locale can be refused: an empty query answers an empty result, and
      // a locale that is not a language tag coerces to English — the same
      // fallback the upstream applies to a language it does not know.
      const locale = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(rawLocale)
        ? rawLocale
        : "en";
      try {
        const suggestions = await searchWikidata(
          {
            origin: config.wikidataOrigin,
            userAgent: config.wikidataUserAgent,
            timeoutMs: config.upstreamTimeoutMs,
          },
          { query: text, locale },
        );
        return { query: text, suggestions };
      } catch (error) {
        // A Wikidata failure never blocks local suggestions or free-text
        // creation; this route alone answers 503.
        if (error instanceof WikidataUnavailableError) {
          throw new ApiError(503, "upstream_unavailable");
        }
        throw error;
      }
    });

    app.get("/catalogue/wikidata-entities/:qid", async (request) => {
      const { qid } = request.params as { qid: string };
      // The contract's union (ReadErrors | NotFound | ServiceUnavailable)
      // declares no BadRequest, so a malformed id is answered as not_found —
      // the closest declared code — rather than 400.
      if (!/^Q\d+$/.test(qid)) {
        throw new ApiError(404, "not_found");
      }
      try {
        const facts = await readWikidataEntity(
          {
            origin: config.wikidataOrigin,
            userAgent: config.wikidataUserAgent,
            timeoutMs: config.upstreamTimeoutMs,
          },
          qid,
          requestLocale(request),
        );
        if (facts === null) {
          throw new ApiError(404, "not_found");
        }
        return facts;
      } catch (error) {
        if (error instanceof WikidataUnavailableError) {
          throw new ApiError(503, "upstream_unavailable");
        }
        throw error;
      }
    });
  };
}

/** Parses a boolean query parameter: absent stays undefined. */
function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "true" || value === true) {
    return true;
  }
  if (value === "false" || value === false) {
    return false;
  }
  return undefined;
}
