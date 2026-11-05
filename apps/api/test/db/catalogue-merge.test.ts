import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mergeTitles, MERGE_GUARD_PREDICATES } from "../../src/domain/catalogue/merge.js";
import { testConfig } from "../test-app.js";
import {
  authHeaders,
  ceremonyApp,
  signedInAdministrator,
  type CeremonyApp,
  type SignedInOperator,
} from "./ceremony.js";

/**
 * Seam 4 (docs/design/catalogue-entry.md): a merge is offered only while
 * the duplicate has no candidate and no violation — a pluggable predicate
 * list slice 5 extends — and its effect moves variants and identifiers to
 * the survivor and archives the duplicate with a mergedInto pointer.
 */
describe("merge", () => {
  let world: CeremonyApp;
  let admin: SignedInOperator;
  let groupId: string;

  beforeAll(async () => {
    world = await ceremonyApp();
    admin = await signedInAdministrator(world, "admin@example.test");
    const group = await world.app.inject({
      method: "POST",
      url: "/api/title-groups",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        name: "Merge group",
        locales: ["en"],
        scanTime: "04:00:00Z",
        priority: "normal",
      },
    });
    groupId = group.json().id;
  });

  afterAll(async () => {
    await world.app.close();
    await world.pool.end();
  });

  async function createTitle(text: string, year: number) {
    const created = await world.app.inject({
      method: "POST",
      url: "/api/titles",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        titleGroupId: groupId,
        originalVariant: { text, language: "en", script: "Latn" },
        releaseYear: year,
        titleType: "film",
        additionalVariants: [],
        externalIdentifiers: [],
        source: "operator_knowledge",
      },
    });
    expect(created.statusCode).toBe(201);
    return created.json();
  }

  it("moves rows and archives the duplicate with mergedIntoTitleId", async () => {
    const survivor = await createTitle("Survivor Work", 1988);
    const duplicate = await createTitle("Duplicate Work", 1988);
    const duplicateId = duplicate.title.id;
    // Give the duplicate a variant and an identifier to move.
    const variant = await world.app.inject({
      method: "POST",
      url: `/api/titles/${duplicateId}/variants`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        text: "Duplicate Alternate",
        kind: "alternate",
        language: "en",
        script: "Latn",
        source: "operator_knowledge",
      },
    });
    expect(variant.statusCode).toBe(201);
    const identifier = await world.app.inject({
      method: "POST",
      url: `/api/titles/${duplicateId}/external-identifiers`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { scheme: "wikidata", value: "Q777" },
    });
    expect(identifier.statusCode).toBe(201);

    const merged = await world.app.inject({
      method: "POST",
      url: `/api/titles/${duplicateId}/merge`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { survivingTitleId: survivor.title.id },
    });
    expect(merged.statusCode).toBe(200);
    const result = merged.json();
    expect(result.movedVariantCount).toBe(2);
    expect(result.movedIdentifierCount).toBe(1);
    expect(result.archivedTitle.mergedIntoTitleId).toBe(survivor.title.id);
    // The survivor now carries every row, and its original stays original.
    expect(result.survivingTitle.variants).toHaveLength(3);
    expect(
      result.survivingTitle.variants.filter((v: { kind: string }) => v.kind === "original"),
    ).toHaveLength(1);
    expect(result.survivingTitle.externalIdentifiers).toHaveLength(1);

    // The archived duplicate leaves the catalogue list but stays readable.
    const detail = await world.app.inject({
      method: "GET",
      url: `/api/titles/${duplicateId}`,
      headers: { cookie: admin.cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().title.mergedIntoTitleId).toBe(survivor.title.id);
  });

  it("refuses a merge into itself and onto an archived title", async () => {
    const one = await createTitle("Self Merge Test", 1975);
    const self = await world.app.inject({
      method: "POST",
      url: `/api/titles/${one.title.id}/merge`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { survivingTitleId: one.title.id },
    });
    expect(self.statusCode).toBe(409);
    expect(self.json().code).toBe("state_conflict");

    const survivor = await createTitle("Second Survivor", 1976);
    const duplicate = await createTitle("Second Duplicate", 1976);
    const first = await world.app.inject({
      method: "POST",
      url: `/api/titles/${duplicate.title.id}/merge`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { survivingTitleId: survivor.title.id },
    });
    expect(first.statusCode).toBe(200);
    // An archived title neither merges nor absorbs.
    const ontoArchived = await world.app.inject({
      method: "POST",
      url: `/api/titles/${survivor.title.id}/merge`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { survivingTitleId: duplicate.title.id },
    });
    expect(ontoArchived.statusCode).toBe(409);
    const archivedMerges = await world.app.inject({
      method: "POST",
      url: `/api/titles/${duplicate.title.id}/merge`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { survivingTitleId: survivor.title.id },
    });
    expect(archivedMerges.statusCode).toBe(409);
  });

  it("refuses a merge a guard predicate blocks, naming the title", async () => {
    const survivor = await createTitle("Guarded Survivor", 1960);
    const duplicate = await createTitle("Guarded Duplicate", 1960);
    // Slice 5b registered the pair: any candidate or any violation on the
    // duplicate blocks its merge. The seam still drives the mechanism
    // through the domain function with an injected blocking predicate.
    expect(MERGE_GUARD_PREDICATES.map((predicate) => predicate.name)).toEqual([
      "candidates",
      "violations",
    ]);
    await expect(
      mergeTitles(
        world.pool,
        testConfig({ now: world.clock.now }).now,
        admin.operatorId,
        { duplicateId: duplicate.title.id, survivingTitleId: survivor.title.id },
        [{ name: "test-blocks-everything", blocks: async () => true }],
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "state_conflict",
      blockingTitleId: duplicate.title.id,
    });
    // Nothing moved: the duplicate still lists its own variant.
    const detail = await world.app.inject({
      method: "GET",
      url: `/api/titles/${duplicate.title.id}`,
      headers: { cookie: admin.cookie },
    });
    expect(detail.json().title.mergedIntoTitleId).toBeUndefined();
    expect(detail.json().variants).toHaveLength(1);
  });

  it("refuses corrections and sub-resource writes on an archived title", async () => {
    const survivor = await createTitle("Archive Survivor", 1955);
    const duplicate = await createTitle("Archive Duplicate", 1955);
    const merged = await world.app.inject({
      method: "POST",
      url: `/api/titles/${duplicate.title.id}/merge`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { survivingTitleId: survivor.title.id },
    });
    expect(merged.statusCode).toBe(200);

    // An in-place correction is a lifecycle conflict, not an absence: the
    // title is still readable, but its records moved to the survivor.
    const patched = await world.app.inject({
      method: "PATCH",
      url: `/api/titles/${duplicate.title.id}`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { paused: true },
    });
    expect(patched.statusCode).toBe(409);
    expect(patched.json().code).toBe("state_conflict");

    // Sub-resource writes treat the archived row as not addressable, the
    // way variant and identifier creation already do.
    const variant = await world.app.inject({
      method: "POST",
      url: `/api/titles/${duplicate.title.id}/variants`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        text: "Archived Alternate",
        kind: "alternate",
        language: "en",
        script: "Latn",
        source: "operator_knowledge",
      },
    });
    expect(variant.statusCode).toBe(404);

    const identifier = await world.app.inject({
      method: "POST",
      url: `/api/titles/${duplicate.title.id}/external-identifiers`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { scheme: "wikidata", value: "Q1357908642" },
    });
    expect(identifier.statusCode).toBe(404);
  });
});
