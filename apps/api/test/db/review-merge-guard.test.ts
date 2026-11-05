import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { controlledClock } from "../test-app.js";
import { mergeTitles } from "../../src/domain/catalogue/merge.js";
import { ApiError } from "../../src/errors.js";
import { testPool, truncateDomainTables } from "./helpers.js";

/**
 * Seam 11 (implementation rules "Catalogue and scope / Merge guard"): a
 * duplicate may merge only while it has no candidate and no violation —
 * the two predicates slice 5b registers on the merge guard list. Any
 * candidate blocks (the operator resolves them as wrong work first); any
 * violation blocks outright, because a violation's URL-and-title identity
 * is permanent.
 */

const FROZEN = "2026-01-01T00:00:00.000Z";

async function seedTwoTitles(pool: Pool): Promise<{
  operatorId: string;
  duplicateId: string;
  survivorId: string;
}> {
  await pool.query(
    `insert into rights_holder (singleton, legal_name, country)
     values (true, 'Example Rights GmbH', 'DE')
     on conflict (singleton) do nothing`,
  );
  const operator = await pool.query<{ id: string }>(
    `insert into operators (email, password_hash, role, state, created_at, updated_at)
     values ('merge@example.test', 'x', 'operator', 'active', $1, $1) returning id`,
    [FROZEN],
  );
  const operatorId = operator.rows[0].id;
  const group = await pool.query<{ id: string }>(
    `insert into title_groups (name, locales) values ('Films', '{en}') returning id`,
  );
  const seedTitle = async (text: string): Promise<string> => {
    const title = await pool.query<{ id: string }>(
      `insert into tracked_titles
         (title_group_id, release_year, title_type, source, entered_by, entered_at, updated_by, created_at, updated_at)
       values ($1, 2024, 'film', 'operator_knowledge', $2, $3, $2, $3, $3) returning id`,
      [group.rows[0].id, operatorId, FROZEN],
    );
    const variant = await pool.query<{ id: string }>(
      `insert into title_variants
         (tracked_title_id, text, normalized_text, kind, language, script, source, added_by, added_at)
       values ($1, $2, lower($2), 'original', 'en', 'Latn', 'operator_knowledge', $3, $4) returning id`,
      [title.rows[0].id, text, operatorId, FROZEN],
    );
    await pool.query(
      "update tracked_titles set original_variant_id = $2 where id = $1",
      [title.rows[0].id, variant.rows[0].id],
    );
    return title.rows[0].id;
  };
  return {
    operatorId,
    duplicateId: await seedTitle("Sunrise Duplicate"),
    survivorId: await seedTitle("Sunrise"),
  };
}

/** One pending candidate for a title, seeded directly. */
async function seedCandidateFor(pool: Pool, titleId: string, url: string): Promise<string> {
  const host = new URL(url).hostname;
  const result = await pool.query<{ id: string }>(
    `insert into candidates
       (tracked_title_id, url, normalized_url, host, registrable_domain, source, engine, engines,
        best_rank, matched_variant_id, matched_variant, score, band, score_components, reputation,
        first_seen_at, last_observed_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'serp', 'google', '{google}', 1,
        (select original_variant_id from tracked_titles where id = $1),
        '{}'::jsonb, 0.6, 'b', '{}'::jsonb, '{}'::jsonb, $6, $6, $6, $6)
     returning id`,
    [titleId, url, `${host}${new URL(url).pathname}`, host, host.split(".").slice(-2).join("."), FROZEN],
  );
  return result.rows[0].id;
}

describe("the merge guard's review predicates", () => {
  let pool: Pool;
  const clock = controlledClock(FROZEN);

  beforeEach(async () => {
    pool = testPool();
    await truncateDomainTables(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("refuses a merge while any candidate stands on the duplicate, and allows it once none does", async () => {
    const world = await seedTwoTitles(pool);
    const candidateId = await seedCandidateFor(
      pool,
      world.duplicateId,
      "https://mirror.example.test/film",
    );

    await expect(
      mergeTitles(pool, clock.now, world.operatorId, {
        duplicateId: world.duplicateId,
        survivingTitleId: world.survivorId,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "state_conflict" });

    // Resolve the candidate (delete it as the wrong-work cleanup would),
    // and the merge goes through.
    await pool.query("delete from candidates where id = $1", [candidateId]);
    const merged = await mergeTitles(pool, clock.now, world.operatorId, {
      duplicateId: world.duplicateId,
      survivingTitleId: world.survivorId,
    });
    expect(merged.movedVariantCount).toBe(1);
  });

  it("refuses a merge while any violation stands on the duplicate", async () => {
    const world = await seedTwoTitles(pool);
    const candidateId = await seedCandidateFor(
      pool,
      world.duplicateId,
      "https://mirror2.example.test/film",
    );
    // The violation's own review decision, seeded the way the decision path
    // writes it: decision, violation, confirmed candidate.
    const decision = await pool.query<{ id: string }>(
      `insert into review_decisions (candidate_id, operator_id, action, decided_at, evidence_ids, violation_id)
       values ($1, $2, 'violation', $3, '{}'::uuid[], uuidv7()) returning id`,
      [candidateId, world.operatorId, FROZEN],
    );
    await pool.query(
      `insert into violations
         (tracked_title_id, candidate_id, review_decision_id, url, normalized_url, host,
          host_source, registrable_domain, detected_at, confirmed_at, confirmed_by, opened_at)
       values ($1, $2, $3, $4, $5, 'mirror2.example.test', 'submitted_url', 'example.test', $6, $6, $7, $6)`,
      [
        world.duplicateId,
        candidateId,
        decision.rows[0].id,
        "https://mirror2.example.test/film",
        "mirror2.example.test/film",
        FROZEN,
        world.operatorId,
      ],
    );

    await expect(
      mergeTitles(pool, clock.now, world.operatorId, {
        duplicateId: world.duplicateId,
        survivingTitleId: world.survivorId,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
