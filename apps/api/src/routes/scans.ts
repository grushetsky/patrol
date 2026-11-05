import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { readScan } from "@patrol/scans";
import {
  listRechecks,
  listScanResults,
  listScans,
  requestManualScan,
  scanJson,
} from "../domain/scans.js";
import type { ScanDispatcher } from "../queue/dispatch.js";

/**
 * The Scans and Rechecks interfaces (Patrol.Http): scan history with its
 * filters, the manual scan and manual re-check request (202, idempotent on
 * the day), one scan with its plan and lifecycle, the results a scan
 * recorded as provenance, and the re-check ladders. Roles come from the
 * contract's x-patrol-roles — every operator reads and requests; the CSRF
 * double submit covers the mutation.
 */

export interface ScansRoutesDeps {
  config: AppConfig;
  pool: Pool;
  dispatcher: ScanDispatcher;
}

export function scansRoutes(deps: ScansRoutesDeps): FastifyPluginAsync {
  const { config, pool, dispatcher } = deps;

  return async (app: FastifyInstance) => {
    app.get("/scans", async (request) =>
      listScans(pool, request.query as Record<string, unknown>),
    );

    app.post("/scans", async (request, reply) => {
      const actor = request.session!;
      const body = app.validate(request.body, "ManualScanRequest") as {
        titleGroupId: string;
        trackedTitleId?: string;
        engine?: "google" | "bing" | "yandex";
        trigger: "manual" | "manual_recheck";
      };
      const scans = await requestManualScan(
        pool,
        config.now,
        { operatorId: actor.operator.id, body },
        dispatcher,
      );
      reply.status(202);
      return {
        scans: await Promise.all(
          scans.map((scan) => scanJson(pool, scan)),
        ),
      };
    });

    app.get("/scans/:scanId", async (request) => {
      const { scanId } = request.params as { scanId: string };
      const scan = await readScan(pool, scanId);
      if (scan === null) {
        throw new ApiError(404, "not_found");
      }
      return scanJson(pool, scan, { includePlan: true });
    });

    app.get("/scans/:scanId/results", async (request) => {
      const { scanId } = request.params as { scanId: string };
      const scan = await readScan(pool, scanId);
      if (scan === null) {
        throw new ApiError(404, "not_found");
      }
      return listScanResults(pool, scanId, request.query as Record<string, unknown>);
    });

    app.get("/rechecks", async (request) =>
      listRechecks(pool, request.query as Record<string, unknown>),
    );
  };
}
