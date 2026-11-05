import type { Locale } from "@patrol/i18n";
import type { MailTransport } from "./transport.js";
/**
 * The operator-mailbox alert emails (docs/design/scan-scheduling.md
 * "Alerts"): "Alerts go to every operator through the UI and to the
 * configured operator mailbox. They fire once per threshold per engine per
 * month." The UI half reads the `budget_alerts` rows; this is the mailbox
 * half. The caller owns fire-once (it delivers only the rows its
 * evaluation just fired, and the database's unique key already kept those
 * rows one-per-threshold) — delivery never re-decides durability.
 *
 * Both emails render through the catalogue, the mail templates'
 * interpolation rule, and default to English per the pre-preference rule:
 * the operator mailbox is a role address with no stored preference. A
 * deployment that standardises on Russian passes the locale once at the
 * wiring point.
 */
/** One budget alert row as the mailbox email renders it. */
export interface BudgetAlertEmail {
    engine: string;
    threshold: "warning" | "critical" | "exhausted" | "balance";
    /** The bucket that crossed the threshold; null for engine-level rules. */
    bucket: "scan" | "recheck" | null;
    /** The alert's loudness: prefixes the subject so a mailbox glance sorts. */
    level: "warning" | "critical";
    /** The share the alert measured, in percent. */
    percentUsed: number;
    /** The groups with no completed scan on the engine inside the month. */
    groupsNotScanned: number;
}
/**
 * Sends one budget alert to the operator mailbox. The body names the
 * engine, the bucket, the spend, and the uncovered groups — the slice's
 * acceptance for alert delivery — with the threshold's own guidance as
 * the opening line.
 */
export declare function deliverBudgetAlertEmail(transport: MailTransport, input: {
    to: string;
    locale?: Locale;
    alert: BudgetAlertEmail;
}): Promise<void>;
/** One overdue submission the reminder email names. */
export interface ReminderSubmissionItem {
    submissionId: string;
    noticeId: string;
    recipientProfileId: string;
    createdAt: string;
}
/**
 * Sends the seven-day submission reminder to the operator mailbox: one
 * digest naming every overdue submission, because the reminder's durable
 * half (the deduped `submission_alerts` row) is per submission and the
 * email is the operator's one glance at the same backlog. The caller
 * sends it only when a run raised at least one new alert row — the
 * fire-once rule — so an unchanged backlog never re-emails.
 */
export declare function deliverSubmissionReminderEmail(transport: MailTransport, input: {
    to: string;
    locale?: Locale;
    items: ReminderSubmissionItem[];
}): Promise<void>;
