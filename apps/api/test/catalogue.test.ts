import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import {
  bootstrapAdmin,
  harness,
  mutate,
  read,
  type Harness,
} from "./support/harness.js";
import { GROUP, titleBody } from "./support/fixtures.js";

async function group(h: Harness, session: string) {
  const response = await mutate(h.app, session, "POST", "/api/title-groups", GROUP);
  expect(response.statusCode).toBe(201);
  return response.json();
}

describe("catalogue", () => {
  let h: Harness;
  let session: string;

  beforeEach(async () => {
    h = await harness();
    session = (await bootstrapAdmin(h)).session;
  });

  it("creates a title group and reads it back with a normalized scan time", async () => {
    const created = await group(h, session);

    expect(created.name).toBe(GROUP.name);
    expect(created.scanTime).toBe("03:15:00");
    expect(created.locales).toEqual(["ru-RU"]);

    const single = await read(h.app, session, `/api/title-groups/${created.id}`);
    expect(single.statusCode).toBe(200);
    expect(single.json().id).toBe(created.id);

    const list = await read(h.app, session, "/api/title-groups");
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ total: 1, page: 1, pageSize: 50 });
    expect(list.json().items).toHaveLength(1);
  });

  it("refuses a title group without a locale", async () => {
    const response = await mutate(h.app, session, "POST", "/api/title-groups", {
      ...GROUP,
      locales: [],
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("validation_failed");
    expect(response.json().fieldErrors[0].path).toContain("locales");
  });

  it("creates a tracked title with its original variant, an alias, and provenance", async () => {
    const titleGroup = await group(h, session);

    const response = await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id, {
      additionalVariants: [
        {
          text: "The Irony of Fate",
          kind: "localized",
          language: "en-US",
          script: "Latn",
          source: "operator_knowledge",
        },
      ],
      externalIdentifiers: [{ scheme: "wikidata", value: "Q476622" }],
    }));

    expect(response.statusCode).toBe(201);
    const detail = response.json();
    expect(detail.displayTitle).toBe("Ирония судьбы");
    expect(detail.variants).toHaveLength(2);
    expect(detail.variants[0]).toMatchObject({
      kind: "original",
      text: "Ирония судьбы",
      normalizedText: "ironiya sudby",
    });
    expect(detail.title.originalVariantId).toBe(detail.variants[0].id);
    expect(detail.title.provenance.enteredBy).toBe(await adminId(h));
    expect(detail.externalIdentifiers).toEqual([
      expect.objectContaining({ scheme: "wikidata", value: "Q476622" }),
    ]);
    expect(detail.counts).toMatchObject({ variants: 2, externalIdentifiers: 1 });
  });

  it("blocks a second title carrying an existing external identifier", async () => {
    const titleGroup = await group(h, session);
    const first = await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id, {
      externalIdentifiers: [{ scheme: "imdb", value: "tt0073179" }],
    }));
    expect(first.statusCode).toBe(201);

    const second = await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id, {
      releaseYear: 2007,
      externalIdentifiers: [{ scheme: "imdb", value: "tt0073179" }],
    }));

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      code: "duplicate_title",
      existingTitleId: first.json().title.id,
    });
  });

  it("blocks an identical normalized title, year, and type without an identifier", async () => {
    const titleGroup = await group(h, session);
    const first = await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id));
    expect(first.statusCode).toBe(201);

    const duplicate = await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id, {
      originalVariant: {
        text: "  ирония   СУДЬБЫ!",
        language: "ru-RU",
        script: "Cyrl",
      },
    }));

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      code: "duplicate_title",
      existingTitleId: first.json().title.id,
    });
  });

  it("creates a same-named remake when the year differs", async () => {
    const titleGroup = await group(h, session);
    await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id));

    const remake = await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id, {
      releaseYear: 2007,
    }));

    expect(remake.statusCode).toBe(201);
  });

  it("refuses a variant whose normalized text repeats inside its title", async () => {
    const titleGroup = await group(h, session);

    const response = await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id, {
      additionalVariants: [
        {
          text: "ИРОНИЯ СУДЬБЫ",
          kind: "alternate",
          language: "ru-RU",
          script: "Cyrl",
          source: "operator_knowledge",
        },
      ],
    }));

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("duplicate_entity");
  });

  it("warns when a new variant resembles another title of the same year and type", async () => {
    const titleGroup = await group(h, session);
    const created = await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id));
    const other = await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id, {
      originalVariant: {
        text: "Служебный роман",
        language: "ru-RU",
        script: "Cyrl",
      },
    }));

    const response = await mutate(
      h.app,
      session,
      "POST",
      `/api/titles/${other.json().title.id}/variants`,
      {
        text: "  ИРОНИЯ СУДЬБЫ! ",
        kind: "alternate",
        language: "ru-RU",
        script: "Cyrl",
        source: "operator_knowledge",
      },
    );

    expect(response.statusCode).toBe(201);
    expect(response.json().variant.kind).toBe("alternate");
    expect(response.json().similarTitleId).toBe(created.json().title.id);
  });

  it("refuses a second original variant", async () => {
    const titleGroup = await group(h, session);
    const created = await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id));

    const createdWithOriginal = await mutate(
      h.app,
      session,
      "POST",
      "/api/titles",
      titleBody(titleGroup.id, {
        releaseYear: 2001,
        additionalVariants: [
          {
            text: "Другой фильм",
            kind: "original",
            language: "ru-RU",
            script: "Cyrl",
            source: "operator_knowledge",
          },
        ],
      }),
    );
    expect(createdWithOriginal.statusCode).toBe(422);
    expect(createdWithOriginal.json().fieldErrors[0].path).toBe(
      "/additionalVariants/0/kind",
    );

    const added = await mutate(
      h.app,
      session,
      "POST",
      `/api/titles/${created.json().title.id}/variants`,
      {
        text: "Ещё одно имя",
        kind: "original",
        language: "ru-RU",
        script: "Cyrl",
        source: "operator_knowledge",
      },
    );
    expect(added.statusCode).toBe(422);
    expect(added.json().fieldErrors[0].path).toBe("/kind");
  });

  it("refuses a duplicate variant on an existing title", async () => {
    const titleGroup = await group(h, session);
    const created = await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id));

    const response = await mutate(
      h.app,
      session,
      "POST",
      `/api/titles/${created.json().title.id}/variants`,
      {
        text: "ирония судьбы",
        kind: "alternate",
        language: "ru-RU",
        script: "Cyrl",
        source: "operator_knowledge",
      },
    );

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("duplicate_entity");
  });

  it("edits a group and pauses a title", async () => {
    const titleGroup = await group(h, session);
    const updatedGroup = await mutate(
      h.app,
      session,
      "PATCH",
      `/api/title-groups/${titleGroup.id}`,
      { name: "Renamed group", priority: "high" },
    );
    expect(updatedGroup.statusCode).toBe(200);
    expect(updatedGroup.json()).toMatchObject({
      name: "Renamed group",
      priority: "high",
      scanTime: "03:15:00",
    });

    const created = await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id));
    const paused = await mutate(
      h.app,
      session,
      "PATCH",
      `/api/titles/${created.json().title.id}`,
      { paused: true },
    );
    expect(paused.statusCode).toBe(200);
    expect(paused.json().title.paused).toBe(true);

    const list = await read(h.app, session, "/api/titles?paused=true");
    expect(list.json().total).toBe(1);

    const english = await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id, {
      originalVariant: { text: "The Movie", language: "en-US", script: "Latn" },
      releaseYear: 2002,
    }));
    expect(english.statusCode).toBe(201);
    const byArticlelessTitle = await read(
      h.app,
      session,
      "/api/titles?query=The+Movie",
    );
    expect(byArticlelessTitle.json().total).toBe(1);
  });

  it("removes a wrong external identifier", async () => {
    const titleGroup = await group(h, session);
    const created = await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id, {
      externalIdentifiers: [{ scheme: "kinopoisk", value: "81232" }],
    }));
    const identifierId = created.json().externalIdentifiers[0].id;

    const removed = await mutate(
      h.app,
      session,
      "DELETE",
      `/api/titles/${created.json().title.id}/external-identifiers/${identifierId}`,
    );
    expect(removed.statusCode).toBe(204);

    const detail = await read(h.app, session, `/api/titles/${created.json().title.id}`);
    expect(detail.json().externalIdentifiers).toEqual([]);
  });

  it("refuses malformed external identifiers", async () => {
    const titleGroup = await group(h, session);

    const response = await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id, {
      externalIdentifiers: [{ scheme: "imdb", value: "0073179" }],
    }));

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("validation_failed");

    const created = await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id));
    const added = await mutate(
      h.app,
      session,
      "POST",
      `/api/titles/${created.json().title.id}/external-identifiers`,
      { scheme: "imdb", value: "nope" },
    );
    expect(added.statusCode).toBe(422);
    expect(added.json().fieldErrors[0].path).toBe("/value");
  });

  it("merges a duplicate into the surviving title and archives it", async () => {
    const titleGroup = await group(h, session);
    const survivor = await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id));
    const duplicate = await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id, {
      releaseYear: 2007,
      externalIdentifiers: [{ scheme: "wikidata", value: "Q1" }],
    }));

    const merged = await mutate(
      h.app,
      session,
      "POST",
      `/api/titles/${duplicate.json().title.id}/merge`,
      { survivingTitleId: survivor.json().title.id },
    );

    expect(merged.statusCode).toBe(200);
    expect(merged.json().archivedTitle.mergedIntoTitleId).toBe(
      survivor.json().title.id,
    );
    expect(merged.json().movedIdentifierCount).toBe(1);
    expect(merged.json().survivingTitle.externalIdentifiers).toHaveLength(1);
    expect(merged.json().survivingTitle.variants).toHaveLength(1);
    expect(merged.json().survivingTitle.variants[0].kind).toBe("original");

    const archived = await read(
      h.app,
      session,
      `/api/titles/${duplicate.json().title.id}`,
    );
    expect(archived.statusCode).toBe(200);
    expect(archived.json().displayTitle).toBe("Ирония судьбы");
    expect(archived.json().variants[0].id).toBe(
      archived.json().title.originalVariantId,
    );
  });

  it("refuses a merge when the duplicate has a candidate", async () => {
    const titleGroup = await group(h, session);
    const survivor = await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id));
    const duplicate = await mutate(h.app, session, "POST", "/api/titles", titleBody(titleGroup.id, {
      releaseYear: 2007,
    }));
    await h.db.query(
      "INSERT INTO candidate (id, tracked_title_id, state) VALUES ($1, $2, 'pending')",
      ["candidate-1", duplicate.json().title.id],
    );

    const merged = await mutate(
      h.app,
      session,
      "POST",
      `/api/titles/${duplicate.json().title.id}/merge`,
      { survivingTitleId: survivor.json().title.id },
    );

    expect(merged.statusCode).toBe(409);
    expect(merged.json()).toMatchObject({
      code: "state_conflict",
      blockingTitleId: duplicate.json().title.id,
    });
  });
});

async function adminId(h: Harness) {
  const operators = await h.auth.listOperators();
  return operators.find((operator) => operator.role === "administrator")!.id;
}

describe("catalogue search", () => {
  it("searches local variants and always offers free-text creation", async () => {
    const h = await harness();
    const session = (await bootstrapAdmin(h)).session;
    const created = await mutate(h.app, session, "POST", "/api/title-groups", GROUP);
    await mutate(h.app, session, "POST", "/api/titles", titleBody(created.json().id));

    const response = await read(
      h.app,
      session,
      "/api/catalogue/suggestions?query=%D0%98%D1%80%D0%BE%D0%BD%D0%B8%D1%8F",
    );

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.createProposal).toBe("Ирония");
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({
      displayTitle: "Ирония судьбы",
      matchedVariant: { kind: "original", language: "ru-RU" },
    });
  });

  it("answers from the Wikidata proxy when it is reachable", async () => {
    const h = await harness({
      async search(query, locale) {
        return [
          {
            qid: "Q42",
            label: "Ирония судьбы",
            description: "1975 film",
            matchedAlias: query,
            matchedAliasLanguage: locale,
          },
        ];
      },
      async entity(qid) {
        return {
          qid,
          label: "Ирония судьбы",
          identifiers: [{ scheme: "imdb", value: "tt0073179", property: "P345" }],
        };
      },
    });
    const session = (await bootstrapAdmin(h)).session;

    const search = await read(
      h.app,
      session,
      "/api/catalogue/wikidata-suggestions?query=%D0%98%D1%80%D0%BE%D0%BD%D0%B8%D1%8F&locale=ru-RU",
    );
    expect(search.statusCode).toBe(200);
    expect(search.json().suggestions[0]).toMatchObject({
      qid: "Q42",
      matchedAliasLanguage: "ru-RU",
    });

    const entity = await read(h.app, session, "/api/catalogue/wikidata-entities/Q42");
    expect(entity.statusCode).toBe(200);
    expect(entity.json().identifiers).toEqual([
      { scheme: "imdb", value: "tt0073179", property: "P345" },
    ]);
  });

  it("degrades to local suggestions when Wikidata is unavailable", async () => {
    const h = await harness({
      async search() {
        throw new ApiError(503, "upstream_unavailable", "Wikidata is unreachable.");
      },
      async entity() {
        throw new ApiError(503, "upstream_unavailable", "Wikidata is unreachable.");
      },
    });
    const session = (await bootstrapAdmin(h)).session;

    const remote = await read(
      h.app,
      session,
      "/api/catalogue/wikidata-suggestions?query=irony&locale=en-US",
    );
    expect(remote.statusCode).toBe(503);
    expect(remote.json().code).toBe("upstream_unavailable");

    const local = await read(h.app, session, "/api/catalogue/suggestions?query=irony");
    expect(local.statusCode).toBe(200);
    expect(local.json().createProposal).toBe("irony");
  });

  it("refuses a malformed Wikidata identifier", async () => {
    const h = await harness();
    const session = (await bootstrapAdmin(h)).session;

    const response = await read(h.app, session, "/api/catalogue/wikidata-entities/not-a-qid");
    expect(response.statusCode).toBe(404);
  });
});
