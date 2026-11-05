import { describe, expect, it } from "vitest";
import {
  ATTEMPT_COUNT_BEFORE_FLAG,
  FLAGGED_FAILED_ATTEMPTS,
  REMINDER_DAYS,
  validateAcknowledgement,
} from "../src/submissions.js";

/**
 * The submission machine's pure halves (slice 7): the per-recipient
 * acknowledgement validation the delivered→acknowledged (and direct
 * pending→acknowledged) path runs — Google's reference number of 4–40
 * characters plus the Removals Dashboard URL, Bing's TicketId plus the
 * ticket-details URL, Yandex's reply Message-ID plus date — and the two
 * thresholds the design fixes: the seven-day reminder and the three failed
 * attempts that flag a submission for an administrator. The
 * database-bound transitions live in the API suite's submissions tests.
 */

describe("per-recipient acknowledgement validation", () => {
  it("accepts Google's reference number and Removals Dashboard URL", () => {
    const outcome = validateAcknowledgement("google", {
      recipient: "google",
      referenceNumber: "dmc-3b8a42f1-9c2d",
      dashboardUrl: "https://support.google.com/legal/removals/dashboard",
    });
    expect(outcome).toEqual({
      ok: true,
      value: {
        recipient: "google",
        referenceNumber: "dmc-3b8a42f1-9c2d",
        dashboardUrl: "https://support.google.com/legal/removals/dashboard",
      },
    });
  });

  it("accepts Bing's TicketId and ticket-details URL", () => {
    const outcome = validateAcknowledgement("bing", {
      recipient: "bing",
      ticketId: "170123456789012345",
      ticketDetailsUrl: "https://www.bing.com/content/removal?tid=170123456789012345",
    });
    expect(outcome.ok).toBe(true);
  });

  it("accepts Yandex's reply Message-ID and date", () => {
    const outcome = validateAcknowledgement("yandex", {
      recipient: "yandex",
      messageId: "<CAF0123456789@mail.yandex.ru>",
      replyDate: "2026-01-04",
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toMatchObject({
        recipient: "yandex",
        messageId: "<CAF0123456789@mail.yandex.ru>",
        replyDate: "2026-01-04",
      });
    }
  });

  it("refuses an acknowledgement shaped for another recipient", () => {
    // A Bing body against a Google submission: the variant must match the
    // notice's recipient (implementation rules "Acknowledgement shapes").
    const outcome = validateAcknowledgement("google", {
      recipient: "bing",
      ticketId: "170123456789012345",
      ticketDetailsUrl: "https://www.bing.com/content/removal?tid=170123456789012345",
    });
    expect(outcome).toEqual({
      ok: false,
      status: "recipient_mismatch",
      expected: "google",
      got: "bing",
    });
  });

  it("refuses a Google reference number shorter than four characters", () => {
    const outcome = validateAcknowledgement("google", {
      recipient: "google",
      referenceNumber: "abc",
      dashboardUrl: "https://support.google.com/legal/removals/dashboard",
    });
    expect(outcome).toMatchObject({ ok: false, status: "acknowledgement_shape" });
  });

  it("refuses a Google reference number longer than forty characters", () => {
    const outcome = validateAcknowledgement("google", {
      recipient: "google",
      referenceNumber: "x".repeat(41),
      dashboardUrl: "https://support.google.com/legal/removals/dashboard",
    });
    expect(outcome).toMatchObject({ ok: false, status: "acknowledgement_shape" });
  });

  it("refuses a non-URL dashboard link", () => {
    const outcome = validateAcknowledgement("google", {
      recipient: "google",
      referenceNumber: "dmc-3b8a42f1-9c2d",
      dashboardUrl: "not a url",
    });
    expect(outcome).toMatchObject({ ok: false, status: "acknowledgement_shape" });
  });

  it("refuses an empty Bing TicketId", () => {
    const outcome = validateAcknowledgement("bing", {
      recipient: "bing",
      ticketId: "  ",
      ticketDetailsUrl: "https://www.bing.com/content/removal?tid=1",
    });
    expect(outcome).toMatchObject({ ok: false, status: "acknowledgement_shape" });
  });

  it("refuses a Yandex reply date that is not an ISO date", () => {
    const outcome = validateAcknowledgement("yandex", {
      recipient: "yandex",
      messageId: "<CAF0123456789@mail.yandex.ru>",
      replyDate: "04.01.2026",
    });
    expect(outcome).toMatchObject({ ok: false, status: "acknowledgement_shape" });
  });

  it("refuses an empty Yandex Message-ID", () => {
    const outcome = validateAcknowledgement("yandex", {
      recipient: "yandex",
      messageId: "",
      replyDate: "2026-01-04",
    });
    expect(outcome).toMatchObject({ ok: false, status: "acknowledgement_shape" });
  });
});

describe("the thresholds the design fixes", () => {
  it("reminds after seven days and flags after three failed attempts", () => {
    expect(REMINDER_DAYS).toBe(7);
    // A failed attempt concludes with the row's attempt_count already
    // raised by the retries that preceded it: the first failure finds 0,
    // the second 1, the third 2. The flag lands exactly there.
    expect(FLAGGED_FAILED_ATTEMPTS).toBe(3);
    expect(ATTEMPT_COUNT_BEFORE_FLAG).toBe(2);
  });
});
