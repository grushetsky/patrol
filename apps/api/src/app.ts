import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { Contract } from "./contract.js";
import type { Connectable } from "./db/migrations.js";
import { currentVersion } from "./db/migrations.js";
import { ApiError, ValidationError } from "./errors.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { AuthService } from "./auth/service.js";
import { createAuthGuards, registerCsrfHook } from "./auth/guards.js";
import { localize, resolveLanguage } from "./auth/messages.js";
import { CatalogueService } from "./catalogue/service.js";
import { registerCatalogueRoutes } from "./catalogue/routes.js";
import { SettingsService } from "./settings/service.js";
import { registerSettingsRoutes } from "./settings/routes.js";
import { ScanService } from "./scans/service.js";
import { registerScanRoutes } from "./scans/routes.js";
import { EvidenceService } from "./evidence/service.js";
import { registerEvidenceRoutes } from "./evidence/routes.js";
import { CandidateService } from "./review/service.js";
import { registerCandidateRoutes } from "./review/routes.js";
import { ViolationService } from "./violations/service.js";
import { registerViolationRoutes } from "./violations/routes.js";
import {
  storeFromEnvironment,
  type ArtifactStore,
} from "./evidence/store.js";

export interface AppOptions {
  db: Connectable;
  contract: Contract;
  buildVersion: string;
  expectedMigration: string;
  logger?: boolean;
  auth?: AuthService;
  catalogue?: CatalogueService;
  settings?: SettingsService;
  scans?: ScanService;
  candidates?: CandidateService;
  violations?: ViolationService;
  evidenceStore?: ArtifactStore;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true,
    genReqId: () => randomUUID(),
  });
  const auth = options.auth ?? new AuthService(options.db);
  const catalogue = options.catalogue ?? new CatalogueService(options.db);
  const settings = options.settings ?? new SettingsService(options.db);
  const scans = options.scans ?? new ScanService(options.db);
  const candidates = options.candidates ?? new CandidateService(options.db);
  const violations = options.violations ?? new ViolationService(options.db);
  const evidence = new EvidenceService(
    options.db,
    options.evidenceStore ?? storeFromEnvironment(),
  );
  const guards = createAuthGuards(auth);

  app.setErrorHandler(async (error, request, reply) => {
    const language =
      request.auth?.operator.preferredLanguage ??
      resolveLanguage(request.headers["accept-language"]);
    if (error instanceof ApiError) {
      if (error.retryAfterSeconds !== undefined) {
        reply.header("retry-after", String(error.retryAfterSeconds));
      }
      return reply.status(error.statusCode).send({
        ...error.extras,
        code: error.code,
        message: localize(error.code, language, error.message),
        ...(error.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
      });
    }
    if (error instanceof ValidationError) {
      return reply.status(400).send({
        code: "validation_failed",
        message: localize("validation_failed", language, error.message),
        fieldErrors: error.issues,
      });
    }
    request.log.error(error);
    return reply.status(500).send({
      code: "internal_error",
      message: localize("internal_error", language, "Internal server error."),
    });
  });

  app.setNotFoundHandler(async (_request, reply) =>
    reply.status(404).send({
      code: "not_found",
      message: "No such route.",
    }),
  );

  app.get("/health", async () => ({ status: "ok" }));

  app.register(
    async (api) => {
      registerCsrfHook(api);

      api.get("/system/version", async () => {
        const migrationVersion = await currentVersion(options.db);
        return {
          buildVersion: options.buildVersion,
          migrationVersion,
          schemaCompatible: migrationVersion === options.expectedMigration,
        };
      });

      api.get("/system/setup", async () => auth.setupState());
      registerAuthRoutes(api, auth, options.contract);
      registerCatalogueRoutes(api, catalogue, options.contract, guards);
      registerSettingsRoutes(api, settings, options.contract, guards);
      registerScanRoutes(api, scans, options.contract, guards);
      registerCandidateRoutes(api, candidates, options.contract, guards);
      registerViolationRoutes(api, violations, options.contract, guards);
      registerEvidenceRoutes(api, evidence, options.contract, guards);
    },
    { prefix: "/api" },
  );

  return app;
}
