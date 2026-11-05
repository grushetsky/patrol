import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import type { PackStore } from "@patrol/notices";
import { createNotice } from "../domain/notices/composer.js";
import {
  approvalRefusalError,
  approveNoticeRoute,
  supersedeNoticeRoute,
  supersessionRefusalError,
  withdrawNoticeRoute,
  withdrawalRefusalError,
} from "../domain/notices/approval.js";
import { listNotices, readNoticeDetail } from "../domain/notices/read.js";
import { readHandoffPack } from "../domain/notices/pack.js";

/**
 * The Notices interface (Patrol.Http), slice 6b's surface: the list and
 * detail of 6a, plus the approval that freezes a draft, the withdrawal and
 * supersession that retire one, and the frozen handoff pack's read with its
 * signed artifact downloads — the pack's bytes built here, lazily and
 * idempotently, because the topology grants the object store to the API
 * alone (the worker's settle hook writes the submission row only). No
 * operation mutates an approved notice — the contract exposes none, and
 * the database triggers hold it.
 */

export interface NoticesRoutesDeps {
  config: AppConfig;
  pool: Pool;
  /** The pack write/read store: S3 in production, a fake in tests. */
  store: PackStore;
  /** Wakes the worker's capture queue for a pre-handoff enqueue. */
  captureDispatch: (captureId: string) => Promise<void>;
}

export function noticesRoutes(deps: NoticesRoutesDeps): FastifyPluginAsync {
  const { config, pool, store } = deps;
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

    app.post("/notices/:noticeId/approval", async (request) => {
      const actor = request.session!;
      const { noticeId } = request.params as { noticeId: string };
      const body = app.validate(request.body, "NoticeApprovalRequest") as {
        statementVersion: string;
        attestation: {
          reviewedViolations: true;
          currentStatements: true;
          authorizedSignatory: true;
        };
      };
      const outcome = await approveNoticeRoute(
        { pool, now: config.now, dispatch: deps.captureDispatch },
        actor.operator.id,
        { noticeId, statementVersion: body.statementVersion },
      );
      if (outcome.status === "refused") {
        throw approvalRefusalError(outcome.refusal);
      }
      const detail = await readNoticeDetail(pool, config.now, noticeId);
      const submission = detail.submission as Record<string, unknown> | undefined;
      return {
        notice: detail.notice,
        status: detail.status,
        queuedCaptures: outcome.queuedCaptures,
        // The submission is present when every capture had already settled.
        ...(outcome.submissionId === null || submission === undefined
          ? {}
          : { submission }),
      };
    });

    app.post("/notices/:noticeId/withdrawal", async (request) => {
      const actor = request.session!;
      const { noticeId } = request.params as { noticeId: string };
      const body = app.validate(request.body, "NoticeWithdrawalRequest") as {
        reason?: string;
      };
      const outcome = await withdrawNoticeRoute(
        { pool, now: config.now },
        actor.operator.id,
        { noticeId, reason: body.reason },
      );
      if (outcome.status === "refused") {
        throw withdrawalRefusalError(outcome.refusal);
      }
      return (await readNoticeDetail(pool, config.now, noticeId)).notice;
    });

    app.post("/notices/:noticeId/supersession", async (request) => {
      const actor = request.session!;
      const { noticeId } = request.params as { noticeId: string };
      const body = app.validate(request.body, "NoticeSupersessionRequest") as {
        citedViolationIds: string[];
      };
      const outcome = await supersedeNoticeRoute(
        { pool, now: config.now },
        actor.operator.id,
        { noticeId, citedViolationIds: body.citedViolationIds },
      );
      if (outcome.status === "refused") {
        throw supersessionRefusalError(outcome.refusal);
      }
      const superseded = await readNoticeDetail(pool, config.now, noticeId);
      const draft = await readNoticeDetail(pool, config.now, outcome.replacementNoticeId);
      return { superseded: superseded.notice, draft };
    });

    app.get("/notices/:noticeId/pack", async (request) => {
      const { noticeId } = request.params as { noticeId: string };
      // The pack's bytes are built from the API alone (the topology grants
      // the object store to it), lazily and idempotently on this read; the
      // reading operator is recorded as the build's actor when a build runs.
      return readHandoffPack(
        { pool, store, now: config.now, ttlSeconds: config.evidenceDownloadTtlSeconds },
        noticeId,
        request.session!.operator.id,
      );
    });
  };
}
