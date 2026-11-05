import { describe, expect, it } from "vitest";
import { MemoryMailTransport } from "../src/transport.js";
import {
  deliverBudgetAlertEmail,
  deliverSubmissionReminderEmail,
} from "../src/alerts.js";

/**
 * The operator-mailbox alert emails (docs/design/scan-scheduling.md
 * "Alerts"; slice 9's acceptance): a budget alert names the engine, the
 * bucket, the spend, and the uncovered groups; a submission reminder names
 * the overdue submissions. Both render through the catalogue with the
 * mail templates' interpolation rule, and both land on the transport the
 * deployment configured — the memory recorder here, SMTP in production.
 */

describe("the budget alert email", () => {
  it("names the engine, bucket, spend, and uncovered groups", async () => {
    const mail = new MemoryMailTransport();
    await deliverBudgetAlertEmail(mail, {
      to: "patrol-alerts@example.test",
      alert: {
        engine: "google",
        threshold: "critical",
        bucket: "scan",
        level: "critical",
        percentUsed: 92.4,
        groupsNotScanned: 3,
      },
    });
    expect(mail.messages).toHaveLength(1);
    const message = mail.messages[0]!;
    expect(message.to).toBe("patrol-alerts@example.test");
    expect(message.subject).toContain("google");
    expect(message.body).toContain("google");
    expect(message.body).toContain("scan");
    expect(message.body).toContain("92.4");
    expect(message.body).toContain("3");
  });

  it("prefixes the subject with the level so a mailbox glance sorts the loud alerts", async () => {
    const mail = new MemoryMailTransport();
    await deliverBudgetAlertEmail(mail, {
      to: "patrol-alerts@example.test",
      alert: {
        engine: "google",
        threshold: "critical",
        bucket: "scan",
        level: "critical",
        percentUsed: 92.4,
        groupsNotScanned: 3,
      },
    });
    expect(mail.messages[0]!.subject).toContain("[CRITICAL]");
    expect(mail.messages[0]!.subject).not.toContain("{level}");

    await deliverBudgetAlertEmail(mail, {
      to: "patrol-alerts@example.test",
      alert: {
        engine: "yandex",
        threshold: "warning",
        bucket: null,
        level: "warning",
        percentUsed: 75,
        groupsNotScanned: 0,
      },
    });
    expect(mail.messages[1]!.subject).toContain("[WARN]");
  });

  it("renders an engine-level threshold without a bucket and trims integral percentages", async () => {
    const mail = new MemoryMailTransport();
    await deliverBudgetAlertEmail(mail, {
      to: "patrol-alerts@example.test",
      alert: {
        engine: "yandex",
        threshold: "warning",
        bucket: null,
        level: "warning",
        percentUsed: 75,
        groupsNotScanned: 0,
      },
    });
    expect(mail.messages[0]!.body).toContain("75");
    expect(mail.messages[0]!.body).not.toContain("{bucket}");
  });

  it("renders in the deployment's chosen language", async () => {
    const mail = new MemoryMailTransport();
    await deliverBudgetAlertEmail(mail, {
      to: "patrol-alerts@example.test",
      locale: "ru",
      alert: {
        engine: "google",
        threshold: "exhausted",
        bucket: "recheck",
        level: "critical",
        percentUsed: 100,
        groupsNotScanned: 0,
      },
    });
    expect(mail.messages[0]!.locale).toBe("ru");
    expect(mail.messages[0]!.body).toContain("google");
    // The level token stays untranslated by design; the template around it
    // is the catalogue's.
    expect(mail.messages[0]!.subject).toContain("[CRITICAL]");
  });
});

describe("the submission reminder email", () => {
  it("names every overdue submission with its notice and age", async () => {
    const mail = new MemoryMailTransport();
    await deliverSubmissionReminderEmail(mail, {
      to: "patrol-alerts@example.test",
      items: [
        {
          submissionId: "11111111-1111-7000-8000-000000000001",
          noticeId: "22222222-2222-7000-8000-000000000002",
          recipientProfileId: "33333333-3333-7000-8000-000000000003",
          createdAt: "2026-10-20T07:00:00.000Z",
        },
      ],
    });
    expect(mail.messages).toHaveLength(1);
    const message = mail.messages[0]!;
    expect(message.to).toBe("patrol-alerts@example.test");
    expect(message.body).toContain("22222222-2222-7000-8000-000000000002");
    expect(message.body).toContain("2026-10-20");
  });

  it("refuses an empty reminder rather than sending a blank email", async () => {
    const mail = new MemoryMailTransport();
    await expect(
      deliverSubmissionReminderEmail(mail, { to: "patrol-alerts@example.test", items: [] }),
    ).rejects.toThrow(/non-empty/i);
    expect(mail.messages).toHaveLength(0);
  });
});
