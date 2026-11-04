import type { Connectable } from "../db.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface PendingReminder {
  submissionId: string;
  noticeId: string;
  recipient: string;
  createdAt: Date;
}

/**
 * Pending submissions older than seven days, oldest first.
 *
 * The reminder reads the backlog so the job can report stale rows; it never
 * delivers anything, because an operator files every notice.
 */
export async function findStalePending(
  db: Connectable,
  now: Date = new Date(),
): Promise<PendingReminder[]> {
  const cutoff = new Date(now.getTime() - SEVEN_DAYS_MS);
  const rows = (
    await db.query(
      `SELECT s.id, s.notice_id, n.recipient, s.created_at
         FROM submission s
         JOIN notice n ON n.id = s.notice_id
        WHERE s.state = 'pending'
          AND s.cancelled_at IS NULL
          AND s.created_at <= $1
        ORDER BY s.created_at ASC`,
      [cutoff],
    )
  ).rows;
  return rows.map((row) => ({
    submissionId: String(row.id),
    noticeId: String(row.notice_id),
    recipient: String(row.recipient),
    createdAt: new Date(row.created_at as string | Date),
  }));
}
