import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateTotpCode } from "../../src/domain/totp.js";
import { IDLE_SESSION_MS, ABSOLUTE_SESSION_MS } from "../../src/domain/session.js";
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
 * Seam 7 (sessions): the eight-hour idle and seven-day absolute lifetimes
 * under the injected clock, rotation on re-authentication deleting the old
 * row, and every revocation trigger the design names — logout, password
 * change, TOTP re-enrolment, email change, role change, and an
 * administrator's disable — each in one transaction with the change.
 */
describe("session lifetime, rotation, and revocation triggers", () => {
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

  async function sessionRows(): Promise<{ id: string; operator_id: string }[]> {
    const result = await world.pool.query(
      "select id, operator_id from operator_sessions order by created_at",
    );
    return result.rows;
  }

  function sessionsOf(email: string): Promise<number> {
    return world.pool
      .query<{ n: number }>(
        "select count(*)::int as n from operator_sessions where operator_id = (select id from operators where email = $1)",
        [email],
      )
      .then((r) => r.rows[0].n);
  }

  it("expires a session after eight hours of inactivity and slides the idle window with use", async () => {
    // Its own clock: advancing time here must not age the shared world's
    // administrator session, which other tests still use.
    const timeWorld = await ceremonyApp();
    try {
      const session = await inviteAndEnroll(world, admin, "idle@example.test");
      const email = "idle@example.test";

      // Four hours of silence: still alive, and the idle window slides.
      timeWorld.clock.advance(4 * 60 * 60 * 1000);
      const at4h = await timeWorld.app.inject({
        method: "GET",
        url: "/api/auth/session",
        headers: { cookie: session.cookie },
      });
      expect(at4h.statusCode).toBe(200);

      // Another four hours since the last touch: still inside the slid window.
      timeWorld.clock.advance(4 * 60 * 60 * 1000 - 1000);
      const at8h = await timeWorld.app.inject({
        method: "GET",
        url: "/api/auth/session",
        headers: { cookie: session.cookie },
      });
      expect(at8h.statusCode).toBe(200);

      // Eight hours of silence since the last touch: refused.
      timeWorld.clock.advance(IDLE_SESSION_MS + 2000);
      const stale = await timeWorld.app.inject({
        method: "GET",
        url: "/api/auth/session",
        headers: { cookie: session.cookie },
      });
      expect(stale.statusCode).toBe(401);
      expect(stale.json().code).toBe("unauthenticated");
      expect(IDLE_SESSION_MS).toBe(8 * 60 * 60 * 1000);
    } finally {
      await timeWorld.app.close();
      await timeWorld.pool.end();
    }
  });

  it("expires a session at seven days absolute no matter the activity", async () => {
    const timeWorld = await ceremonyApp();
    try {
      const session = await inviteAndEnroll(world, admin, "absolute@example.test");
      // Touch the session every seven hours so the idle window alone would
      // keep it alive forever; only the absolute cap can end it.
      const step = 7 * 60 * 60 * 1000;
      for (let elapsed = 0; elapsed + step < ABSOLUTE_SESSION_MS - 60_000; elapsed += step) {
        timeWorld.clock.advance(step);
        const touch = await timeWorld.app.inject({
          method: "GET",
          url: "/api/auth/session",
          headers: { cookie: session.cookie },
        });
        expect(touch.statusCode).toBe(200);
      }
      // Past the absolute cap the session dies even though the idle window
      // was slid by every touch.
      timeWorld.clock.advance(step + 120_000);
      const after = await timeWorld.app.inject({
        method: "GET",
        url: "/api/auth/session",
        headers: { cookie: session.cookie },
      });
      expect(after.statusCode).toBe(401);
      expect(ABSOLUTE_SESSION_MS).toBe(7 * 24 * 60 * 60 * 1000);
    } finally {
      await timeWorld.app.close();
      await timeWorld.pool.end();
    }
  });

  it("rotates on re-authentication: a new row replaces the old one", async () => {
    const email = "rotate@example.test";
    const first = await inviteAndEnroll(world, admin, email);
    expect(await sessionsOf(email)).toBe(1);

    // Re-authenticate carrying the old cookie. The request holds a valid
    // session, so its CSRF echo is the session token, not the anonymous pair.
    const anon = await anonCsrf(world.app);
    const challenge = await world.app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: { "content-type": "application/json", ...anon },
      payload: { email, password: "correct horse battery staple" },
    });
    expect(challenge.statusCode).toBe(202);
    const secondFactor = await world.app.inject({
      method: "POST",
      url: "/api/auth/second-factor",
      headers: {
        "content-type": "application/json",
        cookie: first.cookie,
        "x-patrol-csrf": first.csrfToken,
      },
      payload: {
        challengeId: challenge.json().challengeId,
        code: generateTotpCode(first.totpSecret, world.clock.now()),
        method: "totp",
      },
    });
    expect(secondFactor.statusCode).toBe(200);
    const second = {
      status: secondFactor.statusCode,
      setCookie: String(secondFactor.headers["set-cookie"]).split(";")[0],
    };
    expect(second.setCookie).toBeDefined();
    expect(second.setCookie).not.toBe(first.cookie);
    // The anonymous pair cannot mutate while a session cookie rides along:
    // the session's own CSRF token is the one that echoes.
    const confused = await world.app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { "content-type": "application/json", ...anon, cookie: second.setCookie! },
      payload: {
        currentPassword: "correct horse battery staple",
        newPassword: "yet another long enough passphrase",
        currentCode: "000000",
      },
    });
    expect(confused.statusCode).toBe(403);
    expect(confused.json().code).toBe("forbidden");
    expect(await sessionsOf(email)).toBe(1);

    // The old cookie no longer names a session; the new one does.
    const old = await world.app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: first.cookie },
    });
    expect(old.statusCode).toBe(401);
    const fresh = await world.app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: second.setCookie! },
    });
    expect(fresh.statusCode).toBe(200);

    // A sign-in from a different device leaves the other session alone.
    const other = await signIn(world, email, "correct horse battery staple", first.totpSecret);
    expect(other.status).toBe(200);
    expect(await sessionsOf(email)).toBe(2);
  });

  it("deletes the current row on logout", async () => {
    const email = "logout@example.test";
    const session = await inviteAndEnroll(world, admin, email);
    expect(await sessionsOf(email)).toBe(1);
    const out = await world.app.inject({
      method: "DELETE",
      url: "/api/auth/session",
      headers: authHeaders(session),
    });
    expect(out.statusCode).toBe(204);
    expect(await sessionsOf(email)).toBe(0);
  });

  it("revokes every other session on a password change, keeping the current one", async () => {
    const email = "password@example.test";
    const session = await inviteAndEnroll(world, admin, email);
    const current = await signIn(world, email, "correct horse battery staple", session.totpSecret);
    const other = await signIn(world, email, "correct horse battery staple", session.totpSecret);
    expect(current.status).toBe(200);
    expect(other.status).toBe(200);
    expect(await sessionsOf(email)).toBe(3);

    const change = await world.app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: {
        "content-type": "application/json",
        cookie: current.setCookie!,
        "x-patrol-csrf": String(current.body.csrfToken),
      },
      payload: {
        currentPassword: "correct horse battery staple",
        newPassword: "a very different long passphrase",
        currentCode: generateTotpCode(session.totpSecret, world.clock.now()),
      },
    });
    expect(change.statusCode).toBe(204);
    expect(await sessionsOf(email)).toBe(1);

    // The current session survives; the others do not.
    const kept = await world.app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: current.setCookie! },
    });
    expect(kept.statusCode).toBe(200);
    const revoked = await world.app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: other.setCookie! },
    });
    expect(revoked.statusCode).toBe(401);

    // The new password signs in; the old one no longer does.
    const withNew = await signIn(world, email, "a very different long passphrase", session.totpSecret);
    expect(withNew.status).toBe(200);
    const withOld = await signIn(world, email, "correct horse battery staple", session.totpSecret);
    expect(withOld.status).toBe(401);
    expect(withOld.body.code).toBe("invalid_credentials");
  });

  it("revokes other sessions on TOTP re-enrolment and replaces the recovery codes", async () => {
    const email = "totp@example.test";
    const session = await inviteAndEnroll(world, admin, email);
    const other = await signIn(world, email, "correct horse battery staple", session.totpSecret);
    expect(await sessionsOf(email)).toBe(2);

    const start = await world.app.inject({
      method: "POST",
      url: "/api/auth/totp",
      headers: { "content-type": "application/json", ...authHeaders(session) },
      payload: {
        password: "correct horse battery staple",
        currentCode: generateTotpCode(session.totpSecret, world.clock.now()),
      },
    });
    expect(start.statusCode).toBe(200);
    const { secret } = start.json();

    const confirm = await world.app.inject({
      method: "POST",
      url: "/api/auth/totp/confirmation",
      headers: { "content-type": "application/json", ...authHeaders(session) },
      payload: { code: generateTotpCode(secret, world.clock.now()) },
    });
    expect(confirm.statusCode).toBe(200);
    const issued = confirm.json().recoveryCodes as string[];
    expect(issued).toHaveLength(10);
    // The fresh codes are all new.
    for (const code of issued) {
      expect(session.recoveryCodes).not.toContain(code);
    }

    // Other sessions are revoked; the current one survives.
    expect(await sessionsOf(email)).toBe(1);
    const kept = await world.app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: session.cookie },
    });
    expect(kept.statusCode).toBe(200);
    const revoked = await world.app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: other.setCookie! },
    });
    expect(revoked.statusCode).toBe(401);

    // The old secret no longer verifies; the new one does.
    const oldSecret = await signIn(world, email, "correct horse battery staple", session.totpSecret);
    expect(oldSecret.status).toBe(401);
    expect(oldSecret.body.code).toBe("invalid_second_factor");
    const newSecret = await signIn(world, email, "correct horse battery staple", secret);
    expect(newSecret.status).toBe(200);
  });

  it("revokes other sessions on an email change, which needs the current credentials", async () => {
    const email = "rename@example.test";
    const session = await inviteAndEnroll(world, admin, email);
    const other = await signIn(world, email, "correct horse battery staple", session.totpSecret);
    expect(await sessionsOf(email)).toBe(2);

    const change = await world.app.inject({
      method: "POST",
      url: "/api/auth/email",
      headers: { "content-type": "application/json", ...authHeaders(session) },
      payload: {
        newEmail: "renamed@example.test",
        currentPassword: "correct horse battery staple",
        currentCode: generateTotpCode(session.totpSecret, world.clock.now()),
      },
    });
    expect(change.statusCode).toBe(204);
    expect(await sessionsOf("renamed@example.test")).toBe(1);
    const revoked = await world.app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: other.setCookie! },
    });
    expect(revoked.statusCode).toBe(401);

    // The address is the sign-in identifier: the old one no longer resolves.
    const withOld = await signIn(world, email, "correct horse battery staple", session.totpSecret);
    expect(withOld.status).toBe(401);
    const withNew = await signIn(world, "renamed@example.test", "correct horse battery staple", session.totpSecret);
    expect(withNew.status).toBe(200);

    // A duplicate address is refused.
    const duplicate = await world.app.inject({
      method: "POST",
      url: "/api/auth/email",
      headers: { "content-type": "application/json", ...authHeaders(session) },
      payload: {
        newEmail: "admin@example.test",
        currentPassword: "correct horse battery staple",
        currentCode: generateTotpCode(session.totpSecret, world.clock.now()),
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("duplicate_entity");
  });

  it("revokes every session on a role change and on an administrator's disable", async () => {
    const email = "victim@example.test";
    const session = await inviteAndEnroll(world, admin, email);
    const other = await signIn(world, email, "correct horse battery staple", session.totpSecret);
    expect(await sessionsOf(email)).toBe(2);
    const operatorId = (await world.pool.query<{ id: string }>(
      "select id from operators where email = $1",
      [email],
    )).rows[0].id;

    // A role change ends every session the account holds.
    const promote = await world.app.inject({
      method: "PATCH",
      url: `/api/operators/${operatorId}`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { role: "administrator" },
    });
    expect(promote.statusCode).toBe(200);
    expect(promote.json().role).toBe("administrator");
    expect(await sessionsOf(email)).toBe(0);
    const afterRole = await world.app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: session.cookie },
    });
    expect(afterRole.statusCode).toBe(401);

    // Sign back in, then the administrator disables the account.
    const again = await signIn(world, email, "correct horse battery staple", session.totpSecret);
    expect(again.status).toBe(200);
    expect(await sessionsOf(email)).toBe(1);
    const disable = await world.app.inject({
      method: "PATCH",
      url: `/api/operators/${operatorId}`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { state: "disabled" },
    });
    expect(disable.statusCode).toBe(200);
    expect(disable.json().state).toBe("disabled");
    expect(disable.json().disabledAt).toBeTypeOf("string");
    expect(await sessionsOf(email)).toBe(0);

    // A disabled account cannot sign in.
    const denied = await signIn(world, email, "correct horse battery staple", session.totpSecret);
    expect(denied.status).toBe(401);
    expect(denied.body.code).toBe("invalid_credentials");
  });

  it("lists the operator's own sessions and revokes one by identifier", async () => {
    const email = "list@example.test";
    const session = await inviteAndEnroll(world, admin, email);
    const other = await signIn(world, email, "correct horse battery staple", session.totpSecret);
    expect(other.status).toBe(200);

    const list = await world.app.inject({
      method: "GET",
      url: "/api/auth/sessions",
      headers: { cookie: session.cookie },
    });
    expect(list.statusCode).toBe(200);
    const page = list.json();
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.items[0].userAgent).toBeTypeOf("string");
    // Newest first.
    expect(new Date(page.items[0].createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(page.items[1].createdAt).getTime(),
    );

    const revoked = await world.app.inject({
      method: "DELETE",
      url: `/api/auth/sessions/${page.items[1].id}`,
      headers: authHeaders(session),
    });
    expect(revoked.statusCode).toBe(204);
    expect(await sessionsOf(email)).toBe(1);

    // Another operator's session is not addressable.
    const foreign = await world.app.inject({
      method: "DELETE",
      url: `/api/auth/sessions/${(await sessionRows())[0].id}`,
      headers: authHeaders(session),
    });
    expect(foreign.statusCode).toBe(404);

    // An administrator lists and revokes any operator's sessions.
    const adminList = await world.app.inject({
      method: "GET",
      url: `/api/operators/${session.operatorId}/sessions`,
      headers: { cookie: admin.cookie },
    });
    expect(adminList.statusCode).toBe(200);
    expect(adminList.json().total).toBe(1);
    const adminRevoke = await world.app.inject({
      method: "DELETE",
      url: `/api/operators/${session.operatorId}/sessions/${adminList.json().items[0].id}`,
      headers: authHeaders(admin),
    });
    expect(adminRevoke.statusCode).toBe(204);
    expect(await sessionsOf(email)).toBe(0);
  });

  async function operatorSecret(email: string): Promise<string | null> {
    const result = await world.pool.query<{ totp_secret: string | null }>(
      "select totp_secret from operators where email = $1",
      [email],
    );
    return result.rows[0]?.totp_secret ?? null;
  }
});
