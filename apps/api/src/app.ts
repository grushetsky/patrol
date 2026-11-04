import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { errorsPlugin } from "./plugins/errors.js";
import { requestIdPlugin } from "./plugins/request-id.js";
import { validatorPlugin } from "./plugins/validator.js";
import { stubEchoRoutes } from "./routes/stub-echo.js";
import { systemRoutes, type SystemDeps } from "./routes/system.js";

export interface AppDeps extends SystemDeps {
  config: AppConfig;
}

/**
 * Assembles the API. Routes mount under /api, matching the deployment's ALB
 * split and the generated client's base. Pino logs one child per request
 * keyed by the request id, with credential-bearing headers redacted. The
 * slice-0 stub routes are scaffolding and never mount in production.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: true,
    genReqId: () => randomUUID(),
    logger: {
      level: process.env.PATROL_LOG_LEVEL ?? "info",
      // Dev-only pretty printing (the dev script sets the flag); production
      // keeps the plain JSON stream.
      transport:
        process.env.PATROL_PRETTY_LOGS === "1"
          ? { target: "pino-pretty" }
          : undefined,
      redact: {
        paths: [
          "req.headers.cookie",
          "req.headers.authorization",
          "res.headers.set-cookie",
        ],
        censor: "[redacted]",
      },
    },
  });

  await app.register(requestIdPlugin);
  await app.register(validatorPlugin);
  await app.register(errorsPlugin);
  await app.register(systemRoutes(deps), { prefix: "/api" });
  if (deps.config.env !== "production") {
    await app.register(stubEchoRoutes, { prefix: "/api" });
  }

  return app;
}
