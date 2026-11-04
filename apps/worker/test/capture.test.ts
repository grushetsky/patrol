import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { CaptureRunner, retryDelay } from "../src/evidence/runner.js";
import { HostLimiter } from "../src/evidence/limiter.js";
import {
  artifactKey,
  type CaptureStore,
  type StoredObject,
} from "../src/evidence/store.js";
import type {
  BrowserCapture,
  BrowserCaptureResult,
} from "../src/evidence/types.js";
import type { Connectable } from "../src/db.js";
import { memoryDb } from "./support.js";

const URL_UNDER_TEST = "https://example.test/watch?id=1";
const NOW = new Date("2026-11-04T12:00:00Z");

class MemoryStore implements CaptureStore {
  readonly objects = new Map<string, Buffer>();

  async put(input: {
    kind: string;
    sha256: string;
    body: Buffer;
  }): Promise<StoredObject> {
    const key = artifactKey(input.kind, input.sha256);
    if (!this.objects.has(key)) {
      this.objects.set(key, input.body);
    }
    return { key, version: "1" };
  }
}

class FakeBrowser implements BrowserCapture {
  calls = 0;

  constructor(
    private readonly result:
      | BrowserCaptureResult
      | (() => Promise<BrowserCaptureResult>),
  ) {}

  async capture(): Promise<BrowserCaptureResult> {
    this.calls += 1;
    return typeof this.result === "function"
      ? this.result()
      : this.result;
  }
}

function captured(overrides: Partial<BrowserCaptureResult> = {}): BrowserCaptureResult {
  return {
    outcome: "captured",
    redirectChain: [
      {
        url: "https://short.test/abc",
        statusCode: 301,
        location: URL_UNDER_TEST,
      },
      { url: URL_UNDER_TEST, statusCode: 200 },
    ],
    finalUrl: URL_UNDER_TEST,
    host: "example.test",
    httpStatus: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": "session=secret",
      "x-server": "nginx",
    },
    responseBody: Buffer.from("<html>body</html>"),
    dom: "<html><body>rendered</body></html>",
    domTruncated: false,
    screenshot: {
      bytes: Buffer.from("png-bytes"),
      width: 1365,
      height: 900,
      truncated: false,
    },
    thumbnail: {
      bytes: Buffer.from("jpeg-bytes"),
      width: 1365,
      height: 900,
      truncated: false,
    },
    sidecar: { title: "Movie", h1: ["Movie"] },
    ...overrides,
  };
}

async function evidenceRows(db: Connectable) {
  return (await db.query("SELECT * FROM evidence ORDER BY observed_at ASC")).rows;
}

async function artifactRows(db: Connectable) {
  return (
    await db.query("SELECT * FROM evidence_artifact ORDER BY kind ASC")
  ).rows;
}

describe("capture runner", () => {
  let db: Connectable;

  beforeEach(async () => {
    db = await memoryDb();
  });

  it("stores a captured bundle, its redirects, and its hashes", async () => {
    const browser = new FakeBrowser(captured());
    const store = new MemoryStore();
    const runner = new CaptureRunner(db, browser, store, { now: () => NOW });

    const result = await runner.capture({
      url: "https://short.test/abc",
      reason: "detection",
    });

    expect(result.captured).toBe(true);
    expect(browser.calls).toBe(1);
    const [evidence] = await evidenceRows(db);
    expect(evidence).toMatchObject({
      requested_url: "https://short.test/abc",
      normalized_requested_url: "short.test/abc",
      final_url: URL_UNDER_TEST,
      host: "example.test",
      host_source: "landing_page",
      reason: "detection",
      outcome: "captured",
      http_status: 200,
      attempt_number: 1,
    });
    expect(JSON.parse(String(evidence.redirect_chain))).toHaveLength(2);
    const artifacts = await artifactRows(db);
    expect(artifacts.map((artifact) => artifact.kind)).toEqual([
      "extraction_sidecar",
      "rendered_dom",
      "response_body",
      "response_headers",
      "screenshot",
      "thumbnail",
    ]);
    expect(artifacts.every((artifact) => artifact.truncated === false)).toBe(true);
    const body = artifacts.find((artifact) => artifact.kind === "response_body");
    expect(body?.sha256).toBe(
      createHash("sha256").update("<html>body</html>").digest("hex"),
    );
    const headers = artifacts.find(
      (artifact) => artifact.kind === "response_headers",
    );
    expect(headers?.sha256).toBe(
      createHash("sha256")
        .update(
          JSON.stringify({
            "content-type": "text/html; charset=utf-8",
            "x-server": "nginx",
          }),
        )
        .digest("hex"),
    );
    expect(store.objects.size).toBe(6);
    const thumbnail = artifacts.find((artifact) => artifact.kind === "thumbnail");
    expect(thumbnail?.object_key).toContain("derived/thumbnail/sha256/");
  });

  it("records an absence without blobs when the page is dead", async () => {
    const runner = new CaptureRunner(
      db,
      new FakeBrowser({
        outcome: "dead",
        redirectChain: [{ url: URL_UNDER_TEST, statusCode: 404 }],
        finalUrl: URL_UNDER_TEST,
        host: "example.test",
        httpStatus: 404,
        failureReason: "http_404",
        domTruncated: false,
      }),
      new MemoryStore(),
      { now: () => NOW },
    );

    const result = await runner.capture({
      url: URL_UNDER_TEST,
      reason: "detection",
    });

    expect(result).toMatchObject({ captured: true, outcome: "dead" });
    const [evidence] = await evidenceRows(db);
    expect(evidence.outcome).toBe("dead");
    expect(evidence.failure_reason).toBe("http_404");
    expect(await artifactRows(db)).toEqual([]);
  });

  it("records a blocked page with the body it did return", async () => {
    const runner = new CaptureRunner(
      db,
      new FakeBrowser(
        captured({
          outcome: "blocked",
          httpStatus: 403,
          failureReason: "http_403",
          dom: "<html>forbidden</html>",
          screenshot: undefined,
          thumbnail: undefined,
          sidecar: undefined,
        }),
      ),
      new MemoryStore(),
      { now: () => NOW },
    );

    const result = await runner.capture({
      url: URL_UNDER_TEST,
      reason: "review",
    });

    expect(result).toMatchObject({ captured: true, outcome: "blocked" });
    const kinds = (await artifactRows(db)).map((row) => row.kind);
    expect(kinds).toContain("response_body");
    expect(kinds).not.toContain("screenshot");
  });

  it("records an error when the browser crashes", async () => {
    const runner = new CaptureRunner(
      db,
      new FakeBrowser(async () => {
        throw new Error("navigation crashed");
      }),
      new MemoryStore(),
      { now: () => NOW },
    );

    const result = await runner.capture({
      url: URL_UNDER_TEST,
      reason: "detection",
    });

    expect(result).toMatchObject({ captured: true, outcome: "error" });
    const [evidence] = await evidenceRows(db);
    expect(evidence.failure_reason).toBe("navigation crashed");
  });

  it("flags truncation on the DOM and screenshot artifacts", async () => {
    const runner = new CaptureRunner(
      db,
      new FakeBrowser(
        captured({
          dom: "truncated-dom",
          domTruncated: true,
          screenshot: {
            bytes: Buffer.from("png"),
            width: 1365,
            height: 16_000,
            truncated: true,
          },
        }),
      ),
      new MemoryStore(),
      { now: () => NOW },
    );

    await runner.capture({ url: URL_UNDER_TEST, reason: "detection" });

    const artifacts = await artifactRows(db);
    expect(
      artifacts.find((artifact) => artifact.kind === "rendered_dom")?.truncated,
    ).toBe(true);
    expect(
      artifacts.find((artifact) => artifact.kind === "screenshot")?.truncated,
    ).toBe(true);
    expect(
      artifacts.find((artifact) => artifact.kind === "screenshot")?.height,
    ).toBe(16_000);
  });

  it("keeps one set of bytes but a new row for an unchanged page", async () => {
    const store = new MemoryStore();
    const runner = new CaptureRunner(
      db,
      new FakeBrowser(captured()),
      store,
      { now: () => NOW },
    );

    await runner.capture({ url: URL_UNDER_TEST, reason: "detection" });
    await runner.capture({ url: URL_UNDER_TEST, reason: "detection" });

    expect(await evidenceRows(db)).toHaveLength(2);
    expect(await artifactRows(db)).toHaveLength(12);
    expect(store.objects.size).toBe(6);
  });

  it("never fetches an allowlisted URL", async () => {
    await db.query(
      `INSERT INTO allowlist_entry
        (id, kind, match_kind, value, scope, title_group_id, tracked_title_id,
         territory, origin, proposed_by_decision_id, confirmed_by, confirmed_at,
         removed_by, removed_at)
       VALUES ('allow', 'official_domain', 'host', 'example.test',
               'rights_holder', NULL, NULL, NULL, 'operator', NULL, 'operator',
               $1, NULL, NULL)`,
      [NOW],
    );
    const browser = new FakeBrowser(captured());
    const runner = new CaptureRunner(db, browser, new MemoryStore(), {
      now: () => NOW,
    });

    const result = await runner.capture({
      url: URL_UNDER_TEST,
      reason: "detection",
    });

    expect(result).toEqual({ captured: false, skipped: "allowlist" });
    expect(browser.calls).toBe(0);
    expect(await evidenceRows(db)).toEqual([]);
  });

  it("never fetches a host under an active objection until it is cleared", async () => {
    await db.query(
      `INSERT INTO host_objection
        (id, host, registrable_domain, reason, source, recorded_at, recorded_by,
         affected_candidate_count, cleared_at, cleared_by, clearance_reason)
       VALUES ('objection', 'example.test', 'example.test', 'C&D',
               'host_contact', $1, NULL, 2, NULL, NULL, NULL)`,
      [NOW],
    );
    const browser = new FakeBrowser(captured());
    const runner = new CaptureRunner(db, browser, new MemoryStore(), {
      now: () => NOW,
    });

    expect(
      await runner.capture({ url: URL_UNDER_TEST, reason: "detection" }),
    ).toEqual({ captured: false, skipped: "host_objection" });
    expect(browser.calls).toBe(0);

    await db.query(
      "UPDATE host_objection SET cleared_at = $1 WHERE id = 'objection'",
      [NOW],
    );
    const capturedResult = await runner.capture({
      url: URL_UNDER_TEST,
      reason: "detection",
    });
    expect(capturedResult.captured).toBe(true);
    expect(browser.calls).toBe(1);
  });

  it("fetches once per capture point and again for a new one", async () => {
    const browser = new FakeBrowser(captured());
    const runner = new CaptureRunner(db, browser, new MemoryStore(), {
      now: () => NOW,
    });

    const first = await runner.capture({
      url: URL_UNDER_TEST,
      reason: "detection",
      capturePoint: "candidate-1",
    });
    const duplicate = await runner.capture({
      url: URL_UNDER_TEST,
      reason: "detection",
      capturePoint: "candidate-1",
    });
    const reappearance = await runner.capture({
      url: URL_UNDER_TEST,
      reason: "detection",
      capturePoint: "violation-2",
    });

    expect(first.captured).toBe(true);
    expect(duplicate).toMatchObject({ captured: false, skipped: "duplicate" });
    expect(reappearance.captured).toBe(true);
    expect(browser.calls).toBe(2);
    expect(await evidenceRows(db)).toHaveLength(2);
  });

  it("records a 451 as an objection that blocks the next capture", async () => {
    const runner = new CaptureRunner(
      db,
      new FakeBrowser(
        captured({
          outcome: "blocked",
          httpStatus: 451,
          failureReason: "http_451",
        }),
      ),
      new MemoryStore(),
      { now: () => NOW },
    );

    await runner.capture({ url: URL_UNDER_TEST, reason: "detection" });

    const objection = (
      await db.query("SELECT * FROM host_objection WHERE host = 'example.test'")
    ).rows[0];
    expect(objection).toMatchObject({
      source: "host_contact",
      cleared_at: null,
    });

    const next = await runner.capture({
      url: "https://example.test/another",
      reason: "detection",
    });
    expect(next).toMatchObject({ captured: false, skipped: "host_objection" });
  });

  it("stores no blobs for a dead page whose body was empty", async () => {
    const runner = new CaptureRunner(
      db,
      new FakeBrowser(
        captured({
          outcome: "dead",
          httpStatus: 404,
          responseBody: Buffer.alloc(0),
          failureReason: "empty_body",
        }),
      ),
      new MemoryStore(),
      { now: () => NOW },
    );

    await runner.capture({ url: URL_UNDER_TEST, reason: "detection" });

    expect(await artifactRows(db)).toEqual([]);
  });

  it("skips a review capture while the newest live capture is fresh", async () => {
    const store = new MemoryStore();
    const browser = new FakeBrowser(captured());
    const runner = new CaptureRunner(db, browser, store, { now: () => NOW });
    await runner.capture({ url: URL_UNDER_TEST, reason: "detection" });

    const review = await runner.capture({
      url: URL_UNDER_TEST,
      reason: "review",
    });

    expect(review).toMatchObject({ captured: false, skipped: "fresh" });
    expect(browser.calls).toBe(1);
  });
});

describe("capture limiter", () => {
  it("serialises captures of one host and allows different hosts", async () => {
    const limiter = new HostLimiter({
      gapMs: 0,
      concurrency: 2,
      sleep: async () => undefined,
    });
    let active = 0;
    let allPeak = 0;
    const activeByHost = new Map<string, number>();
    let sameHostPeak = 0;
    const task = (host: string) => async () => {
      active += 1;
      allPeak = Math.max(allPeak, active);
      const hostActive = (activeByHost.get(host) ?? 0) + 1;
      activeByHost.set(host, hostActive);
      sameHostPeak = Math.max(sameHostPeak, hostActive);
      await Promise.resolve();
      activeByHost.set(host, hostActive - 1);
      active -= 1;
    };

    await Promise.all([
      limiter.run("example.test", task("example.test")),
      limiter.run("example.test", task("example.test")),
      limiter.run("other.test", task("other.test")),
    ]);

    expect(sameHostPeak).toBe(1);
    expect(allPeak).toBe(2);
  });
});

describe("retry matrix", () => {
  it("retries blocked and error captures up to three attempts inside a day", () => {
    expect(retryDelay("captured", 1, NOW, NOW)).toBeUndefined();
    expect(retryDelay("dead", 1, NOW, NOW)).toBeUndefined();
    expect(retryDelay("blocked", 1, NOW, NOW)).toBe(5 * 60 * 1000);
    expect(retryDelay("error", 2, NOW, NOW)).toBe(30 * 60 * 1000);
    expect(retryDelay("blocked", 3, NOW, NOW)).toBeUndefined();
    expect(
      retryDelay("error", 1, new Date(NOW.getTime() - 25 * 60 * 60 * 1000), NOW),
    ).toBeUndefined();
  });
});
