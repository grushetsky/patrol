import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  issues,
  validateErrorBody,
  validateReviewDecisionRequest,
  validateReviewDecisionResult,
} from "./validators.ts";
import { reviewDecisionResult } from "./fixtures.ts";

const DECISION_ROUTE = /^\/candidates\/[^/]+\/review-decisions$/;

/**
 * A stub of the decision route. It validates the request against the emitted
 * JSON Schema before touching it, and validates the response it is about to
 * send, so an emitter gap breaks the check rather than a real build.
 */
export function createStubServer() {
  return createServer(async (request, response) => {
    if (request.method === "POST" && DECISION_ROUTE.test(urlOf(request))) {
      const body = await readJson(request);
      if (!validateReviewDecisionRequest(body)) {
        send(
          response,
          400,
          { code: "validation_failed", message: "The decision body is invalid.", fieldErrors: issues(validateReviewDecisionRequest).map(toFieldError) },
        );
        return;
      }
      if (!validateReviewDecisionResult(reviewDecisionResult)) {
        send(response, 500, {
          code: "state_conflict",
          message: "The stub's response does not satisfy the contract.",
          fieldErrors: issues(validateReviewDecisionResult).map(toFieldError),
        });
        return;
      }
      send(response, 201, reviewDecisionResult);
      return;
    }

    send(response, 404, { code: "not_found", message: "No such route." });
  });
}

function urlOf(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://127.0.0.1").pathname;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toFieldError(issue: { instancePath: string; message?: string }) {
  return {
    path: issue.instancePath || "/",
    message: issue.message ?? "invalid",
  };
}

function send(response: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}
