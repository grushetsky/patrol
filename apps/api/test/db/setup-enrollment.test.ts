import { afterAll, beforeAll, describe, expect, it } from "vitest";
import createClient from "openapi-fetch";
import { t } from "@patrol/i18n";
import type { paths } from "../../src/lib/api/schema.js";
import { fetchThroughInject } from "../helpers/inject-fetch.js";
import { getValidator } from "../../src/plugins/validator.js";
import { generateTotpCode } from "../../src/domain/totp.js";
import { hashRecoveryCode } from "../../src/domain/recovery.js";
import { testConfig } from "../test-app.js";
import {
  anonCsrf,
  authHeaders,
  bootstrapAdministrator,
  ceremonyApp,
  enrollOperator,
  type CeremonyApp,
} from "./ceremony.js";

/**
 * Seam 2 (setup token consumption) and seam 3 (the enrolment ceremony):
 * a valid bootstrap token opens the ceremony, an invalid or expired one
 * answers the declared codes, TOTP enrolment confirms into a session, and
 * the ten recovery codes come back exactly once. The typed client round
 * trip the slice-0 stub carried now runs against the real sign-in route.
 */
describe("setup and enrolment ceremony", () => {
  let world: CeremonyApp;
  let setupToken: string;
  const email = "founder@example.test";
  const password = "correct horse battery staple";

  beforeAll(async () => {
    world = await ceremonyApp();
    const boot = await bootstrapAdministrator(world, email);
    setupToken = boot.setupToken;
  });

  afterAll(async () => {
    await world.app.close();
    await world.pool.end();
  });

  it("refuses an unknown or wrong token with invitation_invalid", async () => {
    const csrf = await anonCsrf(world.app);
    const wrong = await world.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: { "content-type": "application/json", ...csrf },
      payload: { token: "definitely-not-the-token", password },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().code).toBe("invitation_invalid");
    expect(getValidator("ErrorBody")(wrong.json())).toBe(true);
  });

  it("refuses a breached or too-short password before consuming the token", async () => {
    const csrf = await anonCsrf(world.app);
    const breached = await world.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: { "content-type": "application/json", ...csrf },
      payload: { token: setupToken, password: "unbelievable" },
    });
    expect(breached.statusCode).toBe(400);
    expect(breached.json().code).toBe("validation_failed");
    expect(breached.json().fieldErrors[0].path).toBe("/password");
    expect(breached.json().fieldErrors[0].message).toBe(
      t("en", "password.breached"),
    );

    // A sub-twelve password is refused by the contract's own minLength.
    const short = await world.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: { "content-type": "application/json", ...csrf },
      payload: { token: setupToken, password: "short" },
    });
    expect(short.statusCode).toBe(400);
    expect(short.json().fieldErrors[0].path).toBe("/password");

    // The token survived both refusals.
    const consumed = await world.pool.query(
      "select accepted_at from invitations where email = $1",
      [email],
    );
    expect(consumed.rows[0].accepted_at).toBeNull();
  });

  it("answers invitation_expired for a token past its twenty-four hours", async () => {
    // A stale invitation inserted directly, aged past its TTL.
    const csrf = await anonCsrf(world.app);
    const { newOpaqueToken, sha256Hex } = await import("../../src/domain/session.js");
    const staleToken = newOpaqueToken();
    await world.pool.query(
      `insert into invitations (email, role, token_hash, invited_by, expires_at, created_at)
       values ('stale@example.test', 'operator', $1, null, $2, $2)`,
      [
        sha256Hex(staleToken),
        new Date("2025-12-30T00:00:00.000Z").toISOString(),
      ],
    );

    const expired = await world.app.inject({
      method: "POST",
      url: "/api/invitations/" + staleToken + "/acceptance",
      headers: { "content-type": "application/json", ...csrf },
      payload: { password },
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().code).toBe("invitation_expired");
  });

  it("consumes the setup token into an enrolment ceremony, then enrols and issues recovery codes once", async () => {
    const csrf = await anonCsrf(world.app);
    const setup = await world.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: { "content-type": "application/json", ...csrf },
      payload: { token: setupToken, password },
    });
    expect(setup.statusCode).toBe(201);
    const ceremony = setup.json();
    expect(ceremony.operator.email).toBe(email);
    expect(ceremony.operator.state).toBe("invited");
    expect(typeof ceremony.enrollmentToken).toBe("string");
    expect(getValidator("EnrollmentCeremony")(ceremony)).toBe(true);

    // The invitation is single-use now.
    const replay = await world.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: { "content-type": "application/json", ...csrf },
      payload: { token: setupToken, password },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe("invitation_invalid");

    // Enrolment shows the secret once, as base32 plus an otpauth URI.
    const enrollment = await world.app.inject({
      method: "POST",
      url: "/api/auth/enrollment",
      headers: { "content-type": "application/json", ...csrf },
      payload: { enrollmentToken: ceremony.enrollmentToken },
    });
    expect(enrollment.statusCode).toBe(200);
    const { secret, otpauthUri } = enrollment.json();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(otpauthUri).toContain("otpauth://totp/");
    expect(getValidator("TotpEnrollment")(enrollment.json())).toBe(true);

    // A wrong confirmation code is refused without consuming anything.
    const wrongCode = await world.app.inject({
      method: "POST",
      url: "/api/auth/enrollment/confirmation",
      headers: { "content-type": "application/json", ...csrf },
      payload: { enrollmentToken: ceremony.enrollmentToken, code: "000000" },
    });
    expect(wrongCode.statusCode).toBe(401);
    expect(wrongCode.json().code).toBe("invalid_second_factor");

    const confirmation = await world.app.inject({
      method: "POST",
      url: "/api/auth/enrollment/confirmation",
      headers: { "content-type": "application/json", ...csrf },
      payload: {
        enrollmentToken: ceremony.enrollmentToken,
        code: generateTotpCode(secret, world.clock.now()),
      },
    });
    expect(confirmation.statusCode).toBe(201);
    const registered = confirmation.json();
    expect(registered.operator.state).toBe("active");
    expect(registered.operator.email).toBe(email);
    expect(registered.recoveryCodes).toHaveLength(10);
    expect(getValidator("RegistrationCompleted")(registered)).toBe(true);
    expect(String(confirmation.headers["set-cookie"])).toContain("patrol_session=");

    // Recovery codes are stored hashed, never as themselves.
    const rows = await world.pool.query<{ code_hash: string }>(
      "select code_hash from recovery_codes",
    );
    expect(rows.rows).toHaveLength(10);
    for (const code of registered.recoveryCodes as string[]) {
      expect(rows.rows.map((row) => row.code_hash)).toContain(
        hashRecoveryCode(code, testConfig().recoveryPepper),
      );
    }
    expect(
      rows.rows.some((row) =>
        (registered.recoveryCodes as string[]).includes(row.code_hash),
      ),
    ).toBe(false);

    // The ceremony is over: a second confirmation attempt is refused.
    const second = await world.app.inject({
      method: "POST",
      url: "/api/auth/enrollment/confirmation",
      headers: { "content-type": "application/json", ...csrf },
      payload: {
        enrollmentToken: ceremony.enrollmentToken,
        code: generateTotpCode(secret, world.clock.now()),
      },
    });
    expect(second.statusCode).toBe(401);
    expect(second.json().code).toBe("unauthenticated");

    // And the session the confirmation issued carries its CSRF pair.
    const cookie = String(confirmation.headers["set-cookie"]).split(";")[0];
    const read = await world.app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().csrfToken).toBe(registered.csrfToken);
    expect(read.json().operator.email).toBe(email);
  });
});

describe("typed client round trip through the sign-in challenge", () => {
  let world: CeremonyApp;
  let client: ReturnType<typeof createClient<paths>>;

  beforeAll(async () => {
    world = await ceremonyApp();
    // The rights holder already exists in this file's database; issue the
    // invitation directly instead of a second CLI bootstrap.
    const { newOpaqueToken, sha256Hex } = await import("../../src/domain/session.js");
    const setupToken = newOpaqueToken();
    await world.pool.query(
      `insert into invitations (email, role, token_hash, invited_by, expires_at, created_at)
       values ('client@example.test', 'administrator', $1, null, now() + interval '24 hours', now())`,
      [sha256Hex(setupToken)],
    );
    const csrf = await anonCsrf(world.app);
    const setup = await world.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: { "content-type": "application/json", ...csrf },
      payload: { token: setupToken, password: "correct horse battery staple" },
    });
    const ceremony = setup.json();
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
    client = createClient<paths>({
      baseUrl: "http://patrol.test/api",
      fetch: fetchThroughInject(world.app),
    });
  });

  afterAll(async () => {
    await world.app.close();
    await world.pool.end();
  });

  it("reaches the two-step sign-in through the generated client", async () => {
    const health = await client.GET("/health");
    expect(health.response.status).toBe(200);
    expect(health.data?.status).toBe("ok");

    // The CSRF pair the anonymous mutations carry.
    const csrf = await client.GET("/auth/csrf");
    expect(csrf.response.status).toBe(200);
    const csrfToken = csrf.data?.csrfToken as string;
    const setCookie = csrf.response.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0];

    const challenge = await client.POST("/auth/sign-in", {
      params: { header: { "X-Patrol-CSRF": csrfToken } },
      headers: { cookie },
      body: {
        email: "client@example.test",
        password: "correct horse battery staple",
      },
    });
    expect(challenge.response.status).toBe(202);
    expect(typeof challenge.data?.challengeId).toBe("string");
    // The challenge body validates against the emitted schema bundle.
    expect(
      getValidator("SecondFactorChallenge")(challenge.data as unknown as Record<string, unknown>),
    ).toBe(true);

    const wrong = await client.POST("/auth/second-factor", {
      params: { header: { "X-Patrol-CSRF": csrfToken } },
      headers: { cookie },
      body: {
        challengeId: challenge.data!.challengeId,
        code: "000000",
        method: "totp",
      },
    });
    expect(wrong.response.status).toBe(401);
    expect(wrong.error).toMatchObject({ code: "invalid_second_factor" });
  });
});

describe("the invitation link's full ceremony through the typed client", () => {
  // The web enrollment screen's exact sequence, browser-less: the emailed
  // link's token plus a chosen password open the ceremony, the ceremony's
  // token drives TOTP enrolment, the confirmation signs the operator in,
  // and the recovery codes come back exactly once.
  let world: CeremonyApp;
  let admin: Awaited<ReturnType<typeof enrollOperator>>;
  let client: ReturnType<typeof createClient<paths>>;

  beforeAll(async () => {
    world = await ceremonyApp();
    // The rights holder already exists in this file's database; issue the
    // administrator invitation directly instead of a second CLI bootstrap.
    const { newOpaqueToken, sha256Hex } = await import("../../src/domain/session.js");
    const setupToken = newOpaqueToken();
    await world.pool.query(
      `insert into invitations (email, role, token_hash, invited_by, expires_at, created_at)
       values ('flow-admin@example.test', 'administrator', $1, null, now() + interval '24 hours', now())`,
      [sha256Hex(setupToken)],
    );
    admin = await enrollOperator(world, setupToken, "flow-admin@example.test");
    client = createClient<paths>({
      baseUrl: "http://patrol.test/api",
      fetch: fetchThroughInject(world.app),
    });
  });

  afterAll(async () => {
    await world.app.close();
    await world.pool.end();
  });

  it("drives link → password → TOTP → recovery codes → signed in", async () => {
    // The invitation email carries the link token, as the web route reads
    // it back from ?token=.
    const invite = await world.app.inject({
      method: "POST",
      url: "/api/invitations",
      headers: {
        "content-type": "application/json",
        cookie: admin.cookie,
        "x-patrol-csrf": admin.csrfToken,
      },
      payload: { email: "linked@example.test", role: "operator" },
    });
    expect(invite.statusCode).toBe(201);
    const message = world.mail.sentTo("linked@example.test").at(-1)!;
    const linkToken = /token=([A-Za-z0-9_-]+)/.exec(message.body)![1];

    const csrf = await client.GET("/auth/csrf");
    const anonCookie = (csrf.response.headers.get("set-cookie") ?? "").split(";")[0];
    const headers = { cookie: anonCookie };
    const csrfTokenHeader = { "X-Patrol-CSRF": csrf.data!.csrfToken };

    // The password step: exactly InvitationAcceptanceRequest.
    const acceptance = await client.POST("/invitations/{token}/acceptance", {
      params: { path: { token: decodeURIComponent(linkToken) }, header: csrfTokenHeader },
      headers,
      body: { password: "correct horse battery staple" },
    });
    expect(acceptance.response.status).toBe(201);
    const ceremonyToken = acceptance.data!.enrollmentToken;

    const enrollment = await client.POST("/auth/enrollment", {
      params: { header: csrfTokenHeader },
      headers,
      body: { enrollmentToken: ceremonyToken },
    });
    expect(enrollment.response.status).toBe(200);
    const secret = enrollment.data!.secret;

    const confirmation = await client.POST("/auth/enrollment/confirmation", {
      params: { header: csrfTokenHeader },
      headers,
      body: {
        enrollmentToken: ceremonyToken,
        code: generateTotpCode(secret, world.clock.now()),
      },
    });
    expect(confirmation.response.status).toBe(201);
    expect(confirmation.data!.recoveryCodes).toHaveLength(10);

    // The confirmation's session cookie signs the operator in.
    const sessionCookie = (confirmation.response.headers.get("set-cookie") ?? "")
      .split(";")[0];
    const session = await client.GET("/auth/session", {
      headers: { cookie: sessionCookie },
    });
    expect(session.response.status).toBe(200);
    expect(session.data!.operator.email).toBe("linked@example.test");
    expect(session.data!.operator.state).toBe("active");
    expect(session.data!.csrfToken).toBe(confirmation.data!.csrfToken);
  });
});

