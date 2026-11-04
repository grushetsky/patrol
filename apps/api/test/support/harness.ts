import { newDb } from "pg-mem";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../../src/app.js";
import { AuthService } from "../../src/auth/service.js";
import { totpCode } from "../../src/auth/totp.js";
import { CatalogueService } from "../../src/catalogue/service.js";
import { loadContract, type Contract } from "../../src/contract.js";
import { migrate, type Connectable } from "../../src/db/migrations.js";
import { SettingsService } from "../../src/settings/service.js";
import type { WikidataSource } from "../../src/catalogue/wikidata.js";

export const PASSWORD = "correct horse battery";
export const MIGRATIONS_DIR = new URL("../../drizzle", import.meta.url).pathname;
export const SCHEMA_BUNDLE = new URL(
  "../../../../contract/generated/json-schema/patrol",
  import.meta.url,
);

export interface TestHarness {
  app: FastifyInstance;
  auth: AuthService;
  catalogue: CatalogueService;
  settings: SettingsService;
  contract: Contract;
  db: Connectable;
}

export async function harness(wikidata?: WikidataSource): Promise<TestHarness> {
  const memory = newDb();
  const adapter = memory.adapters.createPg();
  const db = new adapter.Pool() as unknown as Connectable;
  await migrate(db, MIGRATIONS_DIR);
  const auth = new AuthService(db);
  const catalogue = new CatalogueService(db, wikidata);
  const settings = new SettingsService(db);
  const contract = await loadContract(SCHEMA_BUNDLE);
  const app = buildApp({
    db,
    contract,
    auth,
    catalogue,
    settings,
    buildVersion: "0.1.0",
    expectedMigration: "0002_catalogue_settings",
    logger: process.env.DEBUG_APP === "1",
  });
  return { app, auth, catalogue, settings, contract, db };
}

export type Harness = TestHarness;

export async function csrf(app: FastifyInstance) {
  const response = await app.inject({ method: "GET", url: "/api/auth/csrf" });
  const token = response.cookies[0].value;
  return {
    header: { "x-patrol-csrf": token },
    cookies: { patrol_csrf: token },
    token,
  };
}

export function sessionCookie(response: {
  cookies: Array<{ name: string; value: string }>;
}) {
  return response.cookies.find(
    (cookie) => cookie.name === "__Host-patrol_session",
  )?.value;
}

export async function bootstrapAdmin({ app, auth }: Harness) {
  const bootstrap = await auth.bootstrap({
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
  if (setup.statusCode !== 201) {
    throw new Error(`setup failed: ${setup.statusCode} ${setup.body}`);
  }
  const enrollmentToken = setup.json().enrollmentToken as string;

  const enrollment = await app.inject({
    method: "POST",
    url: "/api/auth/enrollment",
    headers: token.header,
    cookies: token.cookies,
    payload: { enrollmentToken },
  });
  const secret = enrollment.json().secret as string;

  const registered = await app.inject({
    method: "POST",
    url: "/api/auth/enrollment/confirmation",
    headers: token.header,
    cookies: token.cookies,
    payload: { enrollmentToken, code: totpCode(secret) },
  });
  if (registered.statusCode !== 201) {
    throw new Error(`enrollment failed: ${registered.statusCode} ${registered.body}`);
  }
  return {
    bootstrap,
    secret,
    session: sessionCookie(registered)!,
    operator: registered.json().operator as { id: string; email: string },
  };
}

export async function addOperator(
  auth: AuthService,
  adminId: string,
  email: string,
  role: "administrator" | "operator" = "operator",
) {
  const invitation = await auth.createInvitation(adminId, email, role);
  const accepted = await auth.acceptInvitation(invitation.token, PASSWORD);
  const enrollment = await auth.startEnrollment(accepted.enrollmentToken);
  const confirmed = await auth.confirmEnrollment(
    accepted.enrollmentToken,
    totpCode(enrollment.secret),
  );
  return { operator: confirmed.operator, session: confirmed.token };
}

/** Inject an authenticated mutation with a fresh CSRF token pair. */
export async function mutate(
  app: FastifyInstance,
  session: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  const token = await csrf(app);
  return app.inject({
    method,
    url,
    headers: token.header,
    cookies: { ...token.cookies, "__Host-patrol_session": session },
    ...(payload === undefined ? {} : { payload }),
  });
}

/** Inject an authenticated read. */
export function read(
  app: FastifyInstance,
  session: string,
  url: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "GET",
    url,
    cookies: { "__Host-patrol_session": session },
  });
}
