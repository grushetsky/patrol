import { beforeEach, describe, expect, it } from "vitest";
import {
  addOperator,
  bootstrapAdmin,
  harness,
  mutate,
  read,
  type Harness,
} from "./support/harness.js";
import { GROUP, titleBody } from "./support/fixtures.js";

describe("settings", () => {
  let h: Harness;
  let session: string;
  let adminId: string;

  beforeEach(async () => {
    h = await harness();
    const admin = await bootstrapAdmin(h);
    session = admin.session;
    adminId = admin.operator.id;
  });

  it("reads the rights holder with default budget settings", async () => {
    const response = await read(h.app, session, "/api/settings/rights-holder");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      legalName: "Example Rights Holder",
      country: "US",
      address: {
        line1: "1 Example Street",
        city: "",
        postalCode: "",
        country: "US",
      },
      roleMailbox: "legal@example.test",
      signatory: {
        fullLegalName: "",
        authorityBasis: "",
        contactEmail: "legal@example.test",
      },
      acquisitionBudget: {
        recheckSharePercent: 30,
        engineCaps: [
          { engine: "google", currency: "usd", monthlyCapMinor: 4_800 },
          { engine: "bing", currency: "usd", monthlyCapMinor: 0 },
          { engine: "yandex", currency: "usd", monthlyCapMinor: 1_200 },
        ],
      },
    });
  });

  it("lets an administrator update the rights holder and signatory", async () => {
    const response = await mutate(h.app, session, "PATCH", "/api/settings/rights-holder", {
      legalName: "Example Rights Holder B.V.",
      country: "NL",
      address: {
        line1: "Keizersgracht 1",
        city: "Amsterdam",
        postalCode: "1015 CD",
        country: "NL",
      },
      phone: "+31 20 000 0000",
      signatory: {
        fullLegalName: "Ada Example",
        authorityBasis: "Director",
        contactEmail: "ada@example.test",
        contactPhone: "+31 20 000 0001",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      legalName: "Example Rights Holder B.V.",
      country: "NL",
      address: {
        line1: "Keizersgracht 1",
        city: "Amsterdam",
        postalCode: "1015 CD",
        country: "NL",
      },
      signatory: {
        fullLegalName: "Ada Example",
        authorityBasis: "Director",
        contactEmail: "ada@example.test",
      },
    });
  });

  it("refuses rights-holder and budget writes from an operator", async () => {
    const operator = await addOperator(h.auth, adminId, "operator@example.test", "operator");

    const rights = await mutate(
      h.app,
      operator.session,
      "PATCH",
      "/api/settings/rights-holder",
      { legalName: "Nope" },
    );
    expect(rights.statusCode).toBe(403);

    const budget = await mutate(h.app, operator.session, "PUT", "/api/settings/budget", {
      engineCaps: [
        { engine: "google", currency: "usd", monthlyCapMinor: 4_800 },
        { engine: "bing", currency: "usd", monthlyCapMinor: 0 },
        { engine: "yandex", currency: "usd", monthlyCapMinor: 1_200 },
      ],
      recheckSharePercent: 30,
    });
    expect(budget.statusCode).toBe(403);
  });

  it("derives the allowance and the 70/30 split from each engine cap", async () => {
    const response = await read(h.app, session, "/api/settings/budget");

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ledger).toHaveLength(3);
    expect(body.alerts).toEqual([]);
    expect(body.engines).toEqual([
      expect.objectContaining({
        engine: "google",
        allowanceUnits: 80_000,
        scanShareUnits: 56_000,
        recheckShareUnits: 24_000,
        scanUsedUnits: 0,
        recheckUsedUnits: 0,
        exhausted: false,
        routeDisabled: false,
      }),
      expect.objectContaining({
        engine: "bing",
        allowanceUnits: 0,
        scanShareUnits: 0,
        recheckShareUnits: 0,
      }),
      expect.objectContaining({
        engine: "yandex",
        allowanceUnits: 48_000,
        scanShareUnits: 33_600,
        recheckShareUnits: 14_400,
      }),
    ]);
  });

  it("reports a disabled route and the month's alerts", async () => {
    await h.db.query(
      `INSERT INTO engine_route
        (engine, disabled_at, disabled_reason, last_probe_at, updated_at)
       VALUES ('yandex', $1, 'revoked key', NULL, $1)`,
      [new Date()],
    );
    const today = new Date();
    const monthStart = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-01`;
    await h.db.query(
      `INSERT INTO budget_alert
        (id, engine, bucket, threshold, level, percent_used, message,
         groups_not_scanned, month_start, created_at)
       VALUES ('alert-1', 'google', 'scan', '90', 'critical', 90,
               'Google scan share is at 90%.', 1, $2, $1)`,
      [today, monthStart],
    );

    const response = await read(h.app, session, "/api/settings/budget");

    expect(response.statusCode).toBe(200);
    expect(
      response.json().engines.find(
        (engine: { engine: string }) => engine.engine === "yandex",
      ).routeDisabled,
    ).toBe(true);
    expect(response.json().alerts).toEqual([
      {
        engine: "google",
        bucket: "scan",
        level: "critical",
        percentUsed: 90,
        message: "Google scan share is at 90%.",
        groupsNotScanned: 1,
      },
    ]);
  });

  it("updates the caps and the re-check share without un-spending committed units", async () => {
    const now = new Date();
    const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    await h.db.query(
      `INSERT INTO quota_ledger
        (id, engine, month_start, allowance_units, scan_reserved, scan_committed,
         recheck_reserved, recheck_committed)
       VALUES ('ledger-google', 'google', $1, 80000, 0, 10, 0, 0)`,
      [monthStart],
    );

    const updated = await mutate(h.app, session, "PUT", "/api/settings/budget", {
      engineCaps: [
        { engine: "google", currency: "usd", monthlyCapMinor: 6_000 },
        { engine: "bing", currency: "usd", monthlyCapMinor: 0 },
        { engine: "yandex", currency: "usd", monthlyCapMinor: 2_400 },
      ],
      recheckSharePercent: 25,
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().budget.recheckSharePercent).toBe(25);
    expect(updated.json().engines[0]).toMatchObject({
      engine: "google",
      monthlyCapMinor: 6_000,
      allowanceUnits: 100_000,
      scanShareUnits: 75_000,
      recheckShareUnits: 25_000,
      scanUsedUnits: 10,
    });
    expect(updated.json().engines[2]).toMatchObject({
      engine: "yandex",
      allowanceUnits: 96_000,
      scanShareUnits: 72_000,
      recheckShareUnits: 24_000,
    });
  });

  it("projects capacity for the current tracked catalogue", async () => {
    const title = async (index: number) =>
      h.db.query(
        `INSERT INTO tracked_title
          (id, title_group_id, release_year, title_type, runtime_minutes,
           original_variant_id, paused, merged_into_title_id, source,
           entered_by, entered_at, updated_by, created_at, updated_at)
         VALUES ($1, 'group', 2000, 'film', NULL, NULL, false, NULL,
                 'operator_knowledge', $2, $3, $2, $3, $3)`,
        [`title-${index}`, adminId, new Date()],
      );
    for (let index = 0; index < 120; index += 1) {
      await title(index);
    }

    const response = await read(
      h.app,
      session,
      "/api/settings/budget/capacity?locales=3&cadence=every_other_day",
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      localesPerTitle: 3,
      cadence: "every_other_day",
      queriesPerTitlePerScan: 9,
      supportedTitles: 207,
      trackedTitles: 120,
      shortfallTitles: 0,
    });
  });

  it("validates the capacity query", async () => {
    const locales = await read(
      h.app,
      session,
      "/api/settings/budget/capacity?locales=4",
    );
    expect(locales.statusCode).toBe(400);

    const cadence = await read(
      h.app,
      session,
      "/api/settings/budget/capacity?cadence=hourly",
    );
    expect(cadence.statusCode).toBe(400);
  });

  it("validates allowlist scope and territory", async () => {
    const created = await mutate(h.app, session, "POST", "/api/title-groups", GROUP);
    const groupId = created.json().id;

    const licensed = await mutate(h.app, session, "POST", "/api/settings/allowlist", {
      kind: "licensed_destination",
      matchKind: "host",
      value: "example.test",
      scope: "rights_holder",
    });
    expect(licensed.statusCode).toBe(422);
    expect(licensed.json().fieldErrors[0].path).toBe("/territory");

    const wrongScope = await mutate(h.app, session, "POST", "/api/settings/allowlist", {
      kind: "official_domain",
      matchKind: "host",
      value: "example.test",
      scope: "title_group",
      trackedTitleId: "00000000-0000-7000-8000-000000000000",
    });
    expect(wrongScope.statusCode).toBe(422);
    expect(wrongScope.json().fieldErrors[0].path).toBe("/titleGroupId");

    const createdEntry = await mutate(h.app, session, "POST", "/api/settings/allowlist", {
      kind: "official_domain",
      matchKind: "host",
      value: "EXAMPLE.test",
      scope: "title_group",
      titleGroupId: groupId,
      territory: "US",
    });
    expect(createdEntry.statusCode).toBe(201);
    expect(createdEntry.json()).toMatchObject({
      scope: "title_group",
      titleGroupId: groupId,
      origin: "operator",
      confirmedBy: adminId,
    });
    expect(createdEntry.json().value).toBe("example.test");
    expect(createdEntry.json().territory).toBeUndefined();

    const list = await read(
      h.app,
      session,
      "/api/settings/allowlist?scope=title_group",
    );
    expect(list.json().total).toBe(1);

    const title = await mutate(
      h.app,
      session,
      "POST",
      "/api/titles",
      titleBody(groupId),
    );
    expect(title.statusCode).toBe(201);
    const withEntry = await read(
      h.app,
      session,
      `/api/titles/${title.json().title.id}`,
    );
    expect(withEntry.json().allowlistEntries).toHaveLength(1);

    const removed = await mutate(
      h.app,
      session,
      "DELETE",
      `/api/settings/allowlist/${createdEntry.json().id}`,
    );
    expect(removed.statusCode).toBe(204);

    const afterRemoval = await read(h.app, session, "/api/settings/allowlist");
    expect(afterRemoval.json().total).toBe(0);
    const titleAfterRemoval = await read(
      h.app,
      session,
      `/api/titles/${title.json().title.id}`,
    );
    expect(titleAfterRemoval.json().allowlistEntries).toEqual([]);
    expect(titleAfterRemoval.json().counts.allowlistEntries).toBe(0);
    const removal = await h.db.query(
      "SELECT removed_by FROM allowlist_entry WHERE id = $1",
      [createdEntry.json().id],
    );
    expect(removal.rows[0].removed_by).toBe(adminId);
  });

  it("does not create ledger rows on a read", async () => {
    const response = await read(h.app, session, "/api/settings/budget");
    expect(response.statusCode).toBe(200);
    expect(response.json().ledger).toHaveLength(3);

    const stored = await h.db.query("SELECT count(*) AS count FROM quota_ledger");
    expect(Number(stored.rows[0].count)).toBe(0);
  });

  it("does not persist an invalid budget write", async () => {
    const rejected = await mutate(h.app, session, "PUT", "/api/settings/budget", {
      engineCaps: [
        { engine: "google", currency: "usd", monthlyCapMinor: 9_999 },
      ],
      recheckSharePercent: 30,
    });
    expect(rejected.statusCode).toBe(422);

    const readBack = await read(h.app, session, "/api/settings/budget");
    expect(
      readBack.json().budget.engineCaps.find(
        (cap: { engine: string }) => cap.engine === "google",
      ).monthlyCapMinor,
    ).toBe(4_800);
  });

  it("lists the three recipient profiles and raises the version on each edit", async () => {
    const list = await read(h.app, session, "/api/settings/recipient-profiles");
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((item: { recipient: string }) => item.recipient)).toEqual([
      "bing",
      "google",
      "yandex",
    ]);
    const google = list.json().items.find(
      (item: { recipient: string }) => item.recipient === "google",
    );
    expect(google).toMatchObject({
      version: 1,
      paused: false,
      recentSubmissions: { windowSize: 0, rejected: 0, failed: 0 },
      maxUrlsPerNotice: 500,
    });

    const first = await mutate(
      h.app,
      session,
      "PATCH",
      `/api/settings/recipient-profiles/${google.id}`,
      { account: "legal@example.test" },
    );
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ version: 2, account: "legal@example.test" });

    const second = await mutate(
      h.app,
      session,
      "PATCH",
      `/api/settings/recipient-profiles/${google.id}`,
      { windowTime: "08:30" },
    );
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ version: 3, windowTime: "08:30:00" });
  });

  it("refuses a profile edit from an operator", async () => {
    const operator = await addOperator(h.auth, adminId, "operator@example.test", "operator");
    const list = await read(h.app, session, "/api/settings/recipient-profiles");
    const profile = list.json().items[0];

    const response = await mutate(
      h.app,
      operator.session,
      "PATCH",
      `/api/settings/recipient-profiles/${profile.id}`,
      { account: "operator@example.test" },
    );
    expect(response.statusCode).toBe(403);
  });

  it("clears a pause but refuses while the last twenty submissions exceed the threshold", async () => {
    const list = await read(h.app, session, "/api/settings/recipient-profiles");
    const profile = list.json().items[0];
    await h.db.query(
      "UPDATE recipient_profile SET paused = true, pause_reason = 'Rejections' WHERE id = $1",
      [profile.id],
    );

    const cleared = await mutate(
      h.app,
      session,
      "POST",
      `/api/settings/recipient-profiles/${profile.id}/clearance`,
      { reason: "Corrected the cause" },
    );
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ paused: false, version: 2 });
    const clearance = await h.db.query(
      "SELECT cleared_by, clearance_reason FROM recipient_profile WHERE id = $1",
      [profile.id],
    );
    expect(clearance.rows[0]).toMatchObject({
      cleared_by: adminId,
      clearance_reason: "Corrected the cause",
    });

    for (let index = 0; index < 20; index += 1) {
      await h.db.query(
        "INSERT INTO submission (id, recipient_profile_id, state, created_at) VALUES ($1, $2, 'rejected', $3)",
        [`submission-${index}`, profile.id, new Date(Date.now() + index)],
      );
    }
    const refused = await mutate(
      h.app,
      session,
      "POST",
      `/api/settings/recipient-profiles/${profile.id}/clearance`,
      { reason: "Try again" },
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("state_conflict");
  });

  it("gates domain reads behind bootstrap", async () => {
    const fresh = await harness();

    const response = await read(fresh.app, "unused", "/api/settings/rights-holder");
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("setup_required");

    const catalogue = await read(fresh.app, "unused", "/api/title-groups");
    expect(catalogue.statusCode).toBe(503);
  });
});
