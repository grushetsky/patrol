import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import type { EvidencePresigner } from "../domain/evidence.js";
import {
  artifactDownloadRef,
  clearObjectionRoute,
  listObjectionsPage,
  readEvidenceDetail,
} from "../domain/evidence.js";

/**
 * The EvidenceAccess and HostObjections interfaces (Patrol.Http): one
 * capture with its artifact manifest, a signed content-pinned download
 * reference (410 bytes_purged when retention has taken the bytes), the
 * objection list with its filters, and the clearance that reopens a host.
 * Roles come from the contract's x-patrol-roles — every route serves the
 * operator and the administrator, the CSRF double submit covers the
 * mutation, and no operation mutates a capture.
 */

export interface EvidenceRoutesDeps {
  config: AppConfig;
  pool: Pool;
  /**
   * The presigner behind the download reference: the S3-compatible store
   * in production, a recording fake in tests.
   */
  presigner: EvidencePresigner;
}

export function evidenceRoutes(deps: EvidenceRoutesDeps): FastifyPluginAsync {
  const { config, pool, presigner } = deps;

  return async (app: FastifyInstance) => {
    app.get("/evidence/:evidenceId", async (request, reply) => {
      const { evidenceId } = request.params as { evidenceId: string };
      const detail = await readEvidenceDetail(pool, evidenceId);
      if (detail === null) {
        throw new ApiError(404, "not_found");
      }
      return detail;
    });

    app.get("/evidence/:evidenceId/artifacts/:sha256/download", async (request) => {
      const { evidenceId, sha256 } = request.params as {
        evidenceId: string;
        sha256: string;
      };
      return artifactDownloadRef(
        {
          pool,
          presigner,
          now: config.now,
          ttlSeconds: config.evidenceDownloadTtlSeconds,
        },
        evidenceId,
        sha256,
      );
    });

    app.get("/host-objections", async (request) =>
      listObjectionsPage(pool, request.query as Record<string, unknown>),
    );

    app.post("/host-objections/:hostObjectionId/clearance", async (request) => {
      const actor = request.session!;
      const { hostObjectionId } = request.params as { hostObjectionId: string };
      const body = app.validate(request.body, "ClearHostObjectionRequest") as {
        reason: string;
      };
      return clearObjectionRoute(
        { pool, now: config.now },
        actor.operator.id,
        hostObjectionId,
        body.reason,
      );
    });
  };
}
