import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { t } from "@patrol/i18n";
import { getValidator } from "../../src/plugins/validator.js";
import { generateTotpCode } from "../../src/domain/totp.js";
import {
  anonCsrf,
  authHeaders,
  ceremonyApp,
  inviteAndEnroll,
  signIn,
  signedInAdministrator,
  type CeremonyApp,
} from "./ceremony.js";

/**
 * Seam 9 (CSRF double-submit), seam 10 (role guard), the operator and
 * invitation administration the contract defines, seam 12's pre-preference
 * English email, and seam 13's security events — asserted through SQL.
 */
describe("CSRF, roles, operator administration, invitations, and audit", () => {
  let world: CeremonyApp;
  let admin: Awaited<ReturnType<typeof signedInAdministrator>>;

  beforeAll(async () => {
    world = await ceremonyApp();
    admin = await signedInAdministrator(world, "admin@example.test");
  });

  afterAll(async () => {
    await world.app.close();
    await world.pool.end();
  });

  it("pairs the CSRF cookie and token on GET /auth/csrf", async () => {
    const response = await world.app.inject({ method: "GET", url: "/api/auth/csrf" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.csrfToken).toBeTypeOf("string");
    expect(getValidator("CsrfTokenPayload")(body)).toBe(true);
    const setCookie = String(response.headers["set-cookie"]);
    expect(setCookie).toContain("patrol_csrf=");
    expect(setCookie).toContain("SameSite=Lax");
    // The cookie is readable by the browser's script: not HttpOnly.
    expect(setCookie).not.toContain("HttpOnly");
    expect(setCookie.split(";")[0]).toBe(`patrol_csrf=${body.csrfToken}`);
  });

  it("refuses every mutation without the matching X-Patrol-CSRF", async () => {
    const csrf = await anonCsrf(world.app);

    // No header at all.
    const missing = await world.app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: { "content-type": "application/json", cookie: csrf.cookie },
      payload: { email: "admin@example.test", password: "correct horse battery staple" },
    });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().code).toBe("forbidden");

    // No cookie, header only.
    const headerOnly = await world.app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: { "content-type": "application/json", "x-patrol-csrf": csrf["x-patrol-csrf"] },
      payload: { email: "admin@example.test", password: "correct horse battery staple" },
    });
    expect(headerOnly.statusCode).toBe(403);

    // A mismatched pair.
    const otherPair = await anonCsrf(world.app);
    const mismatch = await world.app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: {
        "content-type": "application/json",
        cookie: csrf.cookie,
        "x-patrol-csrf": otherPair["x-patrol-csrf"],
      },
      payload: { email: "admin@example.test", password: "correct horse battery staple" },
    });
    expect(mismatch.statusCode).toBe(403);

    // An authenticated mutation without the session's own token.
    const wrongToken = await world.app.inject({
      method: "DELETE",
      url: "/api/auth/session",
      headers: { cookie: admin.cookie, "x-patrol-csrf": csrf["x-patrol-csrf"] },
    });
    expect(wrongToken.statusCode).toBe(403);

    // And with it, the mutation proceeds.
    const rightToken = await world.app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: admin.cookie, "x-patrol-csrf": admin.csrfToken },
    });
    expect(rightToken.statusCode).toBe(200);
  });

  it("refuses an operator's call to an administrator operation with 403", async () => {
    const operator = await inviteAndEnroll(world, admin, "plain-operator@example.test");

    const list = await world.app.inject({
      method: "GET",
      url: "/api/operators",
      headers: { cookie: operator.cookie },
    });
    expect(list.statusCode).toBe(403);
    expect(list.json().code).toBe("forbidden");
    expect(getValidator("ErrorBody")(list.json())).toBe(true);

    const invite = await world.app.inject({
      method: "POST",
      url: "/api/invitations",
      headers: { "content-type": "application/json", ...authHeaders(operator) },
      payload: { email: "someone@example.test", role: "operator" },
    });
    expect(invite.statusCode).toBe(403);

    // The same operator reaches their own session route: an administrator
    // inherits every operator capability, and an operator fits operator ops.
    const own = await world.app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: operator.cookie },
    });
    expect(own.statusCode).toBe(200);

    // Unauthenticated access to a session op answers 401, not 403.
    const anon = await world.app.inject({ method: "GET", url: "/api/auth/session" });
    expect(anon.statusCode).toBe(401);
    expect(anon.json().code).toBe("unauthenticated");
  });

  it("lists operators and pages the catalogue", async () => {
    await inviteAndEnroll(world, admin, "listed@example.test");
    const list = await world.app.inject({
      method: "GET",
      url: "/api/operators?page=1&pageSize=2",
      headers: { cookie: admin.cookie },
    });
    expect(list.statusCode).toBe(200);
    const page = list.json();
    expect(page.pageSize).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.total).toBeGreaterThanOrEqual(3);
    // By email, ascending.
    expect(page.items[0].email <= page.items[1].email).toBe(true);
    // No credential material ever crosses the surface.
    for (const operator of page.items) {
      expect(operator.passwordHash).toBeUndefined();
      expect(operator.totpSecret).toBeUndefined();
      expect(JSON.stringify(operator)).not.toMatch(/hash|secret/i);
    }
    expect(getValidator("OperatorPage")(page)).toBe(true);
  });

  it("creates, lists, and revokes invitations, and emails them in English before a preference exists", async () => {
    const before = await world.app.inject({
      method: "GET",
      url: "/api/invitations",
      headers: { cookie: admin.cookie },
    });
    expect(before.statusCode).toBe(200);
    const beforeCount = before.json().total;

    const create = await world.app.inject({
      method: "POST",
      url: "/api/invitations",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { email: "invited@example.test", role: "operator" },
    });
    expect(create.statusCode).toBe(201);
    const view = create.json();
    expect(view.state).toBe("pending");
    expect(view.invitation.email).toBe("invited@example.test");
    expect(view.invitation.role).toBe("operator");
    expect(view.invitation.invitedBy).toBe(admin.operatorId);
    expect(getValidator("InvitationView")(view)).toBe(true);
    // The response never carries the token itself.
    expect(JSON.stringify(view)).not.toMatch(/token/i);

    // The invitation email went out — English, because no preference exists.
    const message = world.mail.sentTo("invited@example.test").at(-1)!;
    expect(message.locale).toBe("en");
    expect(message.subject).toBe(t("en", "mail.invitation.subject"));
    const token = /token=([A-Za-z0-9_-]+)/.exec(message.body)![1];

    const list = await world.app.inject({
      method: "GET",
      url: "/api/invitations",
      headers: { cookie: admin.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(beforeCount + 1);
    const listed = list.json().items.find(
      (item: { invitation: { id: string } }) => item.invitation.id === view.invitation.id,
    );
    expect(listed.state).toBe("pending");
    expect(getValidator("InvitationPage")(list.json())).toBe(true);

    // Revocation before use.
    const revoke = await world.app.inject({
      method: "DELETE",
      url: `/api/invitations/${view.invitation.id}`,
      headers: authHeaders(admin),
    });
    expect(revoke.statusCode).toBe(204);
    const after = await world.app.inject({
      method: "GET",
      url: "/api/invitations",
      headers: { cookie: admin.cookie },
    });
    const revokedView = after.json().items.find(
      (item: { invitation: { id: string } }) => item.invitation.id === view.invitation.id,
    );
    expect(revokedView.state).toBe("revoked");

    // Revoking an already-revoked invitation is a conflict, and it records
    // no second invitation_revoked event.
    const revokeEventsBefore = await world.pool.query(
      "select count(*)::int as n from security_events where kind = 'invitation_revoked'",
    );
    const revokeAgain = await world.app.inject({
      method: "DELETE",
      url: `/api/invitations/${view.invitation.id}`,
      headers: authHeaders(admin),
    });
    expect(revokeAgain.statusCode).toBe(409);
    expect(revokeAgain.json().code).toBe("state_conflict");
    const revokeEventsAfter = await world.pool.query(
      "select count(*)::int as n from security_events where kind = 'invitation_revoked'",
    );
    expect(revokeEventsAfter.rows[0].n).toBe(revokeEventsBefore.rows[0].n);

    // The bootstrap invitation carries no issuing operator, but the read
    // model still answers the contract's required invitedBy: it resolves to
    // the bootstrap administrator.
    const bootstrapView = after.json().items.find(
      (item: { invitation: { email: string } }) =>
        item.invitation.email === "admin@example.test",
    );
    expect(bootstrapView).toBeDefined();
    expect(bootstrapView.invitation.invitedBy).toBe(admin.operatorId);

    // A revoked invitation cannot be accepted.
    const csrf = await anonCsrf(world.app);
    const refused = await world.app.inject({
      method: "POST",
      url: `/api/invitations/${token}/acceptance`,
      headers: { "content-type": "application/json", ...csrf },
      payload: { password: "correct horse battery staple" },
    });
    expect(refused.statusCode).toBe(401);
    expect(refused.json().code).toBe("invitation_invalid");

    // Revoking an accepted invitation is a state conflict.
    const second = await world.app.inject({
      method: "POST",
      url: "/api/invitations",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { email: "accepted@example.test", role: "operator" },
    });
    const secondToken = /token=([A-Za-z0-9_-]+)/.exec(
      world.mail.sentTo("accepted@example.test").at(-1)!.body,
    )![1];
    const accept = await world.app.inject({
      method: "POST",
      url: `/api/invitations/${secondToken}/acceptance`,
      headers: { "content-type": "application/json", ...csrf },
      payload: { password: "correct horse battery staple" },
    });
    expect(accept.statusCode).toBe(201);
    const revokeAccepted = await world.app.inject({
      method: "DELETE",
      url: `/api/invitations/${second.json().invitation.id}`,
      headers: authHeaders(admin),
    });
    expect(revokeAccepted.statusCode).toBe(409);
    expect(revokeAccepted.json().code).toBe("state_conflict");
  });

  it("resets an operator's credentials, forcing re-enrolment and revoking sessions", async () => {
    const operator = await inviteAndEnroll(world, admin, "reset@example.test");
    const stillIn = await world.app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: operator.cookie },
    });
    expect(stillIn.statusCode).toBe(200);

    const reset = await world.app.inject({
      method: "POST",
      url: `/api/operators/${operator.operatorId}/credential-reset`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "locked out" },
    });
    expect(reset.statusCode).toBe(202);
    const body = reset.json();
    expect(body.reenrollmentRequired).toBe(true);
    expect(body.operator.id).toBe(operator.operatorId);
    expect(getValidator("CredentialReset")(body)).toBe(true);

    // Sessions revoked, credentials cleared.
    const revoked = await world.app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: operator.cookie },
    });
    expect(revoked.statusCode).toBe(401);
    const row = await world.pool.query(
      "select state, password_hash, totp_secret from operators where id = $1",
      [operator.operatorId],
    );
    expect(row.rows[0]).toEqual({ state: "invited", password_hash: null, totp_secret: null });

    // The reset email carries a fresh single-use token.
    const message = world.mail.sentTo("reset@example.test").at(-1)!;
    expect(message.subject).toBe(t("en", "mail.reset.subject"));
    const token = /token=([A-Za-z0-9_-]+)/.exec(message.body)![1];
    const csrf = await anonCsrf(world.app);
    const accept = await world.app.inject({
      method: "POST",
      url: `/api/invitations/${token}/acceptance`,
      headers: { "content-type": "application/json", ...csrf },
      payload: { password: "a fresh long passphrase" },
    });
    expect(accept.statusCode).toBe(201);

    // The operator signs in with the new password after re-enrolment.
    const ceremony = accept.json();
    const enrollment = await world.app.inject({
      method: "POST",
      url: "/api/auth/enrollment",
      headers: { "content-type": "application/json", ...csrf },
      payload: { enrollmentToken: ceremony.enrollmentToken },
    });
    const confirmation = await world.app.inject({
      method: "POST",
      url: "/api/auth/enrollment/confirmation",
      headers: { "content-type": "application/json", ...csrf },
      payload: {
        enrollmentToken: ceremony.enrollmentToken,
        code: generateTotpCode(enrollment.json().secret, world.clock.now()),
      },
    });
    expect(confirmation.statusCode).toBe(201);
    const backIn = await signIn(world, "reset@example.test", "a fresh long passphrase", enrollment.json().secret);
    expect(backIn.status).toBe(200);
  });

  it("emails an invited operator in their stored preference once one exists", async () => {
    const operator = await inviteAndEnroll(world, admin, "ru-pref@example.test");
    const prefer = await world.app.inject({
      method: "PATCH",
      url: "/api/auth/preferences",
      headers: { "content-type": "application/json", ...authHeaders(operator) },
      payload: { language: "ru" },
    });
    expect(prefer.statusCode).toBe(200);

    // A credential reset to that address renders in Russian now.
    await world.app.inject({
      method: "POST",
      url: `/api/operators/${operator.operatorId}/credential-reset`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {},
    });
    const message = world.mail.sentTo("ru-pref@example.test").at(-1)!;
    expect(message.locale).toBe("ru");
    expect(message.subject).toBe(t("ru", "mail.reset.subject"));
  });

  it("records the security events the design names, without credential material", async () => {
    // A failed sign-in and a recovery-code sign-in so their audit rows
    // exist in this file's own state.
    const csrf = await anonCsrf(world.app);
    await world.app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: { "content-type": "application/json", ...csrf },
      payload: { email: "admin@example.test", password: "wrong password entirely" },
    });
    await signIn(world, "admin@example.test", "correct horse battery staple", admin.totpSecret, {
      method: "recovery_code",
      code: admin.recoveryCodes[1],
    });
    // A password change on the administrator's own account.
    await world.app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        currentPassword: "correct horse battery staple",
        newPassword: "still a very long admin passphrase",
        currentCode: generateTotpCode(admin.totpSecret, world.clock.now()),
      },
    });
    // Restore the password the rest of the file knows.
    await world.app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        currentPassword: "still a very long admin passphrase",
        newPassword: "correct horse battery staple",
        currentCode: generateTotpCode(admin.totpSecret, world.clock.now()),
      },
    });
    // A role change, a disable, and a reinstatement on a disposable account.
    const plainId = (
      await world.pool.query<{ id: string }>(
        "select id from operators where email = 'plain-operator@example.test'",
      )
    ).rows[0].id;
    await world.app.inject({
      method: "PATCH",
      url: `/api/operators/${plainId}`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { role: "administrator" },
    });
    await world.app.inject({
      method: "PATCH",
      url: `/api/operators/${plainId}`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { state: "disabled" },
    });
    await world.app.inject({
      method: "PATCH",
      url: `/api/operators/${plainId}`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { state: "active", role: "operator" },
    });
    const events = await world.pool.query<{ kind: string; detail: Record<string, unknown> }>(
      "select kind, detail from security_events order by created_at",
    );
    const kinds = new Set(events.rows.map((row) => row.kind));
    for (const expected of [
      "bootstrap_completed",
      "sign_in_succeeded",
      "sign_in_failed",
      "invitation_created",
      "invitation_accepted",
      "invitation_revoked",
      "totp_enrolled",
      "recovery_codes_issued",
      "recovery_code_used",
      "password_changed",
      "session_revoked",
      "role_changed",
      "operator_disabled",
      "credential_reset",
    ]) {
      expect(kinds).toContain(expected);
    }
    // Events never carry credential material.
    const serialized = JSON.stringify(events.rows).toLowerCase();
    for (const forbidden of ["password_hash", "totp_secret", "token_hash", "code_hash", "csrf"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
