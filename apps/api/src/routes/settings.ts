import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { requestLocale } from "../i18n.js";
import { pageParams } from "./support.js";
import {
  countTrackedTitles,
  readBudgetCaps,
  readBudgetOverview,
  readRightsHolderRow,
  updateBudget,
  updateRightsHolder,
} from "../domain/catalogue/settings.js";
import { rightsHolderJson } from "../domain/catalogue/serialize.js";
import {
  clearProfilePause,
  listRecipientProfiles,
  updateRecipientProfile,
} from "../domain/catalogue/recipient-profiles.js";
import {
  createAllowlistEntry,
  listAllowlistEntries,
  removeAllowlistEntry,
} from "../domain/catalogue/allowlist.js";
import { projectCapacity, type Cadence } from "../domain/catalogue/capacity.js";

/**
 * The Settings interfaces (Patrol.Http): the rights holder and signatory,
 * the budget and its derived capacity, the recipient profiles, and the
 * scoped allowlist. Administrator-only writes carry no manual role
 * metadata — the contract's x-patrol-roles decides, so an operator's
 * session answers 403 on them while every operator reads.
 */

export interface SettingsRoutesDeps {
  config: AppConfig;
  pool: Pool;
}

export function settingsRoutes(deps: SettingsRoutesDeps): FastifyPluginAsync {
  const { config, pool } = deps;

  return async (app: FastifyInstance) => {
    // -----------------------------------------------------------------
    // Rights holder and signatory.

    app.get("/settings/rights-holder", async () =>
      rightsHolderJson(await readRightsHolderRow(pool)),
    );

    app.patch("/settings/rights-holder", async (request) => {
      const body = app.validate(request.body, "UpdateRightsHolderRequest") as {
        legalName?: string;
        country?: string;
        address?: {
          line1: string;
          line2?: string;
          city: string;
          region?: string;
          postalCode: string;
          country: string;
        };
        roleMailbox?: string;
        phone?: string;
        signatory?: {
          fullLegalName: string;
          authorityBasis: string;
          contactEmail: string;
          contactPhone?: string;
        };
      };
      return updateRightsHolder(pool, config.now, body);
    });

    // -----------------------------------------------------------------
    // Budget and capacity.

    app.get("/settings/budget", async (request) =>
      readBudgetOverview(pool, config.now, requestLocale(request)),
    );

    app.put("/settings/budget", async (request) => {
      const body = app.validate(request.body, "AcquisitionBudget") as {
        engineCaps: Array<{
          engine: "google" | "bing" | "yandex";
          currency: string;
          monthlyCapMinor: number;
        }>;
        recheckSharePercent: number;
      };
      await updateBudget(pool, config.now, body);
      return readBudgetOverview(pool, config.now, requestLocale(request));
    });

    app.get("/settings/budget/capacity", async (request) => {
      const query = request.query as Record<string, unknown>;
      const locales =
        query.locales === undefined
          ? 2
          : Number.parseInt(String(query.locales), 10);
      if (!Number.isInteger(locales) || locales < 1 || locales > 8) {
        throw new ApiError(400, "validation_failed", {
          fieldErrors: [
            { path: "/locales", message: "locales per title is a number from 1 to 8" },
          ],
        });
      }
      const cadence: Cadence =
        query.cadence === undefined || query.cadence === ""
          ? "daily"
          : (query.cadence as Cadence);
      if (cadence !== "daily" && cadence !== "every_other_day" && cadence !== "weekly") {
        throw new ApiError(400, "validation_failed", {
          fieldErrors: [
            { path: "/cadence", message: "cadence is daily, every_other_day, or weekly" },
          ],
        });
      }
      const caps = await readBudgetCaps(pool);
      return projectCapacity({
        monthlyCapsMinor: {
          google: caps.google,
          yandex: caps.yandex,
          bing: caps.bing,
        },
        recheckSharePercent: caps.recheckSharePercent,
        localesPerTitle: locales,
        cadence,
        trackedTitles: await countTrackedTitles(pool),
      });
    });

    // -----------------------------------------------------------------
    // Recipient profiles.

    app.get("/settings/recipient-profiles", async (request) =>
      listRecipientProfiles(pool, request.query as Record<string, unknown>),
    );

    app.patch("/settings/recipient-profiles/:recipientProfileId", async (request) => {
      const actor = request.session!;
      const { recipientProfileId } = request.params as {
        recipientProfileId: string;
      };
      const body = app.validate(request.body, "UpdateRecipientProfileRequest") as {
        channel?: "web_form" | "trusted_program";
        account?: string;
        contactEmail?: string;
        compositionTrigger?: "scheduled" | "on_demand";
        windowTime?: string;
        eligibleTerritories?: string[];
        maxUrlsPerNotice?: number;
        maxUrlsPerFile?: number;
        maxUrlsPerDay?: number;
      };
      return updateRecipientProfile(
        pool,
        config.now,
        recipientProfileId,
        actor.operator.id,
        body,
      );
    });

    app.post(
      "/settings/recipient-profiles/:recipientProfileId/clearance",
      async (request) => {
        const actor = request.session!;
        const { recipientProfileId } = request.params as {
          recipientProfileId: string;
        };
        const body = app.validate(request.body, "ClearProfilePauseRequest") as {
          reason: string;
        };
        return clearProfilePause(
          pool,
          config.now,
          recipientProfileId,
          actor.operator.id,
          body.reason,
        );
      },
    );

    // -----------------------------------------------------------------
    // Allowlist.

    app.get("/settings/allowlist", async (request) => {
      const query = request.query as Record<string, unknown>;
      // The contract's union for this read (ReadErrors) declares no
      // BadRequest — unlike the capacity read beside it — so an out-of-enum
      // kind or scope is treated as absent (the filter is dropped) rather
      // than refused, and a territory-shaped string simply matches nothing.
      return listAllowlistEntries(
        pool,
        {
          kind: isAllowlistKind(query.kind) ? query.kind : undefined,
          scope: isAllowlistScope(query.scope) ? query.scope : undefined,
          territory:
            typeof query.territory === "string" ? query.territory : undefined,
        },
        query,
      );
    });

    app.post("/settings/allowlist", async (request, reply) => {
      const actor = request.session!;
      const body = app.validate(request.body, "CreateAllowlistEntryRequest") as {
        kind: "official_domain" | "licensed_destination" | "neutral_source";
        matchKind: "host" | "url_prefix";
        value: string;
        scope: "rights_holder" | "title_group" | "tracked_title";
        titleGroupId?: string;
        trackedTitleId?: string;
        territory?: string;
      };
      const created = await createAllowlistEntry(
        pool,
        config.now,
        actor.operator.id,
        body,
      );
      reply.status(201);
      return created;
    });

    app.delete("/settings/allowlist/:allowlistEntryId", async (request, reply) => {
      const actor = request.session!;
      const { allowlistEntryId } = request.params as {
        allowlistEntryId: string;
      };
      await removeAllowlistEntry(pool, config.now, actor.operator.id, allowlistEntryId);
      reply.status(204);
      return null;
    });
  };
}

function isAllowlistKind(value: unknown): value is "official_domain" | "licensed_destination" | "neutral_source" {
  return (
    value === "official_domain" ||
    value === "licensed_destination" ||
    value === "neutral_source"
  );
}

function isAllowlistScope(value: unknown): value is "rights_holder" | "title_group" | "tracked_title" {
  return (
    value === "rights_holder" || value === "title_group" || value === "tracked_title"
  );
}
