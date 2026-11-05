import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { errorsPlugin } from "./plugins/errors.js";
import { requestIdPlugin } from "./plugins/request-id.js";
import { validatorPlugin } from "./plugins/validator.js";
import { authPlugin } from "./plugins/auth.js";
import { systemRoutes, type SystemDeps } from "./routes/system.js";
import { authRoutes } from "./routes/auth.js";
import { operatorRoutes } from "./routes/operators.js";
import { catalogueRoutes } from "./routes/catalogue.js";
import { settingsRoutes } from "./routes/settings.js";
import { scansRoutes } from "./routes/scans.js";
import { candidatesRoutes } from "./routes/candidates.js";
import { readSetupState } from "./domain/bootstrap.js";
import type { MailTransport } from "./mail/transport.js";
import { noopScanDispatcher, type ScanDispatcher } from "./queue/dispatch.js";
import { S3EvidenceStore, enqueueCapture, s3ConfigFromEnv } from "@patrol/evidence";
import { evidenceRoutes } from "./routes/evidence.js";
import type { EvidencePresigner } from "./domain/evidence.js";

export interface AppDeps {
  config: AppConfig;
  /** The database the identity tables live in; routes query it directly. */
  pool: Pool;
  /** The outbound mail port; the in-memory recorder in tests, console in dev. */
  mail: MailTransport;
  /** Reads the patrol_meta stamp; null before any migration is recorded. */
  schemaStamp: () => Promise<number | null>;
  /**
   * How a manual scan request wakes the worker's engine queue. The server
   * entry wires the pg-boss producer; tests inject a recorder or the no-op.
   */
  dispatcher?: ScanDispatcher;
  /**
   * How a capture the API enqueues wakes the worker's capture queue — the
   * dispatch behind the evidence enqueue port, which the manual candidate
   * pair creation uses for its detection capture. The server entry wires
   * the pg-boss producer; tests inject a recorder or omit it.
   */
  captureDispatch?: (captureId: string) => Promise<void>;
  /**
   * The presigner behind evidence downloads: the S3-compatible store in
   * production, a recording fake in tests. Absent builds the store from
   * the environment.
   */
  evidencePresigner?: EvidencePresigner;
}

/**
 * Assembles the API. Routes mount under /api, matching the deployment's ALB
 * split and the generated client's base. Pino logs one child per request
 * keyed by the request id, with credential-bearing headers redacted. The
 * auth plugin resolves sessions and locales, gates unbootstrapped
 * deployments, enforces the CSRF double submit, and guards roles from the
 * route metadata.
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
  // Before the error handler: session and locale resolve on every request,
  // including the ones that fail.
  await app.register(authPlugin, { config: deps.config, pool: deps.pool });
  await app.register(errorsPlugin);
  const systemDeps: SystemDeps = {
    config: deps.config,
    schemaStamp: deps.schemaStamp,
    setupState: () => readSetupState(deps.pool),
  };
  await app.register(systemRoutes(systemDeps), { prefix: "/api" });
  await app.register(
    authRoutes({ config: deps.config, pool: deps.pool, mail: deps.mail }),
    { prefix: "/api" },
  );
  await app.register(
    operatorRoutes({ config: deps.config, pool: deps.pool, mail: deps.mail }),
    { prefix: "/api" },
  );
  await app.register(
    catalogueRoutes({ config: deps.config, pool: deps.pool }),
    { prefix: "/api" },
  );
  await app.register(
    settingsRoutes({ config: deps.config, pool: deps.pool }),
    { prefix: "/api" },
  );
  await app.register(
    scansRoutes({
      config: deps.config,
      pool: deps.pool,
      dispatcher: deps.dispatcher ?? noopScanDispatcher(),
    }),
    { prefix: "/api" },
  );
  await app.register(
    evidenceRoutes({
      config: deps.config,
      pool: deps.pool,
      presigner:
        deps.evidencePresigner ?? new S3EvidenceStore(s3ConfigFromEnv(process.env)),
    }),
    { prefix: "/api" },
  );
  await app.register(
    candidatesRoutes({
      config: deps.config,
      pool: deps.pool,
      ...(deps.captureDispatch === undefined
        ? {}
        : {
            enqueueCapture: (input) =>
              enqueueCapture(
                { pool: deps.pool, now: deps.config.now, dispatch: deps.captureDispatch! },
                input,
              ),
          }),
    }),
    { prefix: "/api" },
  );

  return app;
}
