import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authHeaders,
  ceremonyApp,
  inviteAndEnroll,
  signedInAdministrator,
  type CeremonyApp,
  type SignedInOperator,
} from "./ceremony.js";

/**
 * Seams 7, 8, 10, and 11: the settings surface. An administrator edits the
 * rights holder and signatory (an operator answers 403); the budget PUT
 * validates caps and the re-check share and no endpoint deletes ledger
 * rows; recipient-profile edits raise the version and the clearance has
 * its guard; an operator may write the catalogue but not the
 * administrator-only settings.
 */
describe("settings", () => {
  let world: CeremonyApp;
  let admin: SignedInOperator;
  let operator: SignedInOperator;

  beforeAll(async () => {
    world = await ceremonyApp();
    admin = await signedInAdministrator(world, "admin@example.test");
    operator = await inviteAndEnroll(world, admin, "operator@example.test");
  });

  afterAll(async () => {
    await world.app.close();
    await world.pool.end();
  });

  // -----------------------------------------------------------------
  // Seam 7: rights holder and signatory.

  it("lets an administrator persist the rights holder and signatory", async () => {
    const patched = await world.app.inject({
      method: "PATCH",
      url: "/api/settings/rights-holder",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        legalName: "Example Rights GmbH",
        country: "DE",
        address: {
          line1: "Musterstraße 1",
          city: "Berlin",
          postalCode: "10115",
          country: "DE",
        },
        roleMailbox: "legal@example.test",
        signatory: {
          fullLegalName: "Erika Muster",
          authorityBasis: "General counsel",
          contactEmail: "erika@example.test",
        },
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().signatory).toEqual({
      fullLegalName: "Erika Muster",
      authorityBasis: "General counsel",
      contactEmail: "erika@example.test",
    });
    expect(patched.json().address.city).toBe("Berlin");

    const read = await world.app.inject({
      method: "GET",
      url: "/api/settings/rights-holder",
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().signatory.contactEmail).toBe("erika@example.test");
    expect(read.json().acquisitionBudget.engineCaps).toEqual([
      { engine: "google", currency: "usd", monthlyCapMinor: 4800 },
      { engine: "bing", currency: "usd", monthlyCapMinor: 0 },
      { engine: "yandex", currency: "usd", monthlyCapMinor: 1200 },
    ]);
    expect(read.json().acquisitionBudget.recheckSharePercent).toBe(30);
  });

  it("refuses a rights-holder write from an operator", async () => {
    const refused = await world.app.inject({
      method: "PATCH",
      url: "/api/settings/rights-holder",
      headers: { "content-type": "application/json", ...authHeaders(operator) },
      payload: { legalName: "Overreach GmbH" },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("forbidden");
  });

  // -----------------------------------------------------------------
  // Seam 11: the role split across the slice's routes.

  it("lets an operator write the catalogue and the allowlist", async () => {
    const group = await world.app.inject({
      method: "POST",
      url: "/api/title-groups",
      headers: { "content-type": "application/json", ...authHeaders(operator) },
      payload: {
        name: "Operator group",
        locales: ["en"],
        scanTime: "02:10:00Z",
        priority: "low",
      },
    });
    expect(group.statusCode).toBe(201);
    const title = await world.app.inject({
      method: "POST",
      url: "/api/titles",
      headers: { "content-type": "application/json", ...authHeaders(operator) },
      payload: {
        titleGroupId: group.json().id,
        originalVariant: { text: "Operator Entry", language: "en", script: "Latn" },
        releaseYear: 2010,
        titleType: "film",
        additionalVariants: [],
        externalIdentifiers: [],
        source: "operator_knowledge",
      },
    });
    expect(title.statusCode).toBe(201);
    const entry = await world.app.inject({
      method: "POST",
      url: "/api/settings/allowlist",
      headers: { "content-type": "application/json", ...authHeaders(operator) },
      payload: {
        kind: "neutral_source",
        matchKind: "host",
        value: "operator-allowed.example",
        scope: "rights_holder",
      },
    });
    expect(entry.statusCode).toBe(201);
  });

  it("refuses the administrator-only settings writes from an operator", async () => {
    const budget = await world.app.inject({
      method: "PUT",
      url: "/api/settings/budget",
      headers: { "content-type": "application/json", ...authHeaders(operator) },
      payload: {
        engineCaps: [
          { engine: "google", currency: "usd", monthlyCapMinor: 4800 },
          { engine: "bing", currency: "usd", monthlyCapMinor: 0 },
          { engine: "yandex", currency: "usd", monthlyCapMinor: 1200 },
        ],
        recheckSharePercent: 30,
      },
    });
    expect(budget.statusCode).toBe(403);

    const profiles = await world.app.inject({
      method: "GET",
      url: "/api/settings/recipient-profiles",
      headers: { cookie: operator.cookie },
    });
    expect(profiles.statusCode).toBe(200);
    const profileId = profiles.json().items[0].id;
    const patch = await world.app.inject({
      method: "PATCH",
      url: `/api/settings/recipient-profiles/${profileId}`,
      headers: { "content-type": "application/json", ...authHeaders(operator) },
      payload: { account: "operator@example.test" },
    });
    expect(patch.statusCode).toBe(403);
    const clearance = await world.app.inject({
      method: "POST",
      url: `/api/settings/recipient-profiles/${profileId}/clearance`,
      headers: { "content-type": "application/json", ...authHeaders(operator) },
      payload: { reason: "should be refused" },
    });
    expect(clearance.statusCode).toBe(403);
  });

  // -----------------------------------------------------------------
  // Seam 8: the budget.

  it("sets the budget and validates caps and the re-check share", async () => {
    const set = await world.app.inject({
      method: "PUT",
      url: "/api/settings/budget",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        engineCaps: [
          { engine: "google", currency: "usd", monthlyCapMinor: 2400 },
          { engine: "bing", currency: "usd", monthlyCapMinor: 0 },
          { engine: "yandex", currency: "usd", monthlyCapMinor: 600 },
        ],
        recheckSharePercent: 40,
      },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().budget.recheckSharePercent).toBe(40);
    // The derived allowance follows the new cap: $24 buys 40,000 units,
    // which at depth-20 billing is 20,000 queries, split 60/40.
    const google = set.json().engines.find(
      (engine: { engine: string }) => engine.engine === "google",
    );
    expect(google).toMatchObject({
      monthlyCapMinor: 2400,
      allowanceUnits: 40_000,
      scanShareUnits: 24_000,
      recheckShareUnits: 16_000,
    });

    const negativeCap = await world.app.inject({
      method: "PUT",
      url: "/api/settings/budget",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        engineCaps: [
          { engine: "google", currency: "usd", monthlyCapMinor: -1 },
          { engine: "bing", currency: "usd", monthlyCapMinor: 0 },
          { engine: "yandex", currency: "usd", monthlyCapMinor: 600 },
        ],
        recheckSharePercent: 30,
      },
    });
    expect(negativeCap.statusCode).toBe(400);

    const shareOverflow = await world.app.inject({
      method: "PUT",
      url: "/api/settings/budget",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        engineCaps: [
          { engine: "google", currency: "usd", monthlyCapMinor: 2400 },
          { engine: "bing", currency: "usd", monthlyCapMinor: 0 },
          { engine: "yandex", currency: "usd", monthlyCapMinor: 600 },
        ],
        recheckSharePercent: 101,
      },
    });
    expect(shareOverflow.statusCode).toBe(400);

    // No endpoint deletes a ledger row: the budget surface exposes no
    // delete verb at all.
    const deleteAttempt = await world.app.inject({
      method: "DELETE",
      url: "/api/settings/budget",
      headers: authHeaders(admin),
    });
    expect(deleteAttempt.statusCode).toBe(404);
  });

  it("projects capacity from the worked envelope", async () => {
    // Restore the design-point envelope first.
    const restore = await world.app.inject({
      method: "PUT",
      url: "/api/settings/budget",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        engineCaps: [
          { engine: "google", currency: "usd", monthlyCapMinor: 4800 },
          { engine: "bing", currency: "usd", monthlyCapMinor: 0 },
          { engine: "yandex", currency: "usd", monthlyCapMinor: 1200 },
        ],
        recheckSharePercent: 30,
      },
    });
    expect(restore.statusCode).toBe(200);

    const capacity = await world.app.inject({
      method: "GET",
      url: "/api/settings/budget/capacity?locales=2&cadence=daily",
      headers: { cookie: admin.cookie },
    });
    expect(capacity.statusCode).toBe(200);
    const body = capacity.json();
    expect(body.queriesPerTitlePerScan).toBe(6);
    expect(body.supportedTitles).toBe(150);
    expect(body.trackedTitles).toBeGreaterThan(0);
    expect(body.shortfallTitles).toBe(0);

    const badLocales = await world.app.inject({
      method: "GET",
      url: "/api/settings/budget/capacity?locales=0",
      headers: { cookie: admin.cookie },
    });
    expect(badLocales.statusCode).toBe(400);
  });

  // -----------------------------------------------------------------
  // Seam 10: recipient profiles.

  it("raises the version on each profile edit and updates eligibility", async () => {
    const before = await world.app.inject({
      method: "GET",
      url: "/api/settings/recipient-profiles",
      headers: { cookie: admin.cookie },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().total).toBe(3);
    const yandex = before.json().items.find(
      (profile: { recipient: string }) => profile.recipient === "yandex",
    );
    expect(yandex.version).toBe(1);

    const edited = await world.app.inject({
      method: "PATCH",
      url: `/api/settings/recipient-profiles/${yandex.id}`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { eligibleTerritories: ["US", "DE", "CH"] },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().version).toBe(2);
    expect(edited.json().eligibleTerritories).toEqual(["US", "DE", "CH"]);

    const again = await world.app.inject({
      method: "PATCH",
      url: `/api/settings/recipient-profiles/${yandex.id}`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { account: "notices@example.test" },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().version).toBe(3);
    expect(again.json().account).toBe("notices@example.test");
  });

  it("clears a paused profile with a recorded reason, and refuses repeats", async () => {
    const profiles = await world.app.inject({
      method: "GET",
      url: "/api/settings/recipient-profiles",
      headers: { cookie: admin.cookie },
    });
    const google = profiles.json().items.find(
      (profile: { recipient: string }) => profile.recipient === "google",
    );

    // An unpaused profile has nothing to clear.
    const premature = await world.app.inject({
      method: "POST",
      url: `/api/settings/recipient-profiles/${google.id}/clearance`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "nothing to clear" },
    });
    expect(premature.statusCode).toBe(409);
    expect(premature.json().code).toBe("state_conflict");

    // The rejection threshold's pause (slice 6/7 maintains the counters;
    // the state itself is what the clearance guards).
    await world.pool.query("update recipient_profiles set paused = true, pause_reason = 'threshold' where id = $1", [
      google.id,
    ]);

    const cleared = await world.app.inject({
      method: "POST",
      url: `/api/settings/recipient-profiles/${google.id}/clearance`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "False rejections reviewed" },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().paused).toBe(false);
    expect(cleared.json().version).toBe(google.version + 1);

    const row = await world.pool.query<{
      cleared_reason: string;
      cleared_by: string;
    }>(
      "select cleared_reason, cleared_by from recipient_profiles where id = $1",
      [google.id],
    );
    expect(row.rows[0].cleared_reason).toBe("False rejections reviewed");
    expect(row.rows[0].cleared_by).toBe(admin.operatorId);

    const repeat = await world.app.inject({
      method: "POST",
      url: `/api/settings/recipient-profiles/${google.id}/clearance`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "again" },
    });
    expect(repeat.statusCode).toBe(409);
  });
});
