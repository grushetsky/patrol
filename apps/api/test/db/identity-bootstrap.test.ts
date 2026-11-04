import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { t } from "@patrol/i18n";
import { runCli } from "../../src/cli/index.js";
import { getValidator } from "../../src/plugins/validator.js";
import { testConfig } from "../test-app.js";
import {
  anonCsrf,
  authHeaders,
  ceremonyApp,
  enrollOperator,
  type CeremonyApp,
} from "./ceremony.js";

/**
 * Seam 1 (bootstrap CLI), seam 11 (setup gating), and seam 14 (the last
 * administrator), driven against the real migrated database: the CLI writes
 * the rights holder and the invited administrator and prints the one-time
 * token once; domain operations answer 503 setup_required before that and
 * work after; the last administrator cannot be demoted or disabled.
 */
describe("bootstrap, setup gating, and the last administrator", () => {
  let world: CeremonyApp;
  /** The bootstrap token the founder's ceremony consumes later in this file. */
  let founderSetupToken = "";
  /** The enrolled founder, the file's only administrator until a second joins. */
  let founder: Awaited<ReturnType<typeof enrollOperator>>;

  beforeAll(async () => {
    world = await ceremonyApp();
  });

  afterAll(async () => {
    await world.app.close();
    await world.pool.end();
  });

  async function cli(argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, {
      pool: world.pool,
      config: testConfig({ now: world.clock.now }),
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });
    return { code, out, err };
  }

  it("answers 503 setup_required on domain operations before bootstrap, leaving system and auth ops alone", async () => {
    const gated = await world.app.inject({ method: "GET", url: "/api/operators" });
    expect(gated.statusCode).toBe(503);
    expect(gated.json().code).toBe("setup_required");
    expect(getValidator("ErrorBody")(gated.json())).toBe(true);

    const gatedMutation = await world.app.inject({
      method: "POST",
      url: "/api/invitations",
      headers: { "content-type": "application/json", ...(await anonCsrf(world.app)) },
      payload: { email: "x@example.test", role: "operator" },
    });
    expect(gatedMutation.statusCode).toBe(503);
    expect(gatedMutation.json().code).toBe("setup_required");

    // Health, version, setup, and the auth ceremony are never gated.
    const health = await world.app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    const version = await world.app.inject({ method: "GET", url: "/api/system/version" });
    expect(version.statusCode).toBe(200);
    const setupState = await world.app.inject({ method: "GET", url: "/api/system/setup" });
    expect(setupState.statusCode).toBe(200);
    expect(setupState.json()).toEqual({
      bootstrapped: false,
      rightsHolderConfigured: false,
      administratorCount: 0,
    });
    const csrf = await world.app.inject({ method: "GET", url: "/api/auth/csrf" });
    expect(csrf.statusCode).toBe(200);
    const signIn = await world.app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: { "content-type": "application/json", ...(await anonCsrf(world.app)) },
      payload: { email: "nobody@example.test", password: "whatever-long" },
    });
    // Not gated: an unknown account answers invalid_credentials, not 503.
    expect(signIn.statusCode).toBe(401);
    expect(signIn.json().code).toBe("invalid_credentials");
  });

  it("bootstraps once, prints the one-time token, and refuses the second run", async () => {
    const first = await cli([
      "bootstrap",
      "--legal-name",
      "Example Rights GmbH",
      "--country",
      "DE",
      "--admin-email",
      "founder@example.test",
    ]);
    expect(first.code).toBe(0);
    const token = first.out.find(
      (line) => line.length > 40 && /^[A-Za-z0-9_-]+$/.test(line),
    );
    expect(token).toBeDefined();
    expect(first.out).toContain(t("en", "cli.bootstrap.tokenHeading"));
    founderSetupToken = token!;

    const rightsHolder = await world.pool.query(
      "select legal_name, country from rights_holder",
    );
    expect(rightsHolder.rows).toEqual([
      { legal_name: "Example Rights GmbH", country: "DE" },
    ]);
    const invitation = await world.pool.query(
      "select email, role, accepted_at, revoked_at from invitations",
    );
    expect(invitation.rows).toEqual([
      { email: "founder@example.test", role: "administrator", accepted_at: null, revoked_at: null },
    ]);

    const second = await cli([
      "bootstrap",
      "--legal-name",
      "Another Entity",
      "--country",
      "FR",
      "--admin-email",
      "other@example.test",
    ]);
    expect(second.code).toBe(1);
    expect(second.err).toContain(t("en", "cli.bootstrap.refused"));
    // No second rights holder and no second invitation appeared.
    const after = await world.pool.query("select count(*)::int as n from rights_holder");
    expect(after.rows[0].n).toBe(1);
    const invitations = await world.pool.query("select count(*)::int as n from invitations");
    expect(invitations.rows[0].n).toBe(1);

    // The rights holder exists but the invited administrator's account does
    // not: gating holds until the ceremony creates an administrator row.
    const operators = await world.app.inject({ method: "GET", url: "/api/operators" });
    expect(operators.statusCode).toBe(503);
    expect(operators.json().code).toBe("setup_required");
    const state = await world.app.inject({ method: "GET", url: "/api/system/setup" });
    expect(state.json()).toEqual({
      bootstrapped: false,
      rightsHolderConfigured: true,
      administratorCount: 0,
    });
  });

  it("recovers the last administrator through the CLI reset token", async () => {
    // Complete the founder's enrolment so a real administrator exists.
    const enrolled = await enrollOperator(world, founderSetupToken, "founder@example.test");
    expect(enrolled.recoveryCodes).toHaveLength(10);
    const before = await world.pool.query(
      "select state, password_hash is not null as has_password, totp_secret is not null as has_totp from operators where email = 'founder@example.test'",
    );
    expect(before.rows[0]).toEqual({ state: "active", has_password: true, has_totp: true });

    // The admin recover path mints a reset token for the locked-out founder.
    const recover = await cli(["admin", "recover", "--email", "founder@example.test"]);
    expect(recover.code).toBe(0);
    const resetToken = recover.out.find(
      (line) => line.length > 40 && /^[A-Za-z0-9_-]+$/.test(line),
    );
    expect(resetToken).toBeDefined();

    const resetState = await world.pool.query(
      "select state, password_hash, totp_secret from operators where email = 'founder@example.test'",
    );
    expect(resetState.rows[0].state).toBe("invited");
    expect(resetState.rows[0].password_hash).toBeNull();
    expect(resetState.rows[0].totp_secret).toBeNull();

    // The reset token drives the setup ceremony again, end to end.
    const reenrolled = await enrollOperator(world, resetToken!, "founder@example.test");
    expect(reenrolled.recoveryCodes).toHaveLength(10);
    founder = reenrolled;

    // With an administrator account in place, gating lifts.
    const ungated = await world.app.inject({ method: "GET", url: "/api/operators" });
    expect(ungated.statusCode).toBe(401);
    expect(ungated.json().code).toBe("unauthenticated");
    const state = await world.app.inject({ method: "GET", url: "/api/system/setup" });
    expect(state.json()).toEqual({
      bootstrapped: true,
      rightsHolderConfigured: true,
      administratorCount: 1,
    });
  });

  it("refuses to demote or disable the only administrator", async () => {
    const admin = founder;
    const solo = await world.pool.query<{ id: string }>(
      "select id from operators where email = 'founder@example.test'",
    );
    const id = solo.rows[0].id;

    const demote = await world.app.inject({
      method: "PATCH",
      url: `/api/operators/${id}`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { role: "operator" },
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().code).toBe("last_administrator");

    const disable = await world.app.inject({
      method: "PATCH",
      url: `/api/operators/${id}`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { state: "disabled" },
    });
    expect(disable.statusCode).toBe(409);
    expect(disable.json().code).toBe("last_administrator");

    // A second administrator unblocks both.
    const invite = await world.app.inject({
      method: "POST",
      url: "/api/invitations",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { email: "second@example.test", role: "administrator" },
    });
    expect(invite.statusCode).toBe(201);
    const mailToken = extractToken(world.mail.sentTo("second@example.test")[0]?.body ?? "");
    const second = await enrollOperator(world, mailToken, "second@example.test");

    // With another active administrator standing, host-level recovery is
    // refused: the ordinary credential-reset route covers that case.
    const recoverRefused = await cli(["admin", "recover", "--email", "second@example.test"]);
    expect(recoverRefused.code).toBe(1);
    expect(recoverRefused.err).toContain(t("en", "cli.adminRecover.notLastAdministrator"));
    const stillActive = await world.pool.query(
      "select state from operators where email = 'second@example.test'",
    );
    expect(stillActive.rows[0].state).toBe("active");

    const demoteNow = await world.app.inject({
      method: "PATCH",
      url: `/api/operators/${id}`,
      headers: { "content-type": "application/json", ...authHeaders(second) },
      payload: { role: "operator" },
    });
    expect(demoteNow.statusCode).toBe(200);
    expect(demoteNow.json().role).toBe("operator");
    // The solo administrator's own session was revoked by the role change.
    const after = await world.app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: admin.cookie },
    });
    expect(after.statusCode).toBe(401);
  });
});

function extractToken(mailBody: string): string {
  const match = /token=([A-Za-z0-9_-]+)/.exec(mailBody);
  if (!match) {
    throw new Error(`invitation email carries no token: ${mailBody}`);
  }
  return match[1];
}
