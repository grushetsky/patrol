import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDb } from "pg-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { totpCode } from "../src/auth/totp.js";
import { loadContract } from "../src/contract.js";
import { migrate, type Connectable } from "../src/db/migrations.js";

const bundle = new URL("../../../contract/generated/json-schema/patrol", import.meta.url);
const MIGRATIONS_DIR = new URL("../drizzle", import.meta.url).pathname;
const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "another correct battery";

async function harness(
  clock: () => Date = () => new Date(),
) {
  const memory = newDb();
  const adapter = memory.adapters.createPg();
  const db = new adapter.Pool() as unknown as Connectable;
  await migrate(db, MIGRATIONS_DIR);
  const service = new AuthService(db, clock);
  const contract = await loadContract(bundle);
  const app = buildApp({
    db,
    contract,
    auth: service,
    buildVersion: "0.1.0",
    expectedMigration: "0005_matching_review",
    logger: false,
  });
  return { app, service, db };
}

async function csrf(app: Awaited<ReturnType<typeof harness>>["app"]) {
  const response = await app.inject({ method: "GET", url: "/api/auth/csrf" });
  const token = response.cookies[0].value;
  return {
    header: { "x-patrol-csrf": token },
    cookies: { patrol_csrf: token },
    token,
  };
}

function sessionCookie(response: { cookies: Array<{ name: string; value: string }> }) {
  return response.cookies.find((cookie) => cookie.name === "__Host-patrol_session")?.value;
}

async function bootstrapAdmin(
  app: Awaited<ReturnType<typeof harness>>["app"],
  service: AuthService,
) {
  const bootstrap = await service.bootstrap({
    legalName: "Example Rights Holder",
    country: "US",
    address: "1 Example Street",
    roleMailbox: "legal@example.test",
    adminEmail: "admin@example.test",
  });
  const token = await csrf(app);
  const setup = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    headers: token.header,
    cookies: token.cookies,
    payload: { token: bootstrap.setupToken, password: PASSWORD },
  });
  expect(setup.statusCode).toBe(201);
  const enrollmentToken = setup.json().enrollmentToken as string;

  const enrollment = await app.inject({
    method: "POST",
    url: "/api/auth/enrollment",
    headers: token.header,
    cookies: token.cookies,
    payload: { enrollmentToken },
  });
  expect(enrollment.statusCode).toBe(200);
  const secret = enrollment.json().secret as string;

  const registered = await app.inject({
    method: "POST",
    url: "/api/auth/enrollment/confirmation",
    headers: token.header,
    cookies: token.cookies,
    payload: { enrollmentToken, code: totpCode(secret) },
  });
  expect(registered.statusCode).toBe(201);
  return {
    bootstrap,
    token,
    secret,
    recoveryCodes: registered.json().recoveryCodes as string[],
    session: sessionCookie(registered)!,
    operator: registered.json().operator,
  };
}

async function addOperator(
  service: AuthService,
  adminId: string,
  email: string,
  role: "administrator" | "operator" = "operator",
) {
  const invitation = await service.createInvitation(adminId, email, role);
  const accepted = await service.acceptInvitation(invitation.token, PASSWORD);
  const enrollment = await service.startEnrollment(accepted.enrollmentToken);
  const confirmed = await service.confirmEnrollment(
    accepted.enrollmentToken,
    totpCode(enrollment.secret),
  );
  return { operator: confirmed.operator, session: confirmed.token };
}

describe("identity flow", () => {
  let app: Awaited<ReturnType<typeof harness>>["app"];
  let service: AuthService;

  beforeEach(async () => {
    const harnessed = await harness();
    app = harnessed.app;
    service = harnessed.service;
  });

  it("bootstraps, enrolls, and signs in with a session and recovery codes", async () => {
    const admin = await bootstrapAdmin(app, service);

    expect(admin.recoveryCodes).toHaveLength(10);
    const session = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      cookies: { "__Host-patrol_session": admin.session },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().operator.email).toBe("admin@example.test");
    expect(session.json().operator.state).toBe("active");

    const setupState = await app.inject({ method: "GET", url: "/api/system/setup" });
    expect(setupState.json()).toEqual({
      bootstrapped: true,
      rightsHolderConfigured: true,
      administratorCount: 1,
    });

    const token = await csrf(app);
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: token.header,
      cookies: token.cookies,
      payload: { email: "admin@example.test", password: PASSWORD },
    });
    expect(signIn.statusCode).toBe(202);
    const challengeId = signIn.json().challengeId as string;

    const second = await app.inject({
      method: "POST",
      url: "/api/auth/second-factor",
      headers: token.header,
      cookies: token.cookies,
      payload: { challengeId, code: totpCode(admin.secret), method: "totp" },
    });
    expect(second.statusCode).toBe(200);
    expect(sessionCookie(second)).toBeTruthy();
    expect(sessionCookie(second)).not.toBe(admin.session);
  });

  it("revokes sessions and issues a recovery token for a locked-out administrator", async () => {
    const admin = await bootstrapAdmin(app, service);

    const recovery = await service.recoverOperator(admin.operator.email, "Lost device");
    const revoked = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      cookies: { "__Host-patrol_session": admin.session },
    });
    expect(revoked.statusCode).toBe(401);

    const setup = await service.consumeSetupToken(recovery.setupToken, NEW_PASSWORD);
    expect(setup.enrollmentToken).toBeTruthy();
  });

  it("expires an idle session", async () => {
    let now = new Date("2026-11-04T10:00:00Z");
    const clocked = await harness(() => now);
    app = clocked.app;
    service = clocked.service;
    const admin = await bootstrapAdmin(app, service);

    now = new Date(now.getTime() + 8 * 60 * 60 * 1000 + 1000);

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      cookies: { "__Host-patrol_session": admin.session },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("unauthenticated");
  });

  it("refuses a wrong password and locks after ten failures", async () => {
    await bootstrapAdmin(app, service);
    const token = await csrf(app);

    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in",
        headers: token.header,
        cookies: token.cookies,
        payload: { email: "admin@example.test", password: "wrong password" },
      });
      expect(response.statusCode).toBe(401);
    }

    const locked = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: token.header,
      cookies: token.cookies,
      payload: { email: "admin@example.test", password: "wrong password" },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().code).toBe("account_locked");
  });

  it("refuses a mutation without the CSRF token", async () => {
    await bootstrapAdmin(app, service);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      payload: { email: "admin@example.test", password: PASSWORD },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("forbidden");
  });

  it("refuses a reused recovery code", async () => {
    const admin = await bootstrapAdmin(app, service);
    const token = await csrf(app);

    async function signInWithRecovery(code: string) {
      const signIn = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in",
        headers: token.header,
        cookies: token.cookies,
        payload: { email: "admin@example.test", password: PASSWORD },
      });
      const challengeId = signIn.json().challengeId as string;
      return app.inject({
        method: "POST",
        url: "/api/auth/second-factor",
        headers: token.header,
        cookies: token.cookies,
        payload: { challengeId, code, method: "recovery_code" },
      });
    }

    const first = await signInWithRecovery(admin.recoveryCodes[0]);
    expect(first.statusCode).toBe(200);
    expect(first.json().recoveryCodesRemaining).toBe(9);

    const second = await signInWithRecovery(admin.recoveryCodes[0]);
    expect(second.statusCode).toBe(401);
    expect(second.json().code).toBe("invalid_second_factor");
  });

  it("answers 403 for an operator on an administrator route and 200 for an admin", async () => {
    const admin = await bootstrapAdmin(app, service);
    const operator = await addOperator(service, admin.operator.id, "operator@example.test");

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/operators",
      cookies: { "__Host-patrol_session": operator.session },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().code).toBe("forbidden");

    const allowed = await app.inject({
      method: "GET",
      url: "/api/operators",
      cookies: { "__Host-patrol_session": admin.session },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().items.some((item: { id: string }) => item.id === operator.operator.id)).toBe(
      true,
    );
  });

  it("protects the last administrator and revokes sessions on a role change", async () => {
    const admin = await bootstrapAdmin(app, service);
    const operator = await addOperator(service, admin.operator.id, "operator@example.test");
    const token = await csrf(app);

    const lastAdmin = await app.inject({
      method: "PATCH",
      url: `/api/operators/${admin.operator.id}`,
      headers: token.header,
      cookies: {
        ...token.cookies,
        "__Host-patrol_session": admin.session,
      },
      payload: { state: "disabled" },
    });
    expect(lastAdmin.statusCode).toBe(409);
    expect(lastAdmin.json().code).toBe("last_administrator");

    const promoted = await app.inject({
      method: "PATCH",
      url: `/api/operators/${operator.operator.id}`,
      headers: token.header,
      cookies: {
        ...token.cookies,
        "__Host-patrol_session": admin.session,
      },
      payload: { role: "administrator" },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().role).toBe("administrator");

    const revoked = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      cookies: { "__Host-patrol_session": operator.session },
    });
    expect(revoked.statusCode).toBe(401);
  });

  it("revokes other sessions on a password change and stores the language preference", async () => {
    const admin = await bootstrapAdmin(app, service);
    const token = await csrf(app);

    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: token.header,
      cookies: token.cookies,
      payload: { email: "admin@example.test", password: PASSWORD },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/auth/second-factor",
      headers: token.header,
      cookies: token.cookies,
      payload: {
        challengeId: signIn.json().challengeId,
        code: totpCode(admin.secret),
        method: "totp",
      },
    });
    const otherSession = sessionCookie(second)!;

    const changed = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: token.header,
      cookies: {
        ...token.cookies,
        "__Host-patrol_session": admin.session,
      },
      payload: {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        currentCode: totpCode(admin.secret),
      },
    });
    expect(changed.statusCode).toBe(204);

    const revoked = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      cookies: { "__Host-patrol_session": otherSession },
    });
    expect(revoked.statusCode).toBe(401);

    const language = await app.inject({
      method: "PATCH",
      url: "/api/auth/preferences",
      headers: token.header,
      cookies: {
        ...token.cookies,
        "__Host-patrol_session": admin.session,
      },
      payload: { language: "ru" },
    });
    expect(language.statusCode).toBe(200);
    expect(language.json().preferredLanguage).toBe("ru");
  });

  it("accepts an invitation through the public route", async () => {
    const admin = await bootstrapAdmin(app, service);
    const invitation = await service.createInvitation(
      admin.operator.id,
      "invited@example.test",
      "operator",
    );
    const token = await csrf(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/invitations/${invitation.token}/acceptance`,
      headers: token.header,
      cookies: token.cookies,
      payload: { password: PASSWORD },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().operator.email).toBe("invited@example.test");
    expect(response.json().enrollmentToken).toBeTruthy();
  });

  it("answers setup_required before bootstrap", async () => {
    const token = await csrf(app);

    const operators = await app.inject({
      method: "GET",
      url: "/api/operators",
      cookies: token.cookies,
    });
    expect(operators.statusCode).toBe(503);
    expect(operators.json().code).toBe("setup_required");

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: token.header,
      cookies: token.cookies,
      payload: { email: "admin@example.test", password: PASSWORD },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("setup_required");
  });
});
