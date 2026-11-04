import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { Contract } from "./contract.js";
import { currentVersion, type Queryable } from "./db/migrations.js";
import { ValidationError } from "./errors.js";

export interface AppOptions {
  db: Queryable;
  contract: Contract;
  buildVersion: string;
  expectedMigration: string;
  logger?: boolean;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true,
    genReqId: () => randomUUID(),
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ValidationError) {
      return reply.status(400).send({
        code: "validation_failed",
        message: error.message,
        fieldErrors: error.issues,
      });
    }
    request.log.error(error);
    return reply.status(500).send({
      code: "internal_error",
      message: "Internal server error.",
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
      api.post("/auth/sign-in", async (request, reply) => {
        const result = options.contract.validate("SignInRequest", request.body);
        if (!result.valid) {
          throw new ValidationError(result.issues);
        }
        return reply.status(503).send({
          code: "setup_required",
          message: "The deployment is not bootstrapped.",
        });
      });

      api.get("/system/version", async () => {
        const migrationVersion = await currentVersion(options.db);
        return {
          buildVersion: options.buildVersion,
          migrationVersion,
          schemaCompatible: migrationVersion === options.expectedMigration,
        };
      });

      api.get("/system/setup", async () => {
        // The identity migration arrives in slice 1; until then no rights
        // holder or administrator can exist.
        await currentVersion(options.db);
        return {
          bootstrapped: false,
          rightsHolderConfigured: false,
          administratorCount: 0,
        };
      });
    },
    { prefix: "/api" },
  );

  return app;
}
