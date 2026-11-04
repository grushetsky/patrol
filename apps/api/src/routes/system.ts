import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { AppConfig } from "../config.js";
import { t } from "@patrol/i18n";
import type { DeploymentSetupState } from "../domain/bootstrap.js";

/** The system routes' view of the database's bootstrap bookkeeping. */
export interface SystemDeps {
  config: AppConfig;
  /** Reads the patrol_meta stamp; null before any migration is recorded. */
  schemaStamp: () => Promise<number | null>;
  /** Reads the rights-holder and administrator counts setup gating uses. */
  setupState: () => Promise<DeploymentSetupState>;
}

/**
 * GET /health, /system/version, /system/setup per the contract's System and
 * Health interfaces. The shapes follow system.tsp exactly: migrationVersion
 * is the migration the image carries, and a database whose stamp does not
 * match answers 503 schema_mismatch (ServiceUnavailable) instead of the
 * VersionReport, so the pipeline reads readiness from the status code.
 */
export function systemRoutes(deps: SystemDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    app.get("/health", async () => ({ status: "ok" }));

    app.get("/system/version", async (request, reply) => {
      const stamp = await deps.schemaStamp();
      if (stamp === null || stamp !== deps.config.schemaStamp) {
        reply.status(503);
        return {
          code: "schema_mismatch",
          message: t(request.locale, "errors.schema_mismatch"),
        };
      }
      return {
        buildVersion: deps.config.buildVersion,
        migrationVersion: String(deps.config.schemaStamp),
        schemaCompatible: true,
      };
    });

    app.get("/system/setup", async () => {
      // Slice 1: the real bootstrap state — the rights holder's existence
      // and the administrator count the setup gating reads.
      const state = await deps.setupState();
      return {
        bootstrapped: state.bootstrapped,
        rightsHolderConfigured: state.rightsHolderConfigured,
        administratorCount: state.administratorCount,
      };
    });
  };
}
