import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { Contract } from "./contract.js";
import type { Connectable } from "./db/migrations.js";
import { currentVersion } from "./db/migrations.js";
import { ApiError, ValidationError } from "./errors.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { AuthService } from "./auth/service.js";
import { localize, resolveLanguage } from "./auth/messages.js";

export interface AppOptions {
  db: Connectable;
  contract: Contract;
  buildVersion: string;
  expectedMigration: string;
  logger?: boolean;
  auth?: AuthService;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true,
    genReqId: () => randomUUID(),
  });
  const auth = options.auth ?? new AuthService(options.db);

  app.setErrorHandler(async (error, request, reply) => {
    const language =
      request.auth?.operator.preferredLanguage ??
      resolveLanguage(request.headers["accept-language"]);
    if (error instanceof ApiError) {
      if (error.retryAfterSeconds !== undefined) {
        reply.header("retry-after", String(error.retryAfterSeconds));
      }
      return reply.status(error.statusCode).send({
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
    },
    { prefix: "/api" },
  );

  return app;
}
