import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { t } from "@patrol/i18n";
import { getValidator } from "../../src/plugins/validator.js";
import { generateTotpCode } from "../../src/domain/totp.js";
import { MAX_FAILED_ATTEMPTS } from "../../src/domain/lockout.js";
import {
  anonCsrf,
  ceremonyApp,
  inviteAndEnroll,
  signIn,
  signedInAdministrator,
  type CeremonyApp,
} from "./ceremony.js";

/**
 * Seam 4 (the two-step sign-in): a wrong password counts and answers
 * invalid_credentials, the tenth failure locks the account for fifteen
 * minutes, a locked account refuses even the correct password, a correct
 * password answers 202 with a challenge, a wrong second factor answers
 * invalid_second_factor, an expired challenge answers challenge_expired,
 * and a correct code answers 200 with the cookie and the CSRF token.
 */
describe("sign-in, second factor, and lockout", () => {
  let world: CeremonyApp;
  let admin: Awaited<ReturnType<typeof signedInAdministrator>>;
  const email = "admin@example.test";
  const password = "correct horse battery staple";

  beforeAll(async () => {
    world = await ceremonyApp();
    admin = await signedInAdministrator(world, email);
  });

  afterAll(async () => {
    await world.app.close();
    await world.pool.end();
  });

  async function wrongPassword(): Promise<number> {
    const csrf = await anonCsrf(world.app);
    const response = await world.app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: { "content-type": "application/json", ...csrf },
      payload: { email, password: "not the password at all" },
    });
    return response.statusCode;
  }

  async function failures(): Promise<number> {
    const result = await world.pool.query<{ failed_attempts: number }>(
      "select failed_attempts from operators where email = $1",
      [email],
    );
    return result.rows[0].failed_attempts;
  }

  it("counts wrong passwords and locks on the tenth", async () => {
    for (let attempt = 1; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      expect(await wrongPassword()).toBe(401);
      expect(await failures()).toBe(attempt);
    }
    // The tenth wrong password is the lock.
    const csrf = await anonCsrf(world.app);
    const tenth = await world.app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: { "content-type": "application/json", ...csrf },
      payload: { email, password: "still not the password" },
    });
    expect(tenth.statusCode).toBe(429);
    const body = tenth.json();
    expect(body.code).toBe("account_locked");
    expect(body.retryAfterSeconds).toBe(15 * 60);
    expect(getValidator("ErrorBody")(body)).toBe(true);
    expect(tenth.headers["retry-after"]).toBeUndefined();

    const locked = await world.pool.query<{ locked_until: Date | null }>(
      "select locked_until from operators where email = $1",
      [email],
    );
    expect(locked.rows[0].locked_until).not.toBeNull();
    const events = await world.pool.query(
      "select count(*)::int as n from security_events where kind = 'account_locked'",
    );
    expect(events.rows[0].n).toBe(1);
  });

  it("refuses the correct password while the lock holds, then admits it after", async () => {
    // Correct password, still locked.
    const csrf = await anonCsrf(world.app);
    const whileLocked = await world.app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: { "content-type": "application/json", ...csrf },
      payload: { email, password },
    });
    expect(whileLocked.statusCode).toBe(429);
    expect(whileLocked.json().code).toBe("account_locked");

    // Fifteen minutes later the lock has lapsed and sign-in succeeds.
    world.clock.advance(15 * 60 * 1000 + 1000);
    const secret = await world.pool.query<{ totp_secret: string }>(
      "select totp_secret from operators where email = $1",
      [email],
    );
    const result = await signIn(
      world,
      email,
      password,
      secret.rows[0].totp_secret,
    );
    expect(result.status).toBe(200);
    expect(result.body.csrfToken).toBeTypeOf("string");
    expect(result.setCookie).toContain("patrol_session=");
    expect(getValidator("AuthenticatedSession")({ ...result.body, session: result.body.session })).toBe(true);
    // The counter reset with the successful sign-in.
    expect(await failures()).toBe(0);
  });

  it("refuses a wrong second factor and expires stale challenges", async () => {
    const secretRow = await world.pool.query<{ totp_secret: string }>(
      "select totp_secret from operators where email = $1",
      [email],
    );
    const secret = secretRow.rows[0].totp_secret;

    const wrong = await signIn(world, email, password, secret, {
      code: "000000",
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe("invalid_second_factor");

    // A challenge expires after five minutes.
    const csrf = await anonCsrf(world.app);
    const challenge = await world.app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: { "content-type": "application/json", ...csrf },
      payload: { email, password },
    });
    expect(challenge.statusCode).toBe(202);
    world.clock.advance(5 * 60 * 1000 + 1000);
    const stale = await world.app.inject({
      method: "POST",
      url: "/api/auth/second-factor",
      headers: { "content-type": "application/json", ...csrf },
      payload: {
        challengeId: challenge.json().challengeId,
        code: generateTotpCode(secret, world.clock.now()),
        method: "totp",
      },
    });
    expect(stale.statusCode).toBe(401);
    expect(stale.json().code).toBe("challenge_expired");

    // An unknown challenge answers the same code.
    const unknown = await world.app.inject({
      method: "POST",
      url: "/api/auth/second-factor",
      headers: { "content-type": "application/json", ...csrf },
      payload: { challengeId: "no-such-challenge", code: "123456", method: "totp" },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().code).toBe("challenge_expired");
  });

  it("signs in with a recovery code, reports the remainder, and burns the code", async () => {
    const codes = await world.pool.query<{ code_hash: string }>(
      "select code_hash from recovery_codes where operator_id = (select id from operators where email = $1)",
      [email],
    );
    expect(codes.rows.length).toBe(10);

    // A second operator, invited through the administrator's own session,
    // holds the ten recovery codes its enrolment issued.
    const operator = await inviteAndEnroll(world, admin, "recover@example.test");
    const used = operator.recoveryCodes[0];
    const first = await signIn(world, "recover@example.test", "correct horse battery staple", operator.totpSecret, {
      method: "recovery_code",
      code: used,
    });
    expect(first.status).toBe(200);
    expect(first.body.recoveryCodesRemaining).toBe(9);
    expect(first.setCookie).toContain("patrol_session=");

    // The used code is consumed at the database level: the row is gone,
    // not flagged.
    const spent = await world.pool.query(
      "select count(*)::int as n from recovery_codes where operator_id = (select id from operators where email = 'recover@example.test')",
    );
    expect(spent.rows[0].n).toBe(9);

    // The same code cannot sign in again.
    const replay = await signIn(world, "recover@example.test", "correct horse battery staple", operator.totpSecret, {
      method: "recovery_code",
      code: used,
    });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe("invalid_second_factor");

    // A mistyped recovery code answers the same error.
    const mistyped = await signIn(world, "recover@example.test", "correct horse battery staple", operator.totpSecret, {
      method: "recovery_code",
      code: "WRONG-CODE!",
    });
    expect(mistyped.status).toBe(401);
    expect(mistyped.body.code).toBe("invalid_second_factor");
  });

  it("makes a second-factor challenge single-use: a replay answers challenge_expired", async () => {
    const secretRow = await world.pool.query<{ totp_secret: string }>(
      "select totp_secret from operators where email = $1",
      [email],
    );
    const secret = secretRow.rows[0].totp_secret;
    const csrf = await anonCsrf(world.app);

    const challenge = await world.app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: { "content-type": "application/json", ...csrf },
      payload: { email, password },
    });
    expect(challenge.statusCode).toBe(202);
    const challengeId = challenge.json().challengeId as string;

    const first = await world.app.inject({
      method: "POST",
      url: "/api/auth/second-factor",
      headers: { "content-type": "application/json", ...csrf },
      payload: {
        challengeId,
        code: generateTotpCode(secret, world.clock.now()),
        method: "totp",
      },
    });
    expect(first.statusCode).toBe(200);

    // The challenge died with the successful consumption.
    const replay = await world.app.inject({
      method: "POST",
      url: "/api/auth/second-factor",
      headers: { "content-type": "application/json", ...csrf },
      payload: {
        challengeId,
        code: generateTotpCode(secret, world.clock.now()),
        method: "totp",
      },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe("challenge_expired");
  });

  it("localizes a signed-in operator's error message to the stored preference", async () => {
    // Language resolution: the signed-in operator's stored preference wins
    // over the request's Accept-Language (implementation-rules "Language").
    const operator = await inviteAndEnroll(world, admin, "ru@example.test");
    const prefer = await world.app.inject({
      method: "PATCH",
      url: "/api/auth/preferences",
      headers: {
        "content-type": "application/json",
        cookie: operator.cookie,
        "x-patrol-csrf": operator.csrfToken,
        "accept-language": "en-US,en;q=0.9",
      },
      payload: { language: "ru" },
    });
    expect(prefer.statusCode).toBe(200);
    expect(prefer.json().preferredLanguage).toBe("ru");

    // The preference persists on the account and applies to later messages.
    const stored = await world.pool.query(
      "select preferred_language from operators where email = 'ru@example.test'",
    );
    expect(stored.rows[0].preferred_language).toBe("ru");

    const wrong = await world.app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: {
        "content-type": "application/json",
        cookie: operator.cookie,
        "x-patrol-csrf": operator.csrfToken,
        "accept-language": "en-US,en;q=0.9",
      },
      payload: {
        currentPassword: "not the current password",
        newPassword: "another correct horse battery",
        currentCode: "000000",
      },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().code).toBe("invalid_credentials");
    expect(wrong.json().message).toBe(t("ru", "errors.invalid_credentials"));

    // An anonymous error follows the request's Accept-Language instead.
    const anonymousRu = await world.app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: {
        "content-type": "application/json",
        "accept-language": "ru-RU,ru;q=0.9",
        ...(await anonCsrf(world.app)),
      },
      payload: { email: "ru@example.test", password: "wrong password entirely" },
    });
    expect(anonymousRu.statusCode).toBe(401);
    expect(anonymousRu.json().message).toBe(t("ru", "errors.invalid_credentials"));
    const anonymousEn = await world.app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: {
        "content-type": "application/json",
        "accept-language": "en-US,en;q=0.9",
        ...(await anonCsrf(world.app)),
      },
      payload: { email: "ru@example.test", password: "wrong password entirely" },
    });
    expect(anonymousEn.json().message).toBe(t("en", "errors.invalid_credentials"));
  });
});
