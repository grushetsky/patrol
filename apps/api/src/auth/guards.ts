import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { CSRF_COOKIE, SESSION_COOKIE, parseCookies } from "./cookies.js";
import type { AuthService } from "./service.js";

export interface AuthGuards {
  authenticate(request: FastifyRequest): Promise<void>;
  requireBootstrapped(): Promise<void>;
  requireAdmin(request: FastifyRequest): Promise<void>;
}

export function createAuthGuards(service: AuthService): AuthGuards {
  return {
    async authenticate(request) {
      const cookies = parseCookies(request.headers.cookie);
      const token = cookies[SESSION_COOKIE];
      if (!token) {
        throw new ApiError(401, "unauthenticated", "No valid session.");
      }
      const { operator, session } = await service.findSession(token);
      request.auth = {
        operator,
        session,
        csrfToken: cookies[CSRF_COOKIE] ?? "",
      };
    },

    async requireBootstrapped() {
      const state = await service.setupState();
      if (!state.bootstrapped) {
        throw new ApiError(503, "setup_required", "The deployment is not bootstrapped.");
      }
    },

    async requireAdmin(request) {
      if (request.auth?.operator.role !== "administrator") {
        throw new ApiError(403, "forbidden", "The administrator role is required.");
      }
    },
  };
}

/** Require the double-submit token on every state-changing request. */
export function registerCsrfHook(app: FastifyInstance): void {
  app.addHook("preHandler", async (request) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      return;
    }
    const cookies = parseCookies(request.headers.cookie);
    const header = request.headers["x-patrol-csrf"];
    const token = cookies[CSRF_COOKIE];
    if (!token || typeof header !== "string" || header !== token) {
      throw new ApiError(403, "forbidden", "The CSRF token is missing or wrong.");
    }
  });
}
