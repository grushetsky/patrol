import { describe, expect, it } from "vitest";
import {
  degradationPolicy,
  orderQueue,
  registrableDomainFor,
  rungDueAt,
  utcDate,
  type QueueEntry,
} from "../src/index.js";

function entry(overrides: Partial<QueueEntry> & Pick<QueueEntry, "scanId">): QueueEntry {
  return {
    trigger: "scheduled",
    requestedAt: new Date("2026-03-02T10:00:00.000Z"),
    priority: "normal",
    lastScanAt: null,
    ...overrides,
  };
}

describe("orderQueue", () => {
  const manualLate = entry({
    scanId: "manual-late",
    trigger: "manual",
    requestedAt: new Date("2026-03-02T10:05:00.000Z"),
  });
  const manualEarly = entry({
    scanId: "manual-early",
    trigger: "manual_recheck",
    requestedAt: new Date("2026-03-02T10:00:00.000Z"),
  });
  const recheck = entry({
    scanId: "recheck-1",
    trigger: "recheck",
    requestedAt: new Date("2026-03-02T09:00:00.000Z"),
  });
  const scheduledHigh = entry({
    scanId: "sched-high",
    priority: "high",
    lastScanAt: new Date("2026-03-01T00:00:00.000Z"),
  });
  const scheduledLowStale = entry({
    scanId: "sched-low-stale",
    priority: "low",
    lastScanAt: null,
  });
  const scheduledLowFresh = entry({
    scanId: "sched-low-fresh",
    priority: "low",
    lastScanAt: new Date("2026-03-02T08:00:00.000Z"),
  });
  const scheduledNormal = entry({
    scanId: "sched-normal",
    priority: "normal",
    lastScanAt: new Date("2026-02-20T00:00:00.000Z"),
  });

  it("orders manual by request order, then rechecks, then priority, then least-recently-scanned", () => {
    const ordered = orderQueue([
      scheduledLowFresh,
      recheck,
      scheduledHigh,
      manualLate,
      scheduledNormal,
      manualEarly,
      scheduledLowStale,
    ]);
    expect(ordered.map((item) => item.scanId)).toEqual([
      "manual-early",
      "manual-late",
      "recheck-1",
      "sched-high",
      "sched-normal",
      "sched-low-stale",
      "sched-low-fresh",
    ]);
  });

  it("treats a manual re-check as manual work ordered by request time", () => {
    expect(orderQueue([manualLate, manualEarly]).map((item) => item.scanId)).toEqual([
      "manual-early",
      "manual-late",
    ]);
  });

  it("puts a never-scanned group first within its priority", () => {
    const ordered = orderQueue([scheduledLowFresh, scheduledLowStale]);
    expect(ordered.map((item) => item.scanId)).toEqual([
      "sched-low-stale",
      "sched-low-fresh",
    ]);
  });
});

describe("degradationPolicy", () => {
  it("degrades nothing below ninety percent of the scan share", () => {
    expect(degradationPolicy({ scanShareUnits: 1000, scanUsedUnits: 899 })).toEqual({
      stopLowPriorityGroups: false,
      queueScheduledScans: false,
    });
  });

  it("stops low-priority groups at ninety percent", () => {
    expect(
      degradationPolicy({ scanShareUnits: 1000, scanUsedUnits: 900 }),
    ).toEqual({ stopLowPriorityGroups: true, queueScheduledScans: false });
  });

  it("queues scheduled scans at one hundred percent", () => {
    expect(
      degradationPolicy({ scanShareUnits: 1000, scanUsedUnits: 1000 }),
    ).toEqual({ stopLowPriorityGroups: true, queueScheduledScans: true });
  });

  it("treats a zero share as fully degraded", () => {
    expect(degradationPolicy({ scanShareUnits: 0, scanUsedUnits: 0 })).toEqual({
      stopLowPriorityGroups: true,
      queueScheduledScans: true,
    });
  });
});

describe("rungDueAt", () => {
  const anchor = new Date("2026-01-01T00:00:00.000Z");

  it("falls due 3, 7, and 14 days after the anchor scan", () => {
    expect(rungDueAt(anchor, 1).toISOString()).toBe("2026-01-04T00:00:00.000Z");
    expect(rungDueAt(anchor, 2).toISOString()).toBe("2026-01-08T00:00:00.000Z");
    expect(rungDueAt(anchor, 3).toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });

  it("continues every fourteen days past rung three", () => {
    expect(rungDueAt(anchor, 4).toISOString()).toBe("2026-01-29T00:00:00.000Z");
    expect(rungDueAt(anchor, 5).toISOString()).toBe("2026-02-12T00:00:00.000Z");
  });

  it("refuses a non-positive rung", () => {
    expect(() => rungDueAt(anchor, 0)).toThrow();
  });
});

describe("registrableDomainFor", () => {
  it("keeps the public suffix plus one label", () => {
    expect(registrableDomainFor("a.b.example.com")).toBe("example.com");
    expect(registrableDomainFor("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomainFor("example.com")).toBe("example.com");
    expect(registrableDomainFor("host")).toBe("host");
  });
});

describe("utcDate", () => {
  it("cuts the UTC calendar date", () => {
    expect(utcDate(new Date("2026-03-02T23:59:59.999Z"))).toBe("2026-03-02");
  });
});
