import { beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  clearHostObjection,
  enqueueCapture,
  readCapture,
  readEvidence,
  recordHostObjection,
} from "@patrol/evidence";
import { runCapture } from "../../src/capture/runner.js";
import type { PageObservation } from "../../src/capture/browser.js";
import { controlledClock, seedWorld, testPool, type SeededWorld } from "./helpers.js";
import {
  MemoryStore,
  baseObservation,
  capturedObservation,
  noopDispatch,
  runnerDeps,
} from "./capture-helpers.js";

/**
 * Seams 4 and the enqueue port's own rules, over the real record: an
 * allowlisted URL is never fetched and never becomes evidence; a host
 * under an active objection is refused at the enqueue and skipped at run
 * time, the objection is never deleted, and an operator's clearance
 * reopens the host; review and pre_handoff respect their freshness
 * windows; and one capture point holds one fetch.
 */

let pool: Pool;
let world: SeededWorld;

beforeAll(async () => {
  pool = testPool();
  world = await seedWorld(pool);
});

const CLOCK = "2026-05-01T10:00:00.000Z";

async function addOfficialDomain(value: string): Promise<void> {
  const operator = await pool.query<{ id: string }>(
    "select id from operators limit 1",
  );
  await pool.query(
    `insert into allowlist_entries
       (kind, match_kind, value, scope, origin, confirmed_by, confirmed_at)
     values ('official_domain', 'host', $1, 'rights_holder', 'operator', $2, $3)`,
    [value, operator.rows[0].id, CLOCK],
  );
}

async function fetchSpy(): Promise<{
  fetches: string[];
  run: (captureId: string) => Promise<void>;
}> {
  const fetches: string[] = [];
  const clock = controlledClock(CLOCK);
  const deps = runnerDeps(pool, clock, new MemoryStore(), async (target) => {
    fetches.push(target);
    return capturedObservation(target);
  });
  return { fetches, run: (captureId) => runCapture(deps, captureId, () => {}) };
}

describe("the allowlist guard before any fetch (seam 4)", () => {
  it("never fetches an allowlisted URL and never creates an evidence row", async () => {
    await addOfficialDomain("official.example.test");
    const clock = controlledClock(CLOCK);
    const enqueued = await enqueueCapture(
      { pool, now: clock.now, dispatch: noopDispatch },
      { url: "https://official.example.test/library", reason: "detection" },
    );
    expect(enqueued.status).toBe("skipped_allowlist");

    const capture = await readCapture(pool, (enqueued as { captureId: string }).captureId);
    expect(capture?.state).toBe("skipped");
    expect(capture?.skipReason).toBe("allowlist");

    // The fetch spy stays at zero: Patrol does not touch the domain at all.
    const spy = await fetchSpy();
    await spy.run((enqueued as { captureId: string }).captureId);
    expect(spy.fetches).toEqual([]);

    const evidence = await pool.query("select * from evidence");
    expect(evidence.rows).toHaveLength(0);
  });

  it("skips at run time an entry that landed after the enqueue", async () => {
    const clock = controlledClock(CLOCK);
    const enqueued = await enqueueCapture(
      { pool, now: clock.now, dispatch: noopDispatch },
      { url: "https://late-allowlist.example.test/watch", reason: "detection" },
    );
    if (enqueued.status !== "queued") {
      throw new Error(`unexpected enqueue status ${enqueued.status}`);
    }
    await addOfficialDomain("late-allowlist.example.test");
    const spy = await fetchSpy();
    await spy.run(enqueued.captureId);
    expect(spy.fetches).toEqual([]);
    const capture = await readCapture(pool, enqueued.captureId);
    expect(capture?.state).toBe("done");
    expect(capture?.skipReason).toBe("allowlist");
  });

  it("applies the pair's scoped entries when the enqueue carries the title context", async () => {
    const operator = await pool.query<{ id: string }>(
      "select id from operators limit 1",
    );
    // A licensed destination scoped to the seeded title, licensed for the
    // US only, and a neutral source scoped to the seeded title group.
    await pool.query(
      `insert into allowlist_entries
         (kind, match_kind, value, scope, tracked_title_id, territory, origin, confirmed_by, confirmed_at)
       values ('licensed_destination', 'host', 'licensed-scoped.example.test', 'tracked_title', $1, 'US', 'operator', $2, $3)`,
      [world.titleId, operator.rows[0].id, CLOCK],
    );
    await pool.query(
      `insert into allowlist_entries
         (kind, match_kind, value, scope, title_group_id, origin, confirmed_by, confirmed_at)
       values ('neutral_source', 'host', 'neutral-scoped.example.test', 'title_group', $1, 'operator', $2, $3)`,
      [world.groupId, operator.rows[0].id, CLOCK],
    );
    const clock = controlledClock(CLOCK);
    const deps = { pool, now: clock.now, dispatch: noopDispatch };

    // Without a title context only rights-holder entries apply: both
    // scoped hosts enqueue.
    const bareLicensed = await enqueueCapture(deps, {
      url: "https://licensed-scoped.example.test/watch",
      reason: "detection",
    });
    expect(bareLicensed.status).toBe("queued");
    const bareNeutral = await enqueueCapture(deps, {
      url: "https://neutral-scoped.example.test/watch",
      reason: "detection",
    });
    expect(bareNeutral.status).toBe("queued");

    // With the candidate's context the scoped entries join the guard: the
    // licensed destination in its territory and the group's neutral source
    // are never fetched.
    const scopedLicensed = await enqueueCapture(deps, {
      url: "https://licensed-scoped.example.test/other",
      reason: "detection",
      context: {
        titleGroupId: world.groupId,
        trackedTitleId: world.titleId,
        territory: "US",
      },
    });
    expect(scopedLicensed.status).toBe("skipped_allowlist");
    const scopedNeutral = await enqueueCapture(deps, {
      url: "https://neutral-scoped.example.test/other",
      reason: "detection",
      context: {
        titleGroupId: world.groupId,
        trackedTitleId: world.titleId,
        territory: "US",
      },
    });
    expect(scopedNeutral.status).toBe("skipped_allowlist");

    // A licensed destination outside its territory does not apply.
    const elsewhere = await enqueueCapture(deps, {
      url: "https://licensed-scoped.example.test/third",
      reason: "detection",
      context: {
        titleGroupId: world.groupId,
        trackedTitleId: world.titleId,
        territory: "DE",
      },
    });
    expect(elsewhere.status).toBe("queued");
  });
});

describe("the host objection guard (seam 4)", () => {
  const HOST = "objecting.example.test";

  async function activeObjection(): Promise<string> {
    const row = await recordHostObjection(pool, () => new Date(CLOCK), {
      host: HOST,
      source: "operator",
      reason: "The host sent a cease-and-desist naming Patrol.",
      affectedCandidateCount: 3,
    });
    return row.id;
  }

  it("refuses the enqueue of a host under an active objection", async () => {
    const objectionId = await activeObjection();
    const clock = controlledClock(CLOCK);
    const refused = await enqueueCapture(
      { pool, now: clock.now, dispatch: noopDispatch },
      { url: `https://${HOST}/watch`, reason: "review" },
    );
    expect(refused).toEqual({ status: "refused", hostObjectionId: objectionId });
    // No capture row and no evidence row were created.
    const captures = await pool.query("select * from captures where requested_url = $1", [
      `https://${HOST}/watch`,
    ]);
    expect(captures.rows).toHaveLength(0);
  });

  it("covers the objection's subdomains but not its siblings", async () => {
    await activeObjection();
    const clock = controlledClock(CLOCK);
    const refused = await enqueueCapture(
      { pool, now: clock.now, dispatch: noopDispatch },
      { url: "https://www.objecting.example.test/watch", reason: "detection" },
    );
    expect(refused.status).toBe("refused");
    // A sibling subdomain is not the host that objected.
    const sibling = await enqueueCapture(
      { pool, now: clock.now, dispatch: noopDispatch },
      { url: "https://sibling.example.test/watch", reason: "detection" },
    );
    expect(sibling.status).toBe("queued");
  });

  it("skips at run time an objection that landed after the enqueue", async () => {
    // A host no earlier test has objected about, so the enqueue stands.
    const host = "late-objection.example.test";
    const clock = controlledClock(CLOCK);
    const enqueued = await enqueueCapture(
      { pool, now: clock.now, dispatch: noopDispatch },
      { url: `https://${host}/queued-first`, reason: "detection" },
    );
    if (enqueued.status !== "queued") {
      throw new Error(`unexpected enqueue status ${enqueued.status}`);
    }
    await recordHostObjection(pool, () => new Date(CLOCK), {
      host,
      source: "operator",
      reason: "A later complaint.",
      affectedCandidateCount: 0,
    });
    const spy = await fetchSpy();
    await spy.run(enqueued.captureId);
    expect(spy.fetches).toEqual([]);
    const capture = await readCapture(pool, enqueued.captureId);
    expect(capture?.state).toBe("done");
    expect(capture?.skipReason).toBe("host_objection");
  });

  it("an operator's clearance reopens the host to capture", async () => {
    const objectionId = await activeObjection();
    const cleared = await clearHostObjection(pool, () => new Date(CLOCK), {
      hostObjectionId: objectionId,
      operatorId: (await pool.query<{ id: string }>("select id from operators limit 1")).rows[0].id,
      reason: "The host and the rights holder resolved the complaint.",
    });
    expect(cleared.status).toBe("cleared");
    if (cleared.status !== "cleared") {
      throw new Error("objection was not cleared");
    }
    expect(cleared.row.clearedAt).not.toBeNull();
    expect(cleared.row.clearanceReason).toContain("resolved");

    // The cleared objection no longer refuses the host...
    const clock = controlledClock(CLOCK);
    const queued = await enqueueCapture(
      { pool, now: clock.now, dispatch: noopDispatch },
      { url: `https://${HOST}/after-clearance`, reason: "detection" },
    );
    expect(queued.status).toBe("queued");

    // ...and a new objection may be recorded later (at most one active).
    const again = await recordHostObjection(pool, () => new Date(CLOCK), {
      host: HOST,
      source: "operator",
      reason: "A second complaint.",
      affectedCandidateCount: 1,
    });
    expect(again.reason).toBe("A second complaint.");
    const rows = await pool.query("select * from host_objections where host = $1", [HOST]);
    expect(rows.rows).toHaveLength(2);
    const active = rows.rows.filter((row) => row.cleared_at === null);
    expect(active).toHaveLength(1);
  });
});

describe("the host objection trigger (a blocked response naming Patrol)", () => {
  /** A blocked observation of one status and body. */
  function blockedResponse(url: string, status: number, body: string): PageObservation {
    return {
      ...baseObservation(url),
      finalUrl: url,
      httpStatus: status,
      headers: { "content-type": "text/html" },
      rawBody: new TextEncoder().encode(body),
      pageHost: new URL(url).hostname,
    };
  }

  async function objectionsFor(host: string): Promise<number> {
    const rows = await pool.query("select * from host_objections where host = $1", [host]);
    return rows.rows.length;
  }

  it("records the objection when a 451 body names Patrol", async () => {
    const clock = controlledClock(CLOCK);
    const host = "named-451.example.test";
    const url = `https://${host}/watch`;
    const enqueued = await enqueueCapture(
      { pool, now: clock.now, dispatch: noopDispatch },
      { url, reason: "detection" },
    );
    if (enqueued.status !== "queued") {
      throw new Error(`unexpected enqueue status ${enqueued.status}`);
    }
    await runCapture(
      runnerDeps(
        pool,
        clock,
        new MemoryStore(),
        async () =>
          blockedResponse(
            url,
            451,
            "Taken down following a cease and desist notice naming Patrol.",
          ),
      ),
      enqueued.captureId,
      () => {},
    );
    expect(await objectionsFor(host)).toBe(1);
    // A blocked first attempt is recorded and retried: pending, not done.
    const capture = await readCapture(pool, enqueued.captureId);
    expect(capture?.state).toBe("pending");
    expect(capture?.attemptCount).toBe(1);
    expect(capture?.evidenceId).not.toBeNull();
  });

  it("records no objection on a bare 451 that names no one", async () => {
    const clock = controlledClock(CLOCK);
    const host = "bare-451.example.test";
    const url = `https://${host}/watch`;
    const enqueued = await enqueueCapture(
      { pool, now: clock.now, dispatch: noopDispatch },
      { url, reason: "detection" },
    );
    if (enqueued.status !== "queued") {
      throw new Error(`unexpected enqueue status ${enqueued.status}`);
    }
    await runCapture(
      runnerDeps(
        pool,
        clock,
        new MemoryStore(),
        async () => blockedResponse(url, 451, "This page is not available in your region."),
      ),
      enqueued.captureId,
      () => {},
    );
    // Blocked, recorded, and suspended nowhere: the status alone is not
    // Patrol's individualized objection.
    expect(await objectionsFor(host)).toBe(0);
    const capture = await readCapture(pool, enqueued.captureId);
    expect(capture?.state).toBe("pending");
    expect(capture?.evidenceId).not.toBeNull();
    const evidence = (await readEvidence(pool, capture!.evidenceId!))!;
    expect(evidence.evidence.outcome).toBe("blocked");
    expect(evidence.evidence.failureReason).toBe("http_451");
  });

  it("records the objection when a non-451 block names Patrol", async () => {
    const clock = controlledClock(CLOCK);
    const host = "named-403.example.test";
    const url = `https://${host}/watch`;
    const enqueued = await enqueueCapture(
      { pool, now: clock.now, dispatch: noopDispatch },
      { url, reason: "detection" },
    );
    if (enqueued.status !== "queued") {
      throw new Error(`unexpected enqueue status ${enqueued.status}`);
    }
    await runCapture(
      runnerDeps(
        pool,
        clock,
        new MemoryStore(),
        async () =>
          blockedResponse(
            url,
            403,
            "Access denied by a block notice issued to Patrol.",
          ),
      ),
      enqueued.captureId,
      () => {},
    );
    expect(await objectionsFor(host)).toBe(1);
  });
});

describe("the capture point rules (enqueue port)", () => {
  it("holds one fetch per URL per capture point", async () => {
    const clock = controlledClock(CLOCK);
    const deps = { pool, now: clock.now, dispatch: noopDispatch };
    const first = await enqueueCapture(deps, {
      url: "https://point.example.test/watch",
      reason: "review",
    });
    const second = await enqueueCapture(deps, {
      url: "https://point.example.test/watch",
      reason: "review",
    });
    expect(first.status).toBe("queued");
    expect(second.status).toBe("exists");
    if (first.status === "queued" && second.status === "exists") {
      expect(second.captureId).toBe(first.captureId);
    }
    const rows = await pool.query("select * from captures where normalized_url = $1", [
      "point.example.test/watch",
    ]);
    expect(rows.rows).toHaveLength(1);
  });

  it("opens a new review point once the 24-hour window has passed", async () => {
    const clock = controlledClock(CLOCK);
    const url = "https://fresh.example.test/watch";
    const first = await enqueueCapture({ pool, now: clock.now, dispatch: noopDispatch }, { url, reason: "review" });
    expect(first.status).toBe("queued");
    // A live capture inside the window pins the existing record.
    await pool.query(
      `insert into evidence
         (capture_id, requested_url, normalized_url, reason, outcome, attempt_number, observed_at, capture_profile)
       values ($1, $2, $3, 'review', 'captured', 1, $4, '{}'::jsonb)`,
      [(first as { captureId: string }).captureId, url, "fresh.example.test/watch", clock.now()],
    );
    const sameDay = await enqueueCapture({ pool, now: clock.now, dispatch: noopDispatch }, { url, reason: "review" });
    expect(sameDay.status).toBe("fresh");

    clock.advance(25 * 60 * 60 * 1000);
    const nextDay = await enqueueCapture({ pool, now: clock.now, dispatch: noopDispatch }, { url, reason: "review" });
    expect(nextDay.status).toBe("queued");
  });

  it("treats detection as its own instant and pre_handoff as the 7-day bucket", async () => {
    const clock = controlledClock(CLOCK);
    const deps = { pool, now: clock.now, dispatch: noopDispatch };
    const one = await enqueueCapture(deps, { url: "https://instants.example.test/a", reason: "detection" });
    // A second formation is a later instant: the clock moved between them.
    clock.advance(1_000);
    const two = await enqueueCapture(deps, { url: "https://instants.example.test/a", reason: "detection" });
    expect(one.status).toBe("queued");
    expect(two.status).toBe("queued");
    const preOne = await enqueueCapture(deps, { url: "https://instants.example.test/b", reason: "pre_handoff" });
    const preTwo = await enqueueCapture(deps, { url: "https://instants.example.test/b", reason: "pre_handoff" });
    expect(preOne.status).toBe("queued");
    expect(preTwo.status).toBe("exists");
    if (preOne.status === "queued" && preTwo.status === "exists") {
      expect(preTwo.captureId).toBe(preOne.captureId);
    }
  });
});
