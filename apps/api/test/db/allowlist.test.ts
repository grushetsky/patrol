import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authHeaders,
  ceremonyApp,
  signedInAdministrator,
  type CeremonyApp,
  type SignedInOperator,
} from "./ceremony.js";

/**
 * Seam 5 (GLOSSARY invariants, contract checks): a licensed destination
 * needs a territory; a scope target that does not match the scope is
 * refused; a rights-holder official domain entry is created; removal
 * works; the list filters by kind, scope, and territory.
 */
describe("allowlist", () => {
  let world: CeremonyApp;
  let admin: SignedInOperator;
  let groupId: string;
  let titleId: string;

  beforeAll(async () => {
    world = await ceremonyApp();
    admin = await signedInAdministrator(world, "admin@example.test");
    const group = await world.app.inject({
      method: "POST",
      url: "/api/title-groups",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        name: "Allowlist group",
        locales: ["en"],
        scanTime: "05:00:00Z",
        priority: "high",
      },
    });
    groupId = group.json().id;
    const title = await world.app.inject({
      method: "POST",
      url: "/api/titles",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        titleGroupId: groupId,
        originalVariant: { text: "Allowlist Work", language: "en", script: "Latn" },
        releaseYear: 2000,
        titleType: "film",
        additionalVariants: [],
        externalIdentifiers: [],
        source: "rights_holder_record",
      },
    });
    titleId = title.json().title.id;
  });

  afterAll(async () => {
    await world.app.close();
    await world.pool.end();
  });

  function addEntry(payload: Record<string, unknown>) {
    return world.app.inject({
      method: "POST",
      url: "/api/settings/allowlist",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload,
    });
  }

  it("refuses a licensed destination without a territory", async () => {
    const refused = await addEntry({
      kind: "licensed_destination",
      matchKind: "host",
      value: "licensed-partner.example",
      scope: "rights_holder",
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe("unprocessable");
  });

  it("refuses a scope target that does not match the scope", async () => {
    const groupScopeWithTitle = await addEntry({
      kind: "official_domain",
      matchKind: "host",
      value: "scope-mismatch.example",
      scope: "title_group",
      trackedTitleId: titleId,
    });
    expect(groupScopeWithTitle.statusCode).toBe(422);

    const titleScopeWithGroup = await addEntry({
      kind: "official_domain",
      matchKind: "host",
      value: "scope-mismatch-2.example",
      scope: "tracked_title",
      titleGroupId: groupId,
    });
    expect(titleScopeWithGroup.statusCode).toBe(422);

    const holderScopeWithGroup = await addEntry({
      kind: "official_domain",
      matchKind: "host",
      value: "scope-mismatch-3.example",
      scope: "rights_holder",
      titleGroupId: groupId,
    });
    expect(holderScopeWithGroup.statusCode).toBe(422);

    const groupScopeWithoutTarget = await addEntry({
      kind: "official_domain",
      matchKind: "host",
      value: "scope-mismatch-4.example",
      scope: "title_group",
    });
    expect(groupScopeWithoutTarget.statusCode).toBe(422);
  });

  it("creates a rights-holder official domain entry, normalized for matching", async () => {
    const created = await addEntry({
      kind: "official_domain",
      matchKind: "host",
      value: "WWW.RightsHolder.Example",
      scope: "rights_holder",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().value).toBe("rightsholder.example");
    expect(created.json().scope).toBe("rights_holder");
    expect(created.json().origin).toBe("operator");
    expect(created.json().confirmedBy).toBe(admin.operatorId);
  });

  it("creates scoped and territorial entries that satisfy their checks", async () => {
    const licensed = await addEntry({
      kind: "licensed_destination",
      matchKind: "url_prefix",
      value: "https://partner.example/library/",
      scope: "rights_holder",
      territory: "DE",
    });
    expect(licensed.statusCode).toBe(201);
    // The prefix is stored as a normalized URL key prefix.
    expect(licensed.json().value).toBe("partner.example/library");
    expect(licensed.json().territory).toBe("DE");

    const groupScoped = await addEntry({
      kind: "neutral_source",
      matchKind: "host",
      value: "archive.example",
      scope: "title_group",
      titleGroupId: groupId,
    });
    expect(groupScoped.statusCode).toBe(201);
    expect(groupScoped.json().titleGroupId).toBe(groupId);

    const titleScoped = await addEntry({
      kind: "official_domain",
      matchKind: "host",
      value: "title-official.example",
      scope: "tracked_title",
      trackedTitleId: titleId,
    });
    expect(titleScoped.statusCode).toBe(201);
    expect(titleScoped.json().trackedTitleId).toBe(titleId);
  });

  it("lists entries filtered by kind, scope, and territory", async () => {
    const byKind = await world.app.inject({
      method: "GET",
      url: "/api/settings/allowlist?kind=licensed_destination",
      headers: { cookie: admin.cookie },
    });
    expect(byKind.statusCode).toBe(200);
    expect(
      byKind.json().items.every(
        (entry: { kind: string }) => entry.kind === "licensed_destination",
      ),
    ).toBe(true);
    expect(byKind.json().total).toBe(1);

    const byScope = await world.app.inject({
      method: "GET",
      url: "/api/settings/allowlist?scope=rights_holder",
      headers: { cookie: admin.cookie },
    });
    expect(
      byScope.json().items.every(
        (entry: { scope: string }) => entry.scope === "rights_holder",
      ),
    ).toBe(true);

    const byTerritory = await world.app.inject({
      method: "GET",
      url: "/api/settings/allowlist?territory=DE",
      headers: { cookie: admin.cookie },
    });
    expect(byTerritory.json().total).toBe(1);
    expect(byTerritory.json().items[0].territory).toBe("DE");
  });

  it("removes an entry and the removal is recorded", async () => {
    const created = await addEntry({
      kind: "neutral_source",
      matchKind: "host",
      value: "to-be-removed.example",
      scope: "rights_holder",
    });
    expect(created.statusCode).toBe(201);
    const entryId = created.json().id;

    const removed = await world.app.inject({
      method: "DELETE",
      url: `/api/settings/allowlist/${entryId}`,
      headers: authHeaders(admin),
    });
    expect(removed.statusCode).toBe(204);

    const gone = await world.app.inject({
      method: "DELETE",
      url: `/api/settings/allowlist/${entryId}`,
      headers: authHeaders(admin),
    });
    expect(gone.statusCode).toBe(404);

    const events = await world.pool.query(
      "select * from security_events where kind = 'allowlist_entry_removed'",
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].detail.entryId).toBe(entryId);
  });
});
