import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { createNotice } from "../domain/notices/composer.js";
import { listNotices, readNoticeDetail } from "../domain/notices/read.js";

/**
 * The Notices interface (Patrol.Http), slice 6a's surface: the list with
 * its state and recipient filters, the detail with the notice's content
 * and the template summary, and the on-demand draft composition. Approval,
 * withdrawal, supersession, and the pack are 6b and deliberately absent —
 * the routes that exist compose and read drafts only.
 */
export interface NoticesRoutesDeps {
  config: AppConfig;
  pool: Pool;
}

export function noticesRoutes(deps: NoticesRoutesDeps): FastifyPluginAsync {
  const { config, pool } = deps;
  return async (app: FastifyInstance) => {
    app.get("/notices", async (request) =>
      listNotices(pool, request.query as Record<string, unknown>),
    );

    app.post("/notices", async (request, reply) => {
      const actor = request.session!;
      const body = app.validate(request.body, "CreateNoticeRequest") as {
        recipient: "google" | "bing" | "yandex";
        recipientProfileId: string;
        violationIds: string[];
      };
      const noticeId = await createNotice(pool, config.now, actor.operator.id, {
        recipient: body.recipient,
        recipientProfileId: body.recipientProfileId,
        violationIds: body.violationIds,
      });
      reply.status(201);
      return readNoticeDetail(pool, config.now, noticeId);
    });

    app.get("/notices/:noticeId", async (request) => {
      const { noticeId } = request.params as { noticeId: string };
      return readNoticeDetail(pool, config.now, noticeId);
    });
  };
}
