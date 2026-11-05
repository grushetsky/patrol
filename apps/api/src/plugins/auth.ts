import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { parse as parseYaml } from "yaml";
import type { Locale } from "@patrol/i18n";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { resolveLocale } from "../i18n.js";
import { ApiError } from "../errors.js";
import {
  CSRF_COOKIE_NAME,
  loadSession,
  type SessionWithOperator,
} from "../domain/session.js";
import { readSetupState, type DeploymentSetupState } from "../domain/bootstrap.js";

/**
 * Identity middleware (Authentication "Sessions", "Roles"; implementation
 * rules "CSRF", "Setup gating", "Language resolution"):
 *
 * - every request resolves its session from the cookie against the session
 *   table, and its locale from the operator's stored preference ahead of
 *   Accept-Language;
 * - domain operations answer 503 setup_required until a rights holder and
 *   at least one administrator exist — the list of gated prefixes is data,
 *   and the anonymous invitation acceptance is exempt because it is the
 *   ceremony that completes bootstrap;
 * - every state-changing request carries X-Patrol-CSRF: the session's token
 *   for authenticated calls, the paired anonymous cookie otherwise;
 * - the roles a route demands come from the contract itself: the generated
 *   OpenAPI document's `x-patrol-roles` per operation, keyed by method and
 *   path. Manual `patrolRoles` route metadata overrides the contract, and a
 *   route the contract does not declare is refused outright — default
 *   closed, so a future route cannot ship by forgetting its roles.
 */

/** Route prefixes that answer 503 setup_required before bootstrap. */
const SETUP_GATED_PREFIXES = [
  "operators",
  "invitations",
  // Later slices extend this list; the middleware itself never changes.
  "title-groups",
  "titles",
  "allowlist",
  "settings",
  "scans",
  "rechecks",
  "candidates",
  "review",
  "violations",
  "evidence",
  "host-objections",
  "notices",
  "dashboard",
] as const;

/** The anonymous acceptance ceremony lives under /invitations but is auth. */
const INVITATION_ACCEPTANCE = /^\/api\/invitations\/[^/]+\/acceptance$/;

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface AuthPluginDeps {
  config: AppConfig;
  pool: Pool;
}

/** The roles the contract allows on a route. */
export type PatrolRole = "anonymous" | "operator" | "administrator";

interface OpenApiDocument {
  paths: Record<
    string,
    Partial<Record<"get" | "post" | "put" | "patch" | "delete", { "x-patrol-roles"?: string[] }>>
  >;
}

/**
 * Derives every operation's roles from the generated OpenAPI document.
 * The key is `METHOD /path` with Fastify's `:param` spelling so a request's
 * route pattern matches without re-deriving it.
 */
export function contractRoles(document: OpenApiDocument): Map<string, PatrolRole[]> {
  const roles = new Map<string, PatrolRole[]>();
  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    const routePattern = path.replaceAll(/\{([^}]+)\}/g, ":$1");
    for (const [method, operation] of Object.entries(operations ?? {})) {
      const declared = operation?.["x-patrol-roles"];
      if (Array.isArray(declared)) {
        roles.set(
          `${method.toUpperCase()} ${routePattern}`,
          declared.filter((role): role is PatrolRole =>
            role === "anonymous" || role === "operator" || role === "administrator",
          ),
        );
      }
    }
  }
  return roles;
}

const require = createRequire(import.meta.url);

/** The contract's role table, loaded once per process. */
export const CONTRACT_ROLES: ReadonlyMap<string, PatrolRole[]> = contractRoles(
  parseYaml(
    readFileSync(require.resolve("@patrol/contract/openapi.yaml"), "utf8"),
  ) as OpenApiDocument,
);

/** How long a cached setup state stands before the gate re-reads it. */
const SETUP_STATE_TTL_MS = 5_000;

/**
 * Minimal cookie parsing; the API sets two cookies and reads three. A pair
 * whose value is not valid percent-encoding is skipped rather than thrown
 * at the request: a mangled cookie cannot authenticate anything, so the
 * request proceeds without it (a mangled session cookie therefore answers
 * 401 unauthenticated downstream, not a 500).
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name.length === 0) {
      continue;
    }
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // Malformed percent-encoding: drop the pair, keep the rest.
    }
  }
  return cookies;
}

declare module "fastify" {
  interface FastifyRequest {
    /** The session the cookie names, or null; set by the auth plugin. */
    session: SessionWithOperator | null;
    /** The request's resolved interface language. */
    locale: Locale;
  }

  interface FastifyContextConfig {
    /**
     * The roles the route demands, overriding the contract-derived roles.
     * Almost every route leaves this unset and lets the contract decide.
     */
    patrolRoles?: PatrolRole[];
  }

  interface FastifyInstance {
    /**
     * Drops the cached setup state so the gate re-reads it on the next
     * gated request. Called on the paths that change it: invitation
     * acceptance (an operator row appears), enrolment confirmation (an
     * operator turns active), and operator administration.
     */
    invalidateSetupStateCache: () => void;
  }
}

function sessionCookieName(config: AppConfig): string {
  return config.env === "production" ? "__Host-patrol_session" : "patrol_session";
}

/** The route's own pattern, Fastify `:param` spelling, without the /api prefix. */
function routePattern(request: FastifyRequest): string {
  const url = request.routeOptions.url ?? request.url.split("?")[0];
  return url.replace(/^\/api(?=\/)/, "");
}


export const authPlugin: FastifyPluginAsync<AuthPluginDeps> = fp(
  async (app: FastifyInstance, deps: AuthPluginDeps) => {
    app.decorateRequest("session", null);
    app.decorateRequest("locale", "en");

    // In-process cache for the setup gate. The CLI's bootstrap runs in its
    // own process and cannot invalidate it, so the TTL bounds how long a
    // just-bootstrapped deployment keeps answering 503 setup_required (at
    // most five seconds); everything the API itself does to the state —
    // invitation acceptance, enrolment confirmation, operator
    // administration — invalidates explicitly.
    let setupStateCache: { expiresAt: number; state: DeploymentSetupState } | null =
      null;
    app.decorate("invalidateSetupStateCache", () => {
      setupStateCache = null;
    });
    const readSetupStateCached = async (): Promise<DeploymentSetupState> => {
      if (setupStateCache !== null && Date.now() < setupStateCache.expiresAt) {
        return setupStateCache.state;
      }
      const state = await readSetupState(deps.pool);
      setupStateCache = {
        expiresAt: Date.now() + SETUP_STATE_TTL_MS,
        state,
      };
      return state;
    };

    // Session and locale resolve first, so every later hook, route, and the
    // error handler itself see them.
    app.addHook("onRequest", async (request: FastifyRequest) => {
      const cookies = parseCookies(request.headers.cookie);
      request.session = await loadSession(
        deps.pool,
        deps.config,
        cookies[sessionCookieName(deps.config)],
      );
      request.locale = resolveLocale(
        request.session?.operator.preferredLanguage ?? null,
        request.headers["accept-language"],
      );
    });

    app.addHook("preHandler", async (request: FastifyRequest) => {
      const path = request.url.split("?")[0];

      // Setup gating: domain operations refuse until bootstrap completes.
      const prefix = path.split("/")[2] ?? "";
      if (
        SETUP_GATED_PREFIXES.includes(prefix as (typeof SETUP_GATED_PREFIXES)[number]) &&
        !INVITATION_ACCEPTANCE.test(path)
      ) {
        const state = await readSetupStateCached();
        if (!state.bootstrapped) {
          throw new ApiError(503, "setup_required");
        }
      }

      // CSRF double-submit on every mutation, authenticated or anonymous.
      if (MUTATION_METHODS.has(request.method)) {
        const header = request.headers["x-patrol-csrf"];
        const presented = Array.isArray(header) ? header[0] : header;
        if (request.session !== null) {
          if (
            presented === undefined ||
            presented !== request.session.session.csrfToken
          ) {
            throw new ApiError(403, "forbidden");
          }
        } else {
          const cookieValue = parseCookies(request.headers.cookie)[CSRF_COOKIE_NAME];
          if (presented === undefined || cookieValue === undefined || presented !== cookieValue) {
            throw new ApiError(403, "forbidden");
          }
        }
      }

      // Role guard. Manual route metadata wins; otherwise the contract's
      // x-patrol-roles for this method and pattern decides; a route the
      // contract does not declare is refused (default closed). An
      // unmatched URL has no route at all — the not-found handler answers
      // it, and the guard steps aside so 404 stays 404.
      const matchedUrl = request.routeOptions.url;
      if (matchedUrl === undefined) {
        return;
      }
      const declared = request.routeOptions.config?.patrolRoles;
      const roles =
        declared ??
        CONTRACT_ROLES.get(
          `${request.method === "HEAD" ? "GET" : request.method} ${routePattern(request)}`,
        );
      if (roles === undefined) {
        warnUncoveredRoute(`${request.method} ${routePattern(request)}`);
        throw new ApiError(403, "forbidden");
      }
      if (roles.includes("anonymous")) {
        return;
      }
      if (request.session === null) {
        throw new ApiError(401, "unauthenticated");
      }
      const role = request.session.operator.role;
      const sufficient =
        role === "administrator" ? true : roles.includes("operator");
      if (!sufficient) {
        throw new ApiError(403, "forbidden");
      }
    });
  },
);

const warnedRoutes = new Set<string>();

/** Dev-time signal that a route shipped without any role declaration. */
function warnUncoveredRoute(route: string): void {
  if (warnedRoutes.has(route)) {
    return;
  }
  warnedRoutes.add(route);
  console.warn(
    `[patrol] route ${route} declares no roles (neither patrolRoles metadata nor the contract); refusing its requests`,
  );
}
