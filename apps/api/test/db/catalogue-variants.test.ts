import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authHeaders,
  ceremonyApp,
  FROZEN_NOW,
  signIn,
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

  it("pauses and resumes a title through the update route, recording the pause history", async () => {
    // The pause state machine's database half (0010): paused/paused_at carry
    // the CURRENT state, title_pause_periods the history the chart reads. A
    // distinct clock per step keeps the instants assertable; each step
    // signs in afresh, because the clock jumps the ceremony session's
    // idle window cannot span.
    const sessionAt = async (iso: string): Promise<Record<string, string>> => {
      world.clock.set(iso);
      const fresh = await signIn(world, admin.email, "correct horse battery staple", admin.totpSecret);
      expect(fresh.status).toBe(200);
      return {
        "content-type": "application/json",
        cookie: fresh.setCookie!,
        "x-patrol-csrf": String(fresh.body.csrfToken),
      };
    };
    const patch = async (headers: Record<string, string>, payload: Record<string, unknown>) =>
      world.app.inject({
        method: "PATCH",
        url: `/api/titles/${titleId}`,
        headers,
        payload,
      });
    const state = async () =>
      world.pool.query<{ paused: boolean; paused_at: string | null }>(
        `select paused, ((paused_at at time zone 'UTC')::text) as paused_at
           from tracked_titles where id = $1`,
        [titleId],
      );
    // The instants are read as plain UTC timestamps, so the assertion does
    // not depend on the server's session timezone.
    const periods = async () =>
      world.pool.query<{ paused_at: string; resumed_at: string | null }>(
        `select ((paused_at at time zone 'UTC')::text) as paused_at,
                ((resumed_at at time zone 'UTC')::text) as resumed_at
           from title_pause_periods where tracked_title_id = $1 order by paused_at`,
        [titleId],
      );

    // Pausing stamps paused_at and opens a period.
    const pausedHeaders = await sessionAt("2025-12-29T06:00:00Z");
    const paused = await patch(pausedHeaders, { paused: true });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().title.paused).toBe(true);
    expect((await state()).rows[0]).toMatchObject({
      paused: true,
      paused_at: "2025-12-29 06:00:00",
    });
    expect((await periods()).rows).toEqual([
      { paused_at: "2025-12-29 06:00:00", resumed_at: null },
    ]);

    // Resuming clears the current-state stamp and closes the period — the
    // interval survives, it is not erased.
    const resumeHeaders = await sessionAt("2025-12-31T06:00:00Z");
    const resumed = await patch(resumeHeaders, { paused: false });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().title.paused).toBe(false);
    expect((await state()).rows[0]).toMatchObject({
      paused: false,
      paused_at: null,
    });
    expect((await periods()).rows).toEqual([
      { paused_at: "2025-12-29 06:00:00", resumed_at: "2025-12-31 06:00:00" },
    ]);

    // A re-pause opens a fresh period beside the closed one.
    const rePauseHeaders = await sessionAt("2026-01-01T06:00:00Z");
    expect((await patch(rePauseHeaders, { paused: true })).statusCode).toBe(200);
    expect((await periods()).rows).toEqual([
      { paused_at: "2025-12-29 06:00:00", resumed_at: "2025-12-31 06:00:00" },
      { paused_at: "2026-01-01 06:00:00", resumed_at: null },
    ]);

    // Edits that leave the paused state alone preserve the history: an
    // unrelated field, and a repeated pause that is already in force.
    expect((await patch(rePauseHeaders, { releaseYear: 1995 })).statusCode).toBe(200);
    expect((await patch(rePauseHeaders, { paused: true })).statusCode).toBe(200);
    expect((await periods()).rows).toHaveLength(2);
    expect((await periods()).rows[1]).toMatchObject({ resumed_at: null });

    // Leave the suite's frozen clock for the tests that follow.
    world.clock.set(FROZEN_NOW);
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
