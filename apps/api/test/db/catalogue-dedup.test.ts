import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  authHeaders,
  ceremonyApp,
  signedInAdministrator,
  type CeremonyApp,
  type SignedInOperator,
} from "./ceremony.js";

/**
 * Seam 1 and 3 (docs/design/catalogue-entry.md): the two hard duplicate
 * checks in their fixed order — external identifier equality first, then
 * the identity triple of normalized original text, release year, and title
 * type — and the identifier shapes. Every expected status and payload field
 * is transcribed from the design, never from the implementation.
 */
describe("catalogue entry: duplicate checks and identifier shapes", () => {
  let world: CeremonyApp;
  let admin: SignedInOperator;
  let groupId: string;

  beforeAll(async () => {
    world = await ceremonyApp();
    admin = await signedInAdministrator(world, "admin@example.test");
    groupId = await createGroup(world.app, admin);
  });

  afterAll(async () => {
    await world.app.close();
    await world.pool.end();
  });

  async function createTitle(
    app: FastifyInstance,
    actor: SignedInOperator,
    overrides: Record<string, unknown> = {},
  ) {
    return app.inject({
      method: "POST",
      url: "/api/titles",
      headers: { "content-type": "application/json", ...authHeaders(actor) },
      payload: {
        titleGroupId: groupId,
        originalVariant: { text: "Neon City", language: "en", script: "Latn" },
        releaseYear: 1991,
        titleType: "film",
        additionalVariants: [],
        externalIdentifiers: [],
        source: "rights_holder_record",
        ...overrides,
      },
    });
  }

  it("creates a title with its original variant atomically and records provenance", async () => {
    const created = await createTitle(world.app, admin, {
      externalIdentifiers: [{ scheme: "wikidata", value: "Q123" }],
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.title.originalVariantId).toBe(body.variants[0].id);
    expect(body.variants).toHaveLength(1);
    expect(body.variants[0].kind).toBe("original");
    expect(body.variants[0].text).toBe("Neon City");
    // Provenance: the actor, the time, and the stated source.
    expect(body.title.provenance.enteredBy).toBe(admin.operatorId);
    expect(body.title.provenance.source).toBe("rights_holder_record");
    expect(body.title.provenance.enteredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(body.displayTitle).toBe("Neon City");
    expect(body.title.releaseYear).toBe(1991);
    expect(body.title.titleType).toBe("film");
    expect(body.externalIdentifiers[0]).toMatchObject({
      scheme: "wikidata",
      value: "Q123",
      source: "rights_holder_record",
    });
  });

  it("blocks creation when a supplied external identifier already exists, with existingTitleId", async () => {
    const blocked = await createTitle(world.app, admin, {
      originalVariant: { text: "A Different Work", language: "en", script: "Latn" },
      releaseYear: 2001,
      externalIdentifiers: [{ scheme: "wikidata", value: "Q123" }],
    });
    // Identifier equality identifies the title whatever its text says.
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe("duplicate_title");
    expect(typeof blocked.json().existingTitleId).toBe("string");
  });

  it("blocks creation on the identity triple: normalized text, year, and type", async () => {
    const blocked = await createTitle(world.app, admin, {
      // Normalizes to the same key as "Neon City": punctuation collapses,
      // case folds.
      originalVariant: { text: "neon  city!", language: "en", script: "Latn" },
      releaseYear: 1991,
      titleType: "film",
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe("duplicate_title");
    expect(typeof blocked.json().existingTitleId).toBe("string");
  });

  it("passes a same-named work with another year or type", async () => {
    const remake = await createTitle(world.app, admin, {
      originalVariant: { text: "Neon City", language: "en", script: "Latn" },
      releaseYear: 2021,
      titleType: "series",
    });
    expect(remake.statusCode).toBe(201);
  });

  it("refuses malformed identifier shapes on creation", async () => {
    for (const [scheme, value] of [
      ["wikidata", "q123"],
      ["wikidata", "QT12"],
      ["imdb", "tt123"],
      ["kinopoisk", "abc45"],
    ] as const) {
      const refused = await createTitle(world.app, admin, {
        originalVariant: { text: `Shape ${value}`, language: "en", script: "Latn" },
        releaseYear: 1999,
        externalIdentifiers: [{ scheme, value }],
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().code).toBe("validation_failed");
      expect(refused.json().fieldErrors[0].path).toBe("/value");
    }
  });

  it("accepts every scheme's documented shape", async () => {
    const accepted = await createTitle(world.app, admin, {
      originalVariant: { text: "Shape Parade", language: "en", script: "Latn" },
      releaseYear: 2005,
      externalIdentifiers: [
        { scheme: "wikidata", value: "Q987654321" },
        { scheme: "imdb", value: "tt1234567" },
        { scheme: "kinopoisk", value: "45678" },
      ],
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().externalIdentifiers).toHaveLength(3);
  });

  it("refuses a multi-line paste rather than splitting it", async () => {
    const refused = await createTitle(world.app, admin, {
      originalVariant: { text: "First\nSecond", language: "en", script: "Latn" },
      releaseYear: 1990,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe("validation_failed");
  });

  it("settles an identifier race with the owning title's id in the 409", async () => {
    // Two concurrent creations carrying the same identifier: whichever
    // pre-check runs first sees nothing, the unique index decides, and the
    // loser re-reads the winner — the same 409 duplicate_title with an
    // existingTitleId the pre-check would have answered with.
    const identifier = { scheme: "wikidata" as const, value: "Q246801357" };
    const [first, second] = await Promise.all([
      createTitle(world.app, admin, {
        originalVariant: { text: "Race Left", language: "en", script: "Latn" },
        releaseYear: 1996,
        externalIdentifiers: [identifier],
      }),
      createTitle(world.app, admin, {
        originalVariant: { text: "Race Right", language: "en", script: "Latn" },
        releaseYear: 1996,
        externalIdentifiers: [identifier],
      }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = first.statusCode === 409 ? first : second;
    const winner = first.statusCode === 201 ? first : second;
    expect(loser.json().code).toBe("duplicate_title");
    // The refusal names the title that won, whichever path refused it.
    expect(loser.json().existingTitleId).toBe(winner.json().title.id);
  });

  it("settles an add-identifier race as 409 duplicate_entity naming the holder", async () => {
    // The same race one layer down: two titles exist, and the same
    // scheme-and-value pair is recorded on both at once. The scheme-value
    // unique index decides; the loser answers the pre-check's 409
    // duplicate_entity with the existingTitleId that already holds it.
    const left = await createTitle(world.app, admin, {
      originalVariant: { text: "Identifier Race Left", language: "en", script: "Latn" },
      releaseYear: 1997,
    });
    const right = await createTitle(world.app, admin, {
      originalVariant: { text: "Identifier Race Right", language: "en", script: "Latn" },
      releaseYear: 1998,
    });
    const add = (titleId: string) =>
      world.app.inject({
        method: "POST",
        url: `/api/titles/${titleId}/external-identifiers`,
        headers: { "content-type": "application/json", ...authHeaders(admin) },
        payload: { scheme: "imdb", value: "tt7654321" },
      });
    const [leftAttempt, rightAttempt] = await Promise.all([
      add(left.json().title.id),
      add(right.json().title.id),
    ]);
    const statuses = [leftAttempt.statusCode, rightAttempt.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = leftAttempt.statusCode === 409 ? leftAttempt : rightAttempt;
    const winnerTitleId =
      leftAttempt.statusCode === 201
        ? left.json().title.id
        : right.json().title.id;
    expect(loser.json().code).toBe("duplicate_entity");
    expect(loser.json().existingTitleId).toBe(winnerTitleId);
  });
});

async function createGroup(
  app: FastifyInstance,
  actor: SignedInOperator,
): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/title-groups",
    headers: { "content-type": "application/json", ...authHeaders(actor) },
    payload: {
      name: "Nineties cinema",
      locales: ["en", "ru"],
      scanTime: "02:30:00Z",
      priority: "normal",
    },
  });
  expect(created.statusCode).toBe(201);
  return created.json().id as string;
}
