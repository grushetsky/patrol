import { beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapAdmin,
  harness,
  mutate,
  read,
  type Harness,
} from "./support/harness.js";
import { GROUP } from "./support/fixtures.js";

describe("scans", () => {
  let h: Harness;
  let session: string;
  let groupId: string;

  beforeEach(async () => {
    h = await harness();
    session = (await bootstrapAdmin(h)).session;
    const group = await mutate(h.app, session, "POST", "/api/title-groups", GROUP);
    groupId = group.json().id;
  });

  it("queues a manual scan idempotently for the day", async () => {
    const first = await mutate(h.app, session, "POST", "/api/scans", {
      titleGroupId: groupId,
      engine: "google",
      trigger: "manual",
    });

    expect(first.statusCode).toBe(202);
    expect(first.json().scans).toHaveLength(1);
    expect(first.json().scans[0]).toMatchObject({
      titleGroupId: groupId,
      engine: "google",
      trigger: "manual",
      plannedQueries: 0,
      lifecycle: { state: "queued" },
    });
    expect(h.contract.validate("ManualScanResult", first.json()).valid).toBe(true);

    const second = await mutate(h.app, session, "POST", "/api/scans", {
      titleGroupId: groupId,
      engine: "google",
      trigger: "manual",
    });
    expect(second.json().scans[0].id).toBe(first.json().scans[0].id);
    expect((await h.db.query("SELECT * FROM scan")).rows).toHaveLength(1);
  });

  it("returns the scan the scheduler already created for the day", async () => {
    const today = new Date();
    const dueDate = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
    await h.db.query(
      `INSERT INTO scan
        (id, title_group_id, engine, trigger, due_date, requested_by,
         tracked_title_id, planned_queries, query_plan, state, queued_at,
         queued_reason, started_at, finished_at, issued_queries,
         failure_reason, failures, created_at)
       VALUES ('scheduled-scan', $1, 'google', 'scheduled', $2, NULL, NULL, 0,
               NULL, 'queued', $3, NULL, NULL, NULL, NULL, NULL, NULL, $3)`,
      [groupId, dueDate, today],
    );

    const response = await mutate(h.app, session, "POST", "/api/scans", {
      titleGroupId: groupId,
      engine: "google",
      trigger: "manual",
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().scans[0].id).toBe("scheduled-scan");
    expect(response.json().scans[0].trigger).toBe("scheduled");
    expect((await h.db.query("SELECT * FROM scan")).rows).toHaveLength(1);
  });

  it("targets every enabled engine when the request omits one", async () => {
    await h.db.query(
      `INSERT INTO engine_route
        (engine, disabled_at, disabled_reason, last_probe_at, updated_at)
       VALUES ('google', $1, 'revoked key', NULL, $1)`,
      [new Date()],
    );

    const response = await mutate(h.app, session, "POST", "/api/scans", {
      titleGroupId: groupId,
      trigger: "manual",
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().scans.map((scan: { engine: string }) => scan.engine)).toEqual([
      "yandex",
    ]);
  });

  it("refuses Bing and a title from another group", async () => {
    const bing = await mutate(h.app, session, "POST", "/api/scans", {
      titleGroupId: groupId,
      engine: "bing",
      trigger: "manual",
    });
    expect(bing.statusCode).toBe(422);
    expect(bing.json().fieldErrors[0].path).toBe("/engine");

    await h.db.query(
      `INSERT INTO title_group
        (id, name, locales, scan_time, priority, created_at, updated_at)
       VALUES ('00000000-0000-7000-8000-000000000001', 'Other', '[]',
               '02:00:00', 'normal', $1, $1)`,
      [new Date()],
    );
    await h.db.query(
      `INSERT INTO tracked_title
        (id, title_group_id, release_year, title_type, runtime_minutes,
         original_variant_id, paused, merged_into_title_id, source,
         entered_by, entered_at, updated_by, created_at, updated_at)
       VALUES ('00000000-0000-7000-8000-000000000002',
               '00000000-0000-7000-8000-000000000001', 2000, 'film', NULL,
               NULL, false, NULL, 'operator_knowledge', 'operator', $1,
               'operator', $1, $1)`,
      [new Date()],
    );
    const wrongTitle = await mutate(h.app, session, "POST", "/api/scans", {
      titleGroupId: groupId,
      trackedTitleId: "00000000-0000-7000-8000-000000000002",
      trigger: "manual",
    });
    expect(wrongTitle.statusCode).toBe(422);
    expect(wrongTitle.json().fieldErrors[0].path).toBe("/trackedTitleId");
  });

  it("lists, reads, and exposes scan results and ladders", async () => {
    const queued = await mutate(h.app, session, "POST", "/api/scans", {
      titleGroupId: groupId,
      engine: "google",
      trigger: "manual",
    });
    const scanId = queued.json().scans[0].id;
    await h.db.query(
      "UPDATE scan SET state = 'succeeded', started_at = $2, finished_at = $2, issued_queries = 1 WHERE id = $1",
      [scanId, new Date("2026-11-04T03:00:00Z")],
    );
    await h.db.query(
      `INSERT INTO scan_query
        (id, scan_id, tracked_title_id, locale, kind, text, variant_id,
         intent_phrase_text, intent_phrase_version, ordinal)
       VALUES ('00000000-0000-7000-8000-000000000012', $1,
               '00000000-0000-7000-8000-000000000014', 'ru-RU', 'variant',
               'Ирония судьбы', NULL, NULL, NULL, 0)`,
      [scanId],
    );
    await h.db.query(
      `INSERT INTO search_result
        (id, scan_id, query_id, engine, url, normalized_url, rank, title,
         snippet, locale, territory, observed_at, raw_payload_ref, host,
         registrable_domain, candidate_id)
       VALUES ('00000000-0000-7000-8000-000000000011', $1, '00000000-0000-7000-8000-000000000012', 'google',
               'https://example.test/watch', 'example.test/watch', 1,
               'Title', 'Snippet', 'ru-RU', 'RU', $2, 'payload-1',
               'example.test', 'example.test', NULL)`,
      [scanId, new Date("2026-11-04T03:00:00Z")],
    );
    await h.db.query(
      `INSERT INTO recheck_schedule
        (id, title_group_id, engine, rung, started_at, next_due_at, active,
         started_by_scan_id, updated_at)
       VALUES ('00000000-0000-7000-8000-000000000013', $1, 'google', 1, $2, $2, true, $3, $2)`,
      [groupId, new Date("2026-11-04T03:00:00Z"), scanId],
    );

    const list = await read(h.app, session, "/api/scans");
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(1);
    expect(h.contract.validate("ScanPage", list.json()).valid).toBe(true);

    const single = await read(h.app, session, `/api/scans/${scanId}`);
    expect(single.statusCode).toBe(200);
    expect(single.json().lifecycle).toMatchObject({
      state: "succeeded",
      issuedQueries: 1,
    });
    expect(h.contract.validate("Scan", single.json()).valid).toBe(true);

    const results = await read(h.app, session, `/api/scans/${scanId}/results`);
    expect(results.statusCode).toBe(200);
    expect(results.json().items[0]).toMatchObject({
      url: "https://example.test/watch",
      rank: 1,
      host: "example.test",
    });
    expect(h.contract.validate("SearchResultPage", results.json()).issues).toEqual([]);

    const rechecks = await read(h.app, session, "/api/rechecks");
    expect(rechecks.statusCode).toBe(200);
    expect(rechecks.json().items[0]).toMatchObject({
      titleGroupId: groupId,
      engine: "google",
      rung: 1,
      active: true,
    });
    expect(
      h.contract.validate("RecheckSchedulePage", rechecks.json()).valid,
    ).toBe(true);
  });

  it("gates the scan reads behind bootstrap", async () => {
    const fresh = await harness();

    const response = await read(fresh.app, "unused", "/api/scans");
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("setup_required");
  });
});
