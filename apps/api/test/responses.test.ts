import { beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapAdmin,
  harness,
  mutate,
  read,
  type Harness,
} from "./support/harness.js";
import { GROUP, titleBody } from "./support/fixtures.js";

describe("contract-shaped responses", () => {
  let h: Harness;
  let session: string;

  beforeEach(async () => {
    h = await harness();
    session = (await bootstrapAdmin(h)).session;
  });

  function expectSchema(name: string, value: unknown) {
    const result = h.contract.validate(name, value);
    expect(result.issues).toEqual([]);
  }

  it("validates every catalogue response against the contract", async () => {
    const group = await mutate(h.app, session, "POST", "/api/title-groups", GROUP);
    expect(group.statusCode).toBe(201);
    expectSchema("TitleGroup", group.json());

    const created = await mutate(
      h.app,
      session,
      "POST",
      "/api/titles",
      titleBody(group.json().id, {
        originalVariant: { text: "The Movie", language: "en-US", script: "Latn" },
        releaseYear: 2000,
        additionalVariants: [
          {
            text: "Der Film",
            kind: "localized",
            language: "de-DE",
            script: "Latn",
            source: "operator_knowledge",
          },
        ],
        externalIdentifiers: [{ scheme: "wikidata", value: "Q100" }],
      }),
    );
    expect(created.statusCode).toBe(201);
    expectSchema("TrackedTitleDetail", created.json());

    const list = await read(h.app, session, "/api/titles");
    expectSchema("TrackedTitlePage", list.json());

    const detail = await read(h.app, session, `/api/titles/${created.json().title.id}`);
    expectSchema("TrackedTitleDetail", detail.json());

    const variant = await mutate(
      h.app,
      session,
      "POST",
      `/api/titles/${created.json().title.id}/variants`,
      {
        text: "Le Long Métrage",
        kind: "localized",
        language: "fr-FR",
        script: "Latn",
        source: "operator_knowledge",
      },
    );
    expectSchema("TitleVariantCreated", variant.json());

    const identifier = await mutate(
      h.app,
      session,
      "POST",
      `/api/titles/${created.json().title.id}/external-identifiers`,
      { scheme: "imdb", value: "tt0000001" },
    );
    expectSchema("ExternalIdentifier", identifier.json());

    const suggestions = await read(
      h.app,
      session,
      "/api/catalogue/suggestions?query=Film",
    );
    expectSchema("CatalogueSearchResult", suggestions.json());
  });

  it("validates every settings response against the contract", async () => {
    expectSchema(
      "RightsHolder",
      (await read(h.app, session, "/api/settings/rights-holder")).json(),
    );
    expectSchema(
      "BudgetOverview",
      (await read(h.app, session, "/api/settings/budget")).json(),
    );
    expectSchema(
      "CapacityProjection",
      (await read(h.app, session, "/api/settings/budget/capacity")).json(),
    );
    expectSchema(
      "RecipientProfilePage",
      (await read(h.app, session, "/api/settings/recipient-profiles")).json(),
    );

    const allowlist = await mutate(h.app, session, "POST", "/api/settings/allowlist", {
      kind: "neutral_source",
      matchKind: "host",
      value: "example.test",
      scope: "rights_holder",
    });
    expectSchema("AllowlistEntry", allowlist.json());
    expectSchema(
      "AllowlistEntryPage",
      (await read(h.app, session, "/api/settings/allowlist")).json(),
    );
  });
});
