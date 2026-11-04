import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authHeaders,
  ceremonyApp,
  signedInAdministrator,
  type CeremonyApp,
  type SignedInOperator,
} from "./ceremony.js";

/**
 * Seam 2 (GLOSSARY invariants): a variant's text is unique within its title
 * after normalization, and exactly one variant of a title is original —
 * the original is created with the title, never through "Add as variant".
 */
describe("variant uniqueness", () => {
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
        name: "Variants group",
        locales: ["en"],
        scanTime: "03:00:00Z",
        priority: "normal",
      },
    });
    groupId = group.json().id;
    const title = await world.app.inject({
      method: "POST",
      url: "/api/titles",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        titleGroupId: groupId,
        originalVariant: { text: "Léon", language: "fr", script: "Latn" },
        releaseYear: 1994,
        titleType: "film",
        additionalVariants: [],
        externalIdentifiers: [],
        source: "operator_knowledge",
      },
    });
    expect(title.statusCode).toBe(201);
    titleId = title.json().title.id;
  });

  afterAll(async () => {
    await world.app.close();
    await world.pool.end();
  });

  it("refuses a variant whose normalized text repeats within the title", async () => {
    // "Leon!" normalizes to the same key as "Léon": diacritics fold and
    // punctuation collapses.
    const refused = await world.app.inject({
      method: "POST",
      url: `/api/titles/${titleId}/variants`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        text: "Leon!",
        kind: "localized",
        language: "en",
        script: "Latn",
        source: "operator_knowledge",
      },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("duplicate_entity");
  });

  it("refuses a second original variant", async () => {
    const refused = await world.app.inject({
      method: "POST",
      url: `/api/titles/${titleId}/variants`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        text: "The Professional",
        kind: "original",
        language: "en",
        script: "Latn",
        source: "operator_knowledge",
      },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("state_conflict");
  });

  it("adds a variant and warns when its text twins another title's", async () => {
    const twin = await world.app.inject({
      method: "POST",
      url: "/api/titles",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        titleGroupId: groupId,
        originalVariant: { text: "Sunset Beach", language: "en", script: "Latn" },
        // The same year and type as the host title: that is what makes the
        // twin a warning rather than an unrelated work.
        releaseYear: 1994,
        titleType: "film",
        additionalVariants: [],
        externalIdentifiers: [],
        source: "operator_knowledge",
      },
    });
    expect(twin.statusCode).toBe(201);
    const twinId = twin.json().title.id;

    const added = await world.app.inject({
      method: "POST",
      url: `/api/titles/${titleId}/variants`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        text: "Sunset Beach",
        kind: "alternate",
        language: "en",
        script: "Latn",
        source: "operator_knowledge",
      },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().variant.kind).toBe("alternate");
    // The warning names the other title; the operator decides.
    expect(added.json().similarTitleId).toBe(twinId);
  });

  it("pauses and resumes a title through the update route", async () => {
    const paused = await world.app.inject({
      method: "PATCH",
      url: `/api/titles/${titleId}`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { paused: true },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().title.paused).toBe(true);
    const resumed = await world.app.inject({
      method: "PATCH",
      url: `/api/titles/${titleId}`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { paused: false },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().title.paused).toBe(false);
  });

  it("settles a same-text race as 409 duplicate_entity, not an internal error", async () => {
    // Two concurrent saves of the same text: the repeat pre-check cannot
    // see the other save, so the title's unique index decides — and the
    // loser answers the same duplicate_entity the pre-check answers.
    const payload = () => ({
      method: "POST",
      url: `/api/titles/${titleId}/variants`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        text: "Race Condition",
        kind: "alternate",
        language: "en",
        script: "Latn",
        source: "operator_knowledge",
      },
    });
    const [first, second] = await Promise.all([
      world.app.inject(payload()),
      world.app.inject(payload()),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = first.statusCode === 409 ? first : second;
    expect(loser.json().code).toBe("duplicate_entity");
  });
});
