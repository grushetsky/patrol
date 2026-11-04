import { beforeEach, describe, expect, it } from "vitest";
import { ScanRunner } from "../src/acquisition/runner.js";
import { expireReservations, reserve } from "../src/acquisition/budget.js";
import {
  createDueRechecks,
  createDueScans,
  nextQueuedScan,
  probeBalances,
  probeRoutes,
  rollover,
  runNext,
} from "../src/acquisition/scheduler.js";
import { evaluateAlerts } from "../src/acquisition/budget.js";
import {
  AdapterError,
  type Engine,
  type PlannedQuery,
  type SearchAdapter,
  type SearchBatch,
} from "../src/acquisition/types.js";
import { memoryDb, seedCatalogue, seedScan } from "./support.js";
import type { Connectable } from "../src/db.js";

class FakeAdapter implements SearchAdapter {
  calls: PlannedQuery[] = [];

  constructor(
    readonly engine: Engine,
    private readonly handler: (
      query: PlannedQuery,
      attempt: number,
    ) => SearchBatch | Error,
  ) {}

  async search(query: PlannedQuery): Promise<SearchBatch> {
    this.calls.push(query);
    const attempt = this.calls.filter((item) => item.id === query.id).length;
    const result = this.handler(query, attempt);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }

  async probe(): Promise<void> {
    return;
  }
}

function iso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

function batch(query: PlannedQuery, count = 2): SearchBatch {
  return {
    rawBody: "{}",
    rows: Array.from({ length: count }, (_, index) => ({
      url: `https://www.Example.com/watch/?utm_source=x&b=2&a=1#frag${index}`,
      title: query.text,
      snippet: "Snippet",
      host: "www.example.com",
      position: index + 1,
      engine: query.locale === "ru-RU" ? "google" : "yandex",
      retrievedAt: "2026-11-04T03:01:00.000Z",
      rawRef: "",
    })),
  };
}

async function ledger(db: Connectable, engine = "google") {
  return (
    await db.query(
      "SELECT * FROM quota_ledger WHERE engine = $1",
      [engine],
    )
  ).rows[0];
}

describe("scan runner", () => {
  let db: Connectable;

  beforeEach(async () => {
    db = await memoryDb();
    await seedCatalogue(db);
  });

  it("plans, reserves, issues, stores, and commits a scan", async () => {
    const adapter = new FakeAdapter("google", (query) => batch(query));
    const runner = new ScanRunner(db, { google: adapter }, {
      now: () => new Date("2026-11-04T10:00:00Z"),
    });
    const scanId = await seedScan(db);

    const scan = await runner.run(scanId);

    expect(scan.state).toBe("succeeded");
    expect(scan.issued_queries).toBe(3);
    expect(adapter.calls).toHaveLength(3);
    const row = await ledger(db);
    expect(row.scan_reserved).toBe(0);
    expect(row.scan_committed).toBe(6);
    const reservation = (
      await db.query("SELECT * FROM budget_reservation WHERE scan_id = $1", [
        scanId,
      ])
    ).rows[0];
    expect(reservation).toMatchObject({
      state: "committed",
      units: 6,
      committed_units: 6,
      released_units: 0,
    });

    const stored = await db.query("SELECT * FROM search_result WHERE scan_id = $1", [
      scanId,
    ]);
    expect(stored.rows).toHaveLength(6);
    expect(stored.rows[0].normalized_url).toBe("example.com/watch?a=1&b=2");
    expect(stored.rows[0].registrable_domain).toBe("example.com");
    expect(
      (await db.query("SELECT * FROM serp_payload WHERE scan_id = $1", [scanId]))
        .rows,
    ).toHaveLength(3);
    expect(
      (await db.query("SELECT * FROM scan_query WHERE scan_id = $1", [scanId]))
        .rows,
    ).toHaveLength(3);
  });

  it("leaves a scan queued with budget_exhausted instead of truncating", async () => {
    await db.query("UPDATE acquisition_budget SET monthly_cap_minor = 0 WHERE engine = 'google'");
    await db.query("DELETE FROM quota_ledger");
    const adapter = new FakeAdapter("google", (query) => batch(query));
    const runner = new ScanRunner(db, { google: adapter }, {
      now: () => new Date("2026-11-04T10:00:00Z"),
    });
    const scanId = await seedScan(db);

    const scan = await runner.run(scanId);

    expect(scan.state).toBe("queued");
    const row = (
      await db.query("SELECT * FROM scan WHERE id = $1", [scanId])
    ).rows[0];
    expect(row.queued_reason).toBe("budget_exhausted");
    expect(Number(row.planned_queries)).toBe(3);
    expect(row.query_plan).toBeNull();
    expect(adapter.calls).toHaveLength(0);
    expect((await ledger(db)).scan_reserved).toBe(0);
  });

  it("releases an abandoned reservation after an hour", async () => {
    await db.query("DELETE FROM quota_ledger");
    await db.query(
      `INSERT INTO quota_ledger
        (id, engine, month_start, allowance_units, scan_reserved,
         scan_committed, recheck_reserved, recheck_committed)
       VALUES ('ledger', 'google', '2026-11-01', 10, 0, 0, 0, 0)`,
    );
    const now = new Date("2026-11-04T10:00:00Z");
    const scanId = await seedScan(db);
    await reserve(db, {
      scanId,
      engine: "google",
      bucket: "scan",
      units: 4,
      now,
    });

    await expireReservations(db, new Date(now.getTime() + 61 * 60 * 1000));

    const row = await ledger(db);
    expect(row.scan_reserved).toBe(0);
    expect(
      (
        await db.query("SELECT * FROM budget_reservation WHERE scan_id = $1", [
          scanId,
        ])
      ).rows[0].state,
    ).toBe("expired");
  });

  it("keeps a live scan's hold and requeues a stale one", async () => {
    await db.query("DELETE FROM quota_ledger");
    await db.query(
      `INSERT INTO quota_ledger
        (id, engine, month_start, allowance_units, scan_reserved,
         scan_committed, recheck_reserved, recheck_committed)
       VALUES ('ledger', 'google', '2026-11-01', 10, 0, 0, 0, 0)`,
    );
    const now = new Date("2026-11-04T10:00:00Z");
    const scanId = await seedScan(db, { state: "running" });
    await reserve(db, {
      scanId,
      engine: "google",
      bucket: "scan",
      units: 4,
      now,
    });
    await db.query(
      "UPDATE scan SET started_at = $2, last_heartbeat_at = $2 WHERE id = $1",
      [scanId, now],
    );

    await expireReservations(db, new Date(now.getTime() + 30 * 60 * 1000));
    expect((await ledger(db)).scan_reserved).toBe(4);

    await expireReservations(db, new Date(now.getTime() + 90 * 60 * 1000));
    expect((await ledger(db)).scan_reserved).toBe(0);
    expect(
      (
        await db.query("SELECT state FROM scan WHERE id = $1", [scanId])
      ).rows[0].state,
    ).toBe("queued");
  });

  it("keeps a spent re-check bucket away from the scan share", async () => {
    await db.query("DELETE FROM quota_ledger");
    await db.query(
      `INSERT INTO quota_ledger
        (id, engine, month_start, allowance_units, scan_reserved,
         scan_committed, recheck_reserved, recheck_committed)
       VALUES ('ledger', 'google', '2026-11-01', 80000, 0, 0, 0, 24000)`,
    );
    const adapter = new FakeAdapter("google", (query) => batch(query));
    const runner = new ScanRunner(db, { google: adapter }, {
      now: () => new Date("2026-11-04T10:00:00Z"),
    });

    const scan = await runner.run(
      await seedScan(db, { trigger: "recheck", dueDate: "2026-11-04" }),
    );

    expect(scan.state).toBe("queued");
    expect(adapter.calls).toHaveLength(0);
    const row = await ledger(db);
    expect(row.scan_reserved).toBe(0);
    expect(row.scan_committed).toBe(0);
    expect(row.recheck_reserved).toBe(0);
  });

  it("refuses a second reservation that would spend past the bucket", async () => {
    await db.query("DELETE FROM quota_ledger");
    await db.query(
      `INSERT INTO quota_ledger
        (id, engine, month_start, allowance_units, scan_reserved,
         scan_committed, recheck_reserved, recheck_committed)
       VALUES ('ledger', 'google', '2026-11-01', 10, 0, 0, 0, 0)`,
    );
    const now = new Date("2026-11-04T10:00:00Z");

    const first = await reserve(db, {
      scanId: "scan-a",
      engine: "google",
      bucket: "scan",
      units: 4,
      now,
    });
    const second = await reserve(db, {
      scanId: "scan-b",
      engine: "google",
      bucket: "scan",
      units: 4,
      now,
    });

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect((await ledger(db)).scan_reserved).toBe(4);
  });

  it("retries a retryable provider error at 1 and 5 minutes", async () => {
    await db.query("UPDATE title_group SET locales = '[\"ja-JP\"]'");
    const delays: number[] = [];
    const adapter = new FakeAdapter("google", (query, attempt) =>
      attempt < 3
        ? new AdapterError("retryable", "provider 503")
        : batch(query),
    );
    const runner = new ScanRunner(db, { google: adapter }, {
      now: () => new Date("2026-11-04T10:00:00Z"),
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });
    const scanId = await seedScan(db);

    const scan = await runner.run(scanId);

    expect(scan.state).toBe("succeeded");
    expect(adapter.calls).toHaveLength(3);
    expect(delays).toEqual([60_000, 300_000]);
  });

  it("retries at 1, 5, and 15 minutes before recording a failure", async () => {
    await db.query("UPDATE title_group SET locales = '[\"ja-JP\"]'");
    const delays: number[] = [];
    const adapter = new FakeAdapter(
      "google",
      () => new AdapterError("retryable", "provider 503"),
    );
    const runner = new ScanRunner(db, { google: adapter }, {
      now: () => new Date("2026-11-04T10:00:00Z"),
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    await runner.run(await seedScan(db));

    expect(delays).toEqual([60_000, 300_000, 900_000]);
  });

  it("fails a query after three attempts and releases its units", async () => {
    await db.query("UPDATE title_group SET locales = '[\"ja-JP\"]'");
    const adapter = new FakeAdapter(
      "google",
      () => new AdapterError("retryable", "provider 429"),
    );
    const runner = new ScanRunner(db, { google: adapter }, {
      now: () => new Date("2026-11-04T10:00:00Z"),
      sleep: async () => undefined,
    });
    const scanId = await seedScan(db);

    const scan = await runner.run(scanId);

    expect(scan.state).toBe("failed");
    const row = (
      await db.query("SELECT * FROM scan WHERE id = $1", [scanId])
    ).rows[0];
    expect(row.failure_reason).toBe("provider_error");
    expect(JSON.parse(String(row.failures))[0].attempts).toBe(4);
    const ledgerRow = await ledger(db);
    expect(ledgerRow.scan_reserved).toBe(0);
    expect(ledgerRow.scan_committed).toBe(0);
  });

  it("raises one warning when a scan finishes partially", async () => {
    const adapter = new FakeAdapter("google", (query) =>
      query.kind === "intent"
        ? new AdapterError("retryable", "provider 503")
        : batch(query, 1),
    );
    const runner = new ScanRunner(db, { google: adapter }, {
      now: () => new Date("2026-11-04T10:00:00Z"),
      sleep: async () => undefined,
    });

    const scan = await runner.run(await seedScan(db));

    expect(scan.state).toBe("partial");
    expect(
      (
        await db.query(
          "SELECT * FROM budget_alert WHERE threshold = 'partial'",
        )
      ).rows,
    ).toHaveLength(1);
  });

  it("disables a route on an authentication failure and refuses to run again", async () => {
    const adapter = new FakeAdapter(
      "google",
      () => new AdapterError("auth", "revoked key"),
    );
    const runner = new ScanRunner(db, { google: adapter }, {
      now: () => new Date("2026-11-04T10:00:00Z"),
    });
    const scanId = await seedScan(db);

    const scan = await runner.run(scanId);
    expect(scan.state).toBe("failed");
    expect(
      (await db.query("SELECT * FROM engine_route WHERE engine = 'google'"))
        .rows[0].disabled_at,
    ).toBeTruthy();

    const second = await runner.run(await seedScan(db, { dueDate: "2026-11-05" }));
    expect(second.state).toBe("failed");
    expect(adapter.calls).toHaveLength(1);
    expect((await ledger(db)).scan_committed).toBe(0);

    await probeRoutes(
      db,
      {
        google: {
          engine: "google",
          async search() {
            return { rows: [], rawBody: "" };
          },
          async probe() {
            return;
          },
        },
      },
      new Date("2026-11-04T11:00:00Z"),
    );
    expect(
      (await db.query("SELECT * FROM engine_route WHERE engine = 'google'"))
        .rows[0].disabled_at,
    ).toBeNull();
  });

  it("reissues the plan of the scan that started the ladder", async () => {
    await db.query(
      `INSERT INTO violation (id, tracked_title_id, state, engine, title_group_id)
       VALUES ('violation-plan', 'title-1', 'open', 'google', 'group-1')`,
    );
    const adapter = new FakeAdapter("google", (query) => batch(query, 1));
    const firstScan = await seedScan(db, { dueDate: "2026-11-04" });
    await new ScanRunner(db, { google: adapter }, {
      now: () => new Date("2026-11-04T10:00:00Z"),
    }).run(firstScan);
    const original = JSON.parse(
      String(
        (
          await db.query("SELECT query_plan FROM scan WHERE id = $1", [firstScan])
        ).rows[0].query_plan,
      ),
    ) as { queries: Array<{ text: string }> };

    await db.query("UPDATE title_group SET locales = '[\"en-US\"]'");
    const recheckScan = await seedScan(db, {
      trigger: "recheck",
      dueDate: "2026-11-07",
    });
    await new ScanRunner(db, { google: adapter }, {
      now: () => new Date("2026-11-07T10:00:00Z"),
    }).run(recheckScan);
    const reissued = JSON.parse(
      String(
        (
          await db.query("SELECT query_plan FROM scan WHERE id = $1", [
            recheckScan,
          ])
        ).rows[0].query_plan,
      ),
    ) as { queries: Array<{ text: string }> };

    expect(reissued.queries.map((query) => query.text)).toEqual(
      original.queries.map((query) => query.text),
    );
  });

  it("moves the re-check ladder 3, 7, 14, then every 14 days and resets manually", async () => {
    await db.query(
      `INSERT INTO violation (id, tracked_title_id, state, engine, title_group_id)
       VALUES ('violation-1', 'title-1', 'open', 'google', 'group-1')`,
    );
    const adapter = new FakeAdapter("google", (query) => batch(query, 1));
    const first = new ScanRunner(db, { google: adapter }, {
      now: () => new Date("2026-11-04T10:00:00Z"),
    });
    await first.run(await seedScan(db, { dueDate: "2026-11-04" }));
    let ladder = (
      await db.query("SELECT * FROM recheck_schedule WHERE title_group_id = 'group-1'")
    ).rows[0];
    expect(ladder).toMatchObject({ rung: 1, active: true });
    expect(iso(ladder.next_due_at)).toContain("2026-11-07");

    await new ScanRunner(db, { google: adapter }, {
      now: () => new Date("2026-11-07T10:00:00Z"),
    }).run(await seedScan(db, { trigger: "recheck", dueDate: "2026-11-07" }));
    ladder = (
      await db.query("SELECT * FROM recheck_schedule WHERE title_group_id = 'group-1'")
    ).rows[0];
    expect(ladder.rung).toBe(2);
    expect(iso(ladder.next_due_at)).toContain("2026-11-11");

    await new ScanRunner(db, { google: adapter }, {
      now: () => new Date("2026-11-11T10:00:00Z"),
    }).run(await seedScan(db, { trigger: "recheck", dueDate: "2026-11-11" }));
    ladder = (
      await db.query("SELECT * FROM recheck_schedule WHERE title_group_id = 'group-1'")
    ).rows[0];
    expect(ladder.rung).toBe(3);
    expect(iso(ladder.next_due_at)).toContain("2026-11-18");

    await new ScanRunner(db, { google: adapter }, {
      now: () => new Date("2026-11-12T10:00:00Z"),
    }).run(await seedScan(db, { trigger: "manual", dueDate: "2026-11-12" }));
    ladder = (
      await db.query("SELECT * FROM recheck_schedule WHERE title_group_id = 'group-1'")
    ).rows[0];
    expect(ladder.rung).toBe(1);
    expect(iso(ladder.next_due_at)).toContain("2026-11-15");

    await db.query("UPDATE violation SET state = 'closed' WHERE id = 'violation-1'");
    await new ScanRunner(db, { google: adapter }, {
      now: () => new Date("2026-11-15T10:00:00Z"),
    }).run(await seedScan(db, { trigger: "recheck", dueDate: "2026-11-15" }));
    ladder = (
      await db.query("SELECT * FROM recheck_schedule WHERE title_group_id = 'group-1'")
    ).rows[0];
    expect(ladder.active).toBe(false);
  });
});

describe("scheduler", () => {
  let db: Connectable;

  beforeEach(async () => {
    db = await memoryDb();
    await seedCatalogue(db);
  });

  it("creates one scan per group and engine per day", async () => {
    const now = new Date("2026-11-04T03:00:00Z");

    expect(await createDueScans(db, now)).toBe(2);
    expect(await createDueScans(db, now)).toBe(0);
    expect((await db.query("SELECT * FROM scan")).rows).toHaveLength(2);
  });

  it("orders manual work by request time before scheduled priority", async () => {
    const now = new Date("2026-11-04T03:00:00Z");
    await db.query(
      `INSERT INTO title_group
        (id, name, locales, scan_time, priority, created_at, updated_at)
       VALUES ('group-high', 'High', '[\"ru-RU\"]', '01:00:00', 'high',
               $1, $1), ('group-low', 'Low', '[\"ru-RU\"]', '01:00:00', 'low',
               $1, $1)`,
      [now],
    );
    await seedScan(db, { groupId: "group-low", dueDate: "2026-11-04" });
    await seedScan(db, {
      groupId: "group-high",
      trigger: "manual",
      dueDate: "2026-11-05",
      createdAt: new Date("2026-11-04T03:05:00Z"),
    });
    const earlier = await seedScan(db, {
      groupId: "group-low",
      trigger: "manual",
      dueDate: "2026-11-03",
      createdAt: new Date("2026-11-04T03:01:00Z"),
    });

    const next = await nextQueuedScan(db, "google");
    expect(next?.id).toBe(earlier);
  });

  it("skips a queued scan the caller could not afford", async () => {
    const first = await seedScan(db);
    const second = await seedScan(db, { dueDate: "2026-11-05" });

    const next = await nextQueuedScan(db, "google", { exclude: [first] });

    expect(next?.id).toBe(second);
  });

  it("stops low-priority scheduled work at ninety percent of the scan share", async () => {
    const now = new Date("2026-11-04T03:00:00Z");
    await db.query(
      `INSERT INTO title_group
        (id, name, locales, scan_time, priority, created_at, updated_at)
       VALUES ('group-low', 'Low', '[\"ru-RU\"]', '01:00:00', 'low',
               $1, $1)`,
      [now],
    );
    await seedScan(db, { groupId: "group-low", trigger: "scheduled" });
    await seedScan(db, {
      groupId: "group-1",
      trigger: "scheduled",
      dueDate: "2026-11-03",
    });
    await db.query("DELETE FROM quota_ledger");
    await db.query(
      `INSERT INTO quota_ledger
        (id, engine, month_start, allowance_units, scan_reserved,
         scan_committed, recheck_reserved, recheck_committed)
       VALUES ('ledger', 'google', '2026-11-01', 80000, 0, 50400, 0, 0)`,
    );

    const normal = await nextQueuedScan(db, "google", {
      now,
      allowLowPriority: false,
    });
    expect(normal?.title_group_id).toBe("group-1");
  });

  it("re-runs an interrupted scan once its reservation has expired", async () => {
    const scanId = await seedScan(db, { state: "running" });
    const adapter = new FakeAdapter("google", (query) => batch(query));
    const runner = new ScanRunner(db, { google: adapter }, {
      now: () => new Date("2026-11-04T10:00:00Z"),
    });

    const scan = await runNext(db, runner, "google");

    expect(scan?.id).toBe(scanId);
    expect(scan?.state).toBe("succeeded");
  });

  it("alerts on a thin provider balance and disables an empty one", async () => {
    const adapter: SearchAdapter = {
      engine: "google",
      async search() {
        return { rows: [], rawBody: "" };
      },
      async probe() {
        return;
      },
      async balanceMinor() {
        return 0;
      },
    };
    const runner = new ScanRunner(db, { google: adapter });

    await probeBalances(db, runner, { google: adapter }, new Date("2026-11-04T10:00:00Z"));

    expect(
      (
        await db.query(
          "SELECT * FROM budget_alert WHERE threshold = 'balance'",
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await db.query("SELECT * FROM engine_route WHERE engine = 'google'")
      ).rows[0].disabled_at,
    ).toBeTruthy();
  });

  it("hands a due ladder to a re-check instead of the scheduled scan", async () => {
    const now = new Date("2026-11-04T10:00:00Z");
    await db.query(
      `INSERT INTO recheck_schedule
        (id, title_group_id, engine, rung, started_at, next_due_at, active,
         started_by_scan_id, updated_at)
       VALUES ('ladder', 'group-1', 'google', 1, $1, $1, true, 'scan-1', $1)`,
      [new Date("2026-11-01T10:00:00Z")],
    );

    expect(await createDueScans(db, now)).toBe(1);
    expect(await createDueRechecks(db, now)).toBe(1);
    const scan = (
      await db.query("SELECT * FROM scan WHERE engine = 'google'")
    ).rows[0];
    expect(scan.trigger).toBe("recheck");
  });

  it("converts a queued same-day scheduled scan into the due re-check", async () => {
    const now = new Date("2026-11-04T10:00:00Z");
    await db.query(
      `INSERT INTO recheck_schedule
        (id, title_group_id, engine, rung, started_at, next_due_at, active,
         started_by_scan_id, updated_at)
       VALUES ('ladder', 'group-1', 'google', 1, $1, $1, true, 'scan-1', $1)`,
      [new Date("2026-11-01T10:00:00Z")],
    );
    const scheduled = await seedScan(db, {
      trigger: "scheduled",
      dueDate: "2026-11-04",
    });

    expect(await createDueRechecks(db, now)).toBe(0);

    const scan = (await db.query("SELECT * FROM scan WHERE id = $1", [scheduled]))
      .rows[0];
    expect(scan.trigger).toBe("recheck");
  });

  it("creates a re-check scan when a ladder is due", async () => {
    const now = new Date("2026-11-04T10:00:00Z");
    await db.query(
      `INSERT INTO recheck_schedule
        (id, title_group_id, engine, rung, started_at, next_due_at, active,
         started_by_scan_id, updated_at)
       VALUES ('ladder', 'group-1', 'google', 1, $1, $1, true, 'scan-1', $1)`,
      [new Date("2026-11-01T10:00:00Z")],
    );

    expect(await createDueRechecks(db, now)).toBe(1);
    expect(await createDueRechecks(db, now)).toBe(0);
    const scan = (await db.query("SELECT * FROM scan")).rows[0];
    expect(scan.trigger).toBe("recheck");
  });

  it("opens the next month's ledger without touching the closed one", async () => {
    const november = new Date("2026-11-15T10:00:00Z");
    await rollover(db, november);
    const december = new Date("2026-12-01T00:00:00Z");
    await rollover(db, december);

    const rows = (
      await db.query("SELECT month_start FROM quota_ledger ORDER BY month_start")
    ).rows.map((row) => String(row.month_start));
    expect(rows.filter((month) => month === "2026-11-01")).toHaveLength(3);
    expect(rows.filter((month) => month === "2026-12-01")).toHaveLength(3);
  });

  it("fires each alert once per threshold and month", async () => {
    await db.query("DELETE FROM quota_ledger");
    await db.query(
      `INSERT INTO quota_ledger
        (id, engine, month_start, allowance_units, scan_reserved,
         scan_committed, recheck_reserved, recheck_committed)
       VALUES ('ledger', 'google', '2026-11-01', 80000, 0, 56000, 0, 24000)`,
    );
    const now = new Date("2026-11-15T10:00:00Z");

    await evaluateAlerts(db, "google", now);
    await evaluateAlerts(db, "google", now);

    const alerts = (await db.query("SELECT * FROM budget_alert")).rows;
    expect(alerts).toHaveLength(5);
    expect(
      alerts.filter((alert) => alert.level === "critical"),
    ).toHaveLength(4);
  });
});
