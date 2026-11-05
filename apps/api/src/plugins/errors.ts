import type { FastifyError, FastifyPluginAsync, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { t } from "@patrol/i18n";
import { BudgetError } from "@patrol/budget";
import { requestLocale } from "../i18n.js";
import { ApiError, ValidationError, type FieldError } from "../errors.js";

/** The ErrorBody every error response carries (contract Patrol.Http). */
interface ErrorBody {
  code: string;
  message: string;
  fieldErrors?: FieldError[];
  retryAfterSeconds?: number;
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  body: ErrorBody,
): void {
  reply.status(statusCode).send(body);
}

/** The catalogue key a budget rejection's code renders through. */
function budgetMessageKey(code: BudgetError["code"]) {
  switch (code) {
    case "unprocessable":
      return "errors.unprocessable" as const;
    case "not_found":
      return "errors.not_found" as const;
    case "state_conflict":
      return "errors.state_conflict" as const;
    case "setup_required":
      return "errors.setup_required" as const;
  }
}

/**
 * The shared error handler. The UI branches on `code`, which is never
 * localized; `message` is display text and resolves through the catalogue
 * for the request's resolved language — the signed-in operator's stored
 * preference ahead of Accept-Language (implementation-rules "Language
 * resolution"). Internal failures log the request id but never leak it or
 * any stack into the response body. Wrapped with fastify-plugin so the
 * handler applies to every scope, not just this one.
 */
export const errorsPlugin: FastifyPluginAsync = fp(async (app) => {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const locale = requestLocale(request);

    if (error instanceof ApiError) {
      sendError(reply, error.statusCode, {
        code: error.code,
        message: t(locale, error.messageKey),
        ...(error.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
        ...(error.fieldErrors !== undefined
          ? { fieldErrors: error.fieldErrors }
          : {}),
        ...(error.existingTitleId !== undefined
          ? { existingTitleId: error.existingTitleId }
          : {}),
        ...(error.blockingTitleId !== undefined
          ? { blockingTitleId: error.blockingTitleId }
          : {}),
      });
      return;
    }

    // The shared budget domain raises its own rejection (the worker and the
    // API both call it); it carries the same wire-facing facts and maps
    // onto the same ErrorBody codes.
    if (error instanceof BudgetError) {
      sendError(reply, error.statusCode, {
        code: error.code,
        message: t(locale, budgetMessageKey(error.code)),
        ...(error.fieldErrors !== undefined
          ? { fieldErrors: error.fieldErrors }
          : {}),
      });
      return;
    }

    if (error instanceof ValidationError) {
      sendError(reply, 400, {
        code: error.code,
        message: t(locale, "errors.validation_failed"),
        fieldErrors: error.fieldErrors,
      });
      return;
    }

    // fastify's own body-parsing failures (malformed or empty JSON) are the
    // request's fault and answer validation_failed like any schema miss.
    if (error.statusCode === 400) {
      sendError(reply, 400, {
        code: "validation_failed",
        message: t(locale, "errors.validation_failed"),
        fieldErrors: [{ path: "/", message: "malformed JSON body" }],
      });
      return;
    }

    request.log.error(
      { err: error, requestId: request.id },
      "unhandled error",
    );
    sendError(reply, 500, {
      code: "internal_error",
      message: t(locale, "errors.internal_error"),
    });
  });

  app.setNotFoundHandler((request, reply) => {
    sendError(reply, 404, {
      code: "not_found",
      message: t(requestLocale(request), "errors.not_found"),
    });
  });
});
