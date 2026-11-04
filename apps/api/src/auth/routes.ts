import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Contract } from "../contract.js";
import { paginate, validateBody } from "../http.js";
import { createAuthGuards } from "./guards.js";
import {
  csrfCookie,
  parseCookies,
  sessionCookie,
  CSRF_COOKIE,
  clearSessionCookie,
} from "./cookies.js";
import {
  publicOperator,
  publicSession,
  type InterfaceLanguage,
  type OperatorRole,
  type OperatorState,
} from "./records.js";
import type { AuthService, SessionMeta } from "./service.js";
import { randomToken } from "./tokens.js";

export function registerAuthRoutes(
  app: FastifyInstance,
  service: AuthService,
  contract: Contract,
): void {
  const guards = createAuthGuards(service);
  const authenticate = guards.authenticate;
  const requireBootstrapped = guards.requireBootstrapped;
  const requireAdmin = guards.requireAdmin;

  function meta(request: FastifyRequest): SessionMeta {
    return {
      userAgent: request.headers["user-agent"],
      coarseIp: request.ip,
    };
  }

  const validate = (request: FastifyRequest, name: string) =>
    validateBody(contract, request, name);

  const paginated = <T, R = T>(
    request: FastifyRequest,
    items: T[],
    map?: (item: T) => R,
  ) => paginate(request, items, map);

  function issueCsrf(reply: FastifyReply, existing?: string): string {
    const token = existing || randomToken(24);
    reply.header("set-cookie", csrfCookie(token));
    return token;
  }

  function issueSession(
    reply: FastifyReply,
    sessionToken: string,
    request: FastifyRequest,
  ): string {
    const csrf = parseCookies(request.headers.cookie)[CSRF_COOKIE] || randomToken(24);
    reply.header("set-cookie", [
      sessionCookie(sessionToken),
      csrfCookie(csrf),
    ]);
    return csrf;
  }

  app.get("/auth/csrf", async (_request, reply) => {
    const token = issueCsrf(reply);
    return { csrfToken: token };
  });

  app.post("/auth/setup", async (request, reply) => {
    const body = validate(request, "SetupRequest");
    const result = await service.consumeSetupToken(
      String(body.token),
      String(body.password),
    );
    return reply.status(201).send({
      operator: publicOperator(result.operator),
      enrollmentToken: result.enrollmentToken,
      expiresAt: result.expiresAt,
    });
  });

  app.post("/auth/enrollment", async (request) => {
    const body = validate(request, "TotpEnrollmentRequest");
    return service.startEnrollment(String(body.enrollmentToken));
  });

  app.post("/auth/enrollment/confirmation", async (request, reply) => {
    const body = validate(request, "TotpEnrollmentConfirmation");
    const result = await service.confirmEnrollment(
      String(body.enrollmentToken),
      String(body.code),
      meta(request),
    );
    const csrf = issueSession(reply, result.token, request);
    return reply.status(201).send({
      operator: publicOperator(result.operator),
      session: publicSession(result.session),
      csrfToken: csrf,
      recoveryCodes: result.recoveryCodes,
    });
  });

  app.post("/auth/sign-in", async (request, reply) => {
    const body = validate(request, "SignInRequest");
    const result = await service.signIn(
      String(body.email),
      String(body.password),
    );
    return reply.status(202).send(result);
  });

  app.post("/auth/second-factor", async (request, reply) => {
    const body = validate(request, "SecondFactorRequest");
    const result = await service.secondFactor(
      String(body.challengeId),
      String(body.code),
      body.method === "recovery_code" ? "recovery_code" : "totp",
      meta(request),
    );
    const csrf = issueSession(reply, result.token, request);
    return reply.send({
      operator: publicOperator(result.operator),
      session: publicSession(result.session),
      csrfToken: csrf,
      ...(result.recoveryCodesRemaining !== undefined
        ? { recoveryCodesRemaining: result.recoveryCodesRemaining }
        : {}),
    });
  });

  app.get("/auth/session", { preHandler: authenticate }, async (request) => {
    const auth = request.auth!;
    return {
      operator: publicOperator(auth.operator),
      session: publicSession(auth.session),
      csrfToken: auth.csrfToken,
    };
  });

  app.delete("/auth/session", { preHandler: authenticate }, async (request, reply) => {
    await service.signOut(request.auth!.session.id, request.auth!.operator.id);
    reply.header("set-cookie", clearSessionCookie());
    return reply.status(204).send();
  });

  app.get("/auth/sessions", { preHandler: authenticate }, async (request) => {
    const sessions = await service.listSessions(request.auth!.operator.id);
    return paginated(request, sessions, publicSession);
  });

  app.delete(
    "/auth/sessions/:sessionId",
    { preHandler: authenticate },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      await service.revokeSession(request.auth!.operator.id, sessionId);
      return reply.status(204).send();
    },
  );

  app.post("/auth/password", { preHandler: authenticate }, async (request, reply) => {
    const body = validate(request, "PasswordChangeRequest");
    await service.changePassword(
      request.auth!.operator.id,
      {
        password: String(body.currentPassword),
        code: String(body.currentCode),
        sessionId: request.auth!.session.id,
      },
      String(body.newPassword),
    );
    return reply.status(204).send();
  });

  app.post("/auth/email", { preHandler: authenticate }, async (request, reply) => {
    const body = validate(request, "EmailChangeRequest");
    await service.changeEmail(
      request.auth!.operator.id,
      {
        password: String(body.currentPassword),
        code: String(body.currentCode),
        sessionId: request.auth!.session.id,
      },
      String(body.newEmail),
    );
    return reply.status(204).send();
  });

  app.patch(
    "/auth/preferences",
    { preHandler: authenticate },
    async (request) => {
      const body = validate(request, "UpdatePreferencesRequest");
      const operator = await service.setLanguage(
        request.auth!.operator.id,
        body.language as InterfaceLanguage,
      );
      return publicOperator(operator);
    },
  );

  app.post("/auth/totp", { preHandler: authenticate }, async (request) => {
    const body = validate(request, "ReenrollmentRequest");
    return service.beginReenrollment(request.auth!.operator.id, {
      password: String(body.password),
      code: String(body.currentCode),
      sessionId: request.auth!.session.id,
    });
  });

  app.post(
    "/auth/totp/confirmation",
    { preHandler: authenticate },
    async (request) => {
      const body = validate(request, "ReenrollmentConfirmation");
      const recoveryCodes = await service.confirmReenrollment(
        request.auth!.operator.id,
        String(body.code),
        request.auth!.session.id,
      );
      return { recoveryCodes };
    },
  );

  app.get(
    "/operators",
    { preHandler: [requireBootstrapped, authenticate, requireAdmin] },
    async (request) => {
      const operators = await service.listOperators();
      return paginated(request, operators, publicOperator);
    },
  );

  app.patch(
    "/operators/:operatorId",
    { preHandler: [requireBootstrapped, authenticate, requireAdmin] },
    async (request) => {
      const { operatorId } = request.params as { operatorId: string };
      const body = validate(request, "OperatorPatchRequest");
      const operator = await service.updateOperator(
        request.auth!.operator.id,
        operatorId,
        {
          role: body.role as OperatorRole | undefined,
          state: body.state as OperatorState | undefined,
        },
      );
      return publicOperator(operator);
    },
  );

  app.post(
    "/operators/:operatorId/credential-reset",
    { preHandler: [requireBootstrapped, authenticate, requireAdmin] },
    async (request, reply) => {
      const { operatorId } = request.params as { operatorId: string };
      const body = validate(request, "CredentialResetRequest");
      const operator = await service.operatorById(operatorId);
      await service.recoverOperator(operator.email, String(body.reason ?? ""), request.auth!.operator.id);
      return reply.status(202).send({
        operator: publicOperator(operator),
        resetAt: new Date().toISOString(),
        reenrollmentRequired: true,
      });
    },
  );

  app.get(
    "/operators/:operatorId/sessions",
    { preHandler: [requireBootstrapped, authenticate, requireAdmin] },
    async (request) => {
      const { operatorId } = request.params as { operatorId: string };
      const sessions = await service.listSessions(operatorId);
      return paginated(request, sessions, publicSession);
    },
  );

  app.delete(
    "/operators/:operatorId/sessions/:sessionId",
    { preHandler: [requireBootstrapped, authenticate, requireAdmin] },
    async (request, reply) => {
      const { operatorId, sessionId } = request.params as {
        operatorId: string;
        sessionId: string;
      };
      await service.revokeSession(operatorId, sessionId);
      return reply.status(204).send();
    },
  );

  app.get(
    "/invitations",
    { preHandler: [requireBootstrapped, authenticate, requireAdmin] },
    async (request) => {
      const invitations = await service.listInvitations();
      return paginated(request, invitations);
    },
  );

  app.post(
    "/invitations",
    { preHandler: [requireBootstrapped, authenticate, requireAdmin] },
    async (request, reply) => {
      const body = validate(request, "CreateInvitationRequest");
      const result = await service.createInvitation(
        request.auth!.operator.id,
        String(body.email),
        body.role as OperatorRole,
      );
      return reply.status(201).send({
        invitation: result.invitation,
        state: "pending",
      });
    },
  );

  app.delete(
    "/invitations/:invitationId",
    { preHandler: [requireBootstrapped, authenticate, requireAdmin] },
    async (request, reply) => {
      const { invitationId } = request.params as { invitationId: string };
      await service.revokeInvitation(invitationId, request.auth!.operator.id);
      return reply.status(204).send();
    },
  );

  app.post("/invitations/:token/acceptance", { preHandler: requireBootstrapped }, async (request, reply) => {
    const body = validate(request, "InvitationAcceptanceRequest");
    const { token } = request.params as { token: string };
    const result = await service.acceptInvitation(token, String(body.password));
    return reply.status(201).send({
      operator: publicOperator(result.operator),
      enrollmentToken: result.enrollmentToken,
      expiresAt: result.expiresAt,
    });
  });
}
