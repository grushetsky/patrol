import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp, poolSchemaStamp, testConfig, controlledClock } from "../test-app.js";
import { MemoryMailTransport } from "../../src/mail/transport.js";
import { runCli } from "../../src/cli/index.js";
import { generateTotpCode } from "../../src/domain/totp.js";
import { testPool } from "./helpers.js";

/**
 * The shared driver of the full identity ceremony against a real migrated
 * database: bootstrap, setup, TOTP enrolment, and a signed-in session with
 * its CSRF pair. The clock is frozen at a fixed instant, so TOTP codes are
 * deterministic and session lifetimes are advanced explicitly.
 */
export const FROZEN_NOW = "2026-01-01T00:00:00.000Z";

export interface CeremonyApp {
  app: FastifyInstance;
  pool: Pool;
  mail: MemoryMailTransport;
  clock: ReturnType<typeof controlledClock>;
}

export async function ceremonyApp(): Promise<CeremonyApp> {
  const pool = testPool();
  const clock = controlledClock(FROZEN_NOW);
  const mail = new MemoryMailTransport();
  const app = await buildApp({
    config: testConfig({ now: clock.now }),
    pool,
    mail,
    schemaStamp: poolSchemaStamp(pool),
  });
  return { app, pool, mail, clock };
}

/** GET /auth/csrf's cookie+header pair, which every mutation carries. */
export async function anonCsrf(
  app: FastifyInstance,
): Promise<Record<string, string>> {
  const response = await app.inject({ method: "GET", url: "/api/auth/csrf" });
  const token = response.json().csrfToken as string;
  const cookie = String(response.headers["set-cookie"]).split(";")[0];
  return { cookie, "x-patrol-csrf": token };
}

export interface SignedInOperator {
  operatorId: string;
  email: string;
  cookie: string;
  csrfToken: string;
  totpSecret: string;
  recoveryCodes: string[];
}

/** The full bootstrap-to-signed-in-administrator ceremony over HTTP. */
export async function bootstrapAdministrator(
  world: CeremonyApp,
  email = "admin@example.test",
): Promise<{ setupToken: string }> {
  const lines: string[] = [];
  const code = await runCli(
    ["bootstrap", "--legal-name", "Example Rights GmbH", "--country", "DE", "--admin-email", email],
    {
      pool: world.pool,
      config: testConfig({ now: world.clock.now }),
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    },
  );
  if (code !== 0) {
    throw new Error(`bootstrap failed: ${lines.join("\n")}`);
  }
  const token = lines.find(
    (line) => line.length > 40 && /^[A-Za-z0-9_-]+$/.test(line),
  );
  if (!token) {
    throw new Error(`bootstrap printed no token: ${lines.join("\n")}`);
  }
  return { setupToken: token };
}

/** Drives setup + enrolment + confirmation; returns the signed-in operator. */
export async function enrollOperator(
  world: CeremonyApp,
  setupToken: string,
  email: string,
  password = "correct horse battery staple",
): Promise<SignedInOperator> {
  const { app } = world;
  const csrf = await anonCsrf(app);
  const setup = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    headers: { "content-type": "application/json", ...csrf },
    payload: { token: setupToken, password },
  });
  if (setup.statusCode !== 201) {
    throw new Error(`setup failed: ${setup.body}`);
  }
  const ceremony = setup.json();
  const enrollment = await app.inject({
    method: "POST",
    url: "/api/auth/enrollment",
    headers: { "content-type": "application/json", ...csrf },
    payload: { enrollmentToken: ceremony.enrollmentToken },
  });
  if (enrollment.statusCode !== 200) {
    throw new Error(`enrollment failed: ${enrollment.body}`);
  }
  const { secret } = enrollment.json();
  const confirmation = await app.inject({
    method: "POST",
    url: "/api/auth/enrollment/confirmation",
    headers: { "content-type": "application/json", ...csrf },
    payload: {
      enrollmentToken: ceremony.enrollmentToken,
      code: generateTotpCode(secret, world.clock.now()),
    },
  });
  if (confirmation.statusCode !== 201) {
    throw new Error(`confirmation failed: ${confirmation.body}`);
  }
  const registered = confirmation.json();
  const cookie = String(confirmation.headers["set-cookie"]).split(";")[0];
  return {
    operatorId: registered.operator.id as string,
    email,
    cookie,
    csrfToken: registered.csrfToken as string,
    totpSecret: secret as string,
    recoveryCodes: registered.recoveryCodes as string[],
  };
}

/** Bootstrap + enroll in one step: one signed-in administrator. */
export async function signedInAdministrator(
  world: CeremonyApp,
  email = "admin@example.test",
): Promise<SignedInOperator> {
  const { setupToken } = await bootstrapAdministrator(world, email);
  return enrollOperator(world, setupToken, email);
}

/**
 * Invites and enrols one more operator through the administrator's own
 * session: the invitation email carries the single-use token.
 */
export async function inviteAndEnroll(
  world: CeremonyApp,
  admin: SignedInOperator,
  email: string,
  role: "operator" | "administrator" = "operator",
  password = "correct horse battery staple",
): Promise<SignedInOperator> {
  const invite = await world.app.inject({
    method: "POST",
    url: "/api/invitations",
    headers: {
      "content-type": "application/json",
      cookie: admin.cookie,
      "x-patrol-csrf": admin.csrfToken,
    },
    payload: { email, role },
  });
  if (invite.statusCode !== 201) {
    throw new Error(`invitation failed: ${invite.body}`);
  }
  const message = world.mail.sentTo(email).at(-1);
  const match = /token=([A-Za-z0-9_-]+)/.exec(message?.body ?? "");
  if (!match) {
    throw new Error(`invitation email carries no token: ${message?.body}`);
  }
  return enrollOperator(world, decodeURIComponent(match[1]), email, password);
}

/** The headers an authenticated mutation carries. */
export function authHeaders(operator: SignedInOperator): Record<string, string> {
  return { cookie: operator.cookie, "x-patrol-csrf": operator.csrfToken };
}

/** Signs an enrolled operator in over HTTP and returns the fresh pair. */
export async function signIn(
  world: CeremonyApp,
  email: string,
  password: string,
  totpSecret: string,
  options: { headers?: Record<string, string>; method?: "totp" | "recovery_code"; code?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; setCookie?: string; headers: Record<string, string> }> {
  const { app } = world;
  const csrf = await anonCsrf(app);
  const merged = { ...csrf, ...(options.headers ?? {}) };
  const first = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in",
    headers: { "content-type": "application/json", ...merged },
    payload: { email, password },
  });
  if (first.statusCode !== 202) {
    return {
      status: first.statusCode,
      body: first.json() as Record<string, unknown>,
      headers: merged,
    };
  }
  const challenge = first.json();
  const second = await app.inject({
    method: "POST",
    url: "/api/auth/second-factor",
    headers: { "content-type": "application/json", ...merged },
    payload: {
      challengeId: challenge.challengeId,
      code:
        options.code ??
        generateTotpCode(totpSecret, world.clock.now()),
      method: options.method ?? "totp",
    },
  });
  return {
    status: second.statusCode,
    body: second.json() as Record<string, unknown>,
    setCookie: second.headers["set-cookie"]
      ? String(second.headers["set-cookie"]).split(";")[0]
      : undefined,
    headers: merged,
  };
}
