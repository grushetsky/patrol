import { beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { buildApp, testConfig, controlledClock } from "../test-app.js";
import { getValidator } from "../../src/plugins/validator.js";
import type { ScanDispatcher } from "../../src/queue/dispatch.js";
import { ceremonyApp, signedInAdministrator, authHeaders, type CeremonyApp } from "./ceremony.js";
import { testPool, truncateDomainTables } from "./helpers.js";

/**
 * Seam 10: the Scans and Rechecks interfaces over HTTP — the manual scan
 * request (202, idempotent on the day, dispatching the engine queues), the
 * scan history and its filters, one scan with its plan and lifecycle, the
 * results a scan recorded, and the ladders. Every response body validates
 * against the emitted schema bundle, and a plain operator reaches every
 * operation the contract's x-patrol-roles allows.
 */

const FROZEN_NOW = "2026-03-02T10:00:00.000Z";

/** A dispatcher that records the wakes instead of sending. */
function recordingDispatcher(): ScanDispatcher & { engines: string[] } {
  const engines: string[] = [];
  return {
    engines,
    async dispatchScanRun(engine) {
      engines.push(engine);
    },
  };
}

async function seedCatalogue(
  pool: Pool,
  operatorId: string,
): Promise<{ groupId: string; titleId: string }> {
  const group = await pool.query<{ id: string }>(
    `insert into title_groups (name, locales, scan_time, priority)
     values ('Films', '{en,ru}', '02:30', 'normal') returning id`,
  );
  const title = await pool.query<{ id: string }>(
    `insert into tracked_titles
       (title_group_id, release_year, title_type, paused, source, entered_by, entered_at, updated_by, created_at, updated_at)
     values ($1, 2024, 'film', false, 'operator_knowledge', $2, $3, $2, $3, $3)
     returning id`,
    [group.rows[0].id, operatorId, FROZEN_NOW],
  );
  const variant = await pool.query<{ id: string }>(
    `insert into title_variants
       (tracked_title_id, text, normalized_text, kind, language, script, source, added_by, added_at)
     values ($1, 'Sunrise', 'sunrise', 'original', 'en', 'Latn', 'operator_knowledge', $2, $3)
     returning id`,
    [title.rows[0].id, operatorId, FROZEN_NOW],
  );
  await pool.query(
    "update tracked_titles set original_variant_id = $2 where id = $1",
    [title.rows[0].id, variant.rows[0].id],
  );
  return { groupId: group.rows[0].id, titleId: title.rows[0].id };
}

describe("the scans API", () => {
  let world: CeremonyApp;
  let operator: Awaited<ReturnType<typeof signedInAdministrator>>;
  let catalogue: { groupId: string; titleId: string };
  let dispatcher: ReturnType<typeof recordingDispatcher>;

  beforeEach(async () => {
    const pool = testPool();
    try {
      await truncateDomainTables(pool);
    } finally {
      await pool.end();
    }
    world = await ceremonyApp();
    operator = await signedInAdministrator(world);
    catalogue = await seedCatalogue(world.pool, operator.operatorId);
    dispatcher = recordingDispatcher();
    const app = await buildApp({
      config: testConfig({ now: world.clock.now }),
      pool: world.pool,
      mail: world.mail,
      schemaStamp: () => Promise.resolve(5),
      dispatcher,
    });
    world.app = app;
  });

  it("accepts a manual scan with 202, one scan per targeted engine, and wakes the queues", async () => {
    const response = await world.app.inject({
      method: "POST",
      url: "/api/scans",
      headers: { "content-type": "application/json", ...authHeaders(operator) },
      payload: { titleGroupId: catalogue.groupId, trigger: "manual" },
    });
    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.scans).toHaveLength(2);
    // The response wrapper's statusCode rides the status line; the body
    // validates as the contract's ManualScanResult.
    expect(getValidator("ManualScanResult")(body)).toBe(true);
    expect(
      body.scans.every(
        (scan: { lifecycle: { state: string } }) => scan.lifecycle.state === "queued",
      ),
    ).toBe(true);
    expect(body.scans.map((scan: { engine: string }) => scan.engine).sort()).toEqual([
      "google",
      "yandex",
    ]);
    // The row records who requested the manual work, and the response and
    // the listing both surface it.
    expect(
      body.scans.every(
        (scan: { requestedBy?: string }) => scan.requestedBy === operator.operatorId,
      ),
    ).toBe(true);
    expect(dispatcher.engines.sort()).toEqual(["google", "yandex"]);
  });

  it("returns the same scans for a second same-day request", async () => {
    const first = await world.app.inject({
      method: "POST",
      url: "/api/scans",
      headers: { "content-type": "application/json", ...authHeaders(operator) },
      payload: { titleGroupId: catalogue.groupId, trigger: "manual" },
    });
    const second = await world.app.inject({
      method: "POST",
      url: "/api/scans",
      headers: { "content-type": "application/json", ...authHeaders(operator) },
      payload: { titleGroupId: catalogue.groupId, trigger: "manual_recheck" },
    });
    expect(second.statusCode).toBe(202);
    expect(
      second.json().scans.map((scan: { id: string }) => scan.id).sort(),
    ).toEqual(first.json().scans.map((scan: { id: string }) => scan.id).sort());
    const total = await world.pool.query<{ count: string }>(
      "select count(*) as count from scans",
    );
    expect(Number(total.rows[0].count)).toBe(2);
  });

  it("refuses a request for an unknown group or for Bing, and queues one for a disabled route", async () => {
    const unknown = await world.app.inject({
      method: "POST",
      url: "/api/scans",
      headers: { "content-type": "application/json", ...authHeaders(operator) },
      payload: { titleGroupId: "00000000-0000-7000-8000-000000000000", trigger: "manual" },
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().code).toBe("unprocessable");

    // Bing buys no route in v1; a request naming it has nothing to run.
    const bing = await world.app.inject({
      method: "POST",
      url: "/api/scans",
      headers: { "content-type": "application/json", ...authHeaders(operator) },
      payload: { titleGroupId: catalogue.groupId, engine: "bing", trigger: "manual" },
    });
    expect(bing.statusCode).toBe(422);

    // Every route down: the request queues rather than skips — the rows
    // wait with `route_unavailable` until the hourly probe recovers the
    // engines, exactly as the scheduler's own rows wait.
    await world.pool.query(
      `insert into route_state (engine, disabled, disabled_reason, disabled_at, probe_next_at)
       values ('google', true, 'authentication', $1, $1), ('yandex', true, 'authentication', $1, $1)`,
      [FROZEN_NOW],
    );
    const noneEnabled = await world.app.inject({
      method: "POST",
      url: "/api/scans",
      headers: { "content-type": "application/json", ...authHeaders(operator) },
      payload: { titleGroupId: catalogue.groupId, trigger: "manual" },
    });
    expect(noneEnabled.statusCode).toBe(202);
    expect(getValidator("ManualScanResult")(noneEnabled.json())).toBe(true);
    const queuedReasons = noneEnabled
      .json()
      .scans.map(
        (scan: { lifecycle: { queuedReason?: string } }) => scan.lifecycle.queuedReason,
      )
      .sort();
    expect(queuedReasons).toEqual(["route_unavailable", "route_unavailable"]);
    // A disabled route's queue is not woken.
    expect(dispatcher.engines).toEqual([]);
  });

  it("lists scans with filters and reads one with its plan", async () => {
    await world.app.inject({
      method: "POST",
      url: "/api/scans",
      headers: { "content-type": "application/json", ...authHeaders(operator) },
      payload: { titleGroupId: catalogue.groupId, trigger: "manual" },
    });
    const list = await world.app.inject({
      method: "GET",
      url: "/api/scans?engine=google&state=queued",
      headers: { cookie: operator.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(1);
    expect(getValidator("ScanPage")(list.json())).toBe(true);

    const scanId = list.json().items[0].id;
    const read = await world.app.inject({
      method: "GET",
      url: `/api/scans/${scanId}`,
      headers: { cookie: operator.cookie },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().lifecycle.state).toBe("queued");
    expect(getValidator("Scan")(read.json())).toBe(true);

    const missing = await world.app.inject({
      method: "GET",
      url: "/api/scans/00000000-0000-7000-8000-000000000000",
      headers: { cookie: operator.cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("serves a scan's recorded results and the re-check ladders", async () => {
    const scan = await world.pool.query<{ id: string }>(
      `insert into scans (title_group_id, engine, due_date, trigger_kind, scan_time, created_at,
                          state, started_at, finished_at)
       values ($1, 'google', '2026-03-02', 'scheduled', '02:30', $2, 'succeeded', $2, $2)
       returning id`,
      [catalogue.groupId, FROZEN_NOW],
    );
    const plan = await world.pool.query<{ id: string }>(
      `insert into query_plans (scan_id, generated_at) values ($1, $2) returning id`,
      [scan.rows[0].id, FROZEN_NOW],
    );
    const query = await world.pool.query<{ id: string }>(
      `insert into search_queries
         (query_plan_id, tracked_title_id, locale, kind, text, normalized_text,
          intent_phrase, intent_phrase_version, position)
       values ($1, $2, 'en', 'intent', 'Sunrise watch online', 'sunrise watch online',
               'watch online', 1, 0)
       returning id`,
      [plan.rows[0].id, catalogue.titleId],
    );
    await world.pool.query(
      `insert into search_results
         (scan_id, query_id, url, normalized_url, rank, title, snippet, locale, observed_at,
          raw_payload_ref, host, registrable_domain)
       values ($1, $2, 'https://www.Example.com/watch/', 'example.com/watch', 1, 'T', 's', 'en', $3, 'fake:google:q', 'example.com', 'example.com')`,
      [scan.rows[0].id, query.rows[0].id, FROZEN_NOW],
    );
    // A row the matching step paired into a candidate carries the id: the
    // candidates table stands since slice 5a, so seed the pair for real.
    const candidate = await world.pool.query<{ id: string }>(
      `insert into candidates
         (tracked_title_id, url, normalized_url, host, registrable_domain, source, engine,
          engines, best_rank, matched_variant_id, matched_variant, score, band,
          score_components, reputation, first_seen_at, last_observed_at)
       select $1, 'https://www.Example.com/download', 'example.com/download', 'example.com',
              'example.com', 'serp', 'google', '{google}', 2, v.id,
              jsonb_build_object('id', v.id, 'text', v.text, 'kind', v.kind,
                                 'language', v.language, 'script', v.script),
              0.6, 'c',
              '{"titleMatch":0.6,"signals":[],"reputation":0}'::jsonb,
              '{"registrableDomain":"example.com","confirmedViolations":0,"bonus":0,"blocklisted":false}'::jsonb,
              $2, $2
         from title_variants v
        where v.id = (select original_variant_id from tracked_titles where id = $1)
       returning id`,
      [catalogue.titleId, FROZEN_NOW],
    );
    await world.pool.query(
      `insert into search_results
         (scan_id, query_id, url, normalized_url, rank, title, snippet, locale, observed_at,
          raw_payload_ref, host, registrable_domain, candidate_id)
       values ($1, $2, 'https://www.Example.com/download', 'example.com/download', 2, 'D', 's', 'en', $3, 'fake:google:q', 'example.com', 'example.com',
               $4)`,
      [scan.rows[0].id, query.rows[0].id, FROZEN_NOW, candidate.rows[0].id],
    );

    const results = await world.app.inject({
      method: "GET",
      url: `/api/scans/${scan.rows[0].id}/results`,
      headers: { cookie: operator.cookie },
    });
    expect(results.statusCode).toBe(200);
    expect(results.json().total).toBe(2);
    expect(results.json().items[0]).toMatchObject({
      url: "https://www.Example.com/watch/",
      normalizedUrl: "example.com/watch",
      host: "example.com",
    });
    // An unpaired row omits the field entirely; a paired row names the
    // standing candidate.
    expect(results.json().items[0]).not.toHaveProperty("candidateId");
    expect(results.json().items[1]).toMatchObject({
      url: "https://www.Example.com/download",
      candidateId: candidate.rows[0].id,
    });
    expect(getValidator("SearchResultPage")(results.json())).toBe(true);

    await world.pool.query(
      `insert into recheck_schedules
         (title_group_id, engine, rung, next_due_at, active, anchored_scan_id, updated_at)
       values ($1, 'google', 1, $2, true, $3, $2)`,
      [catalogue.groupId, FROZEN_NOW, scan.rows[0].id],
    );
    const rechecks = await world.app.inject({
      method: "GET",
      url: `/api/rechecks?engine=google`,
      headers: { cookie: operator.cookie },
    });
    expect(rechecks.statusCode).toBe(200);
    expect(rechecks.json().total).toBe(1);
    expect(rechecks.json().items[0]).toMatchObject({
      rung: 1,
      active: true,
      startedByScanId: scan.rows[0].id,
    });
    expect(getValidator("RecheckSchedulePage")(rechecks.json())).toBe(true);
  });
});
