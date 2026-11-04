import type { Queryable } from "../db.js";

export interface CaptureRequestRow {
  id: string;
  url: string;
  reason: string;
  candidate_id: string | null;
  violation_id: string | null;
  tracked_title_id: string | null;
  title_group_id: string | null;
  capture_point: string | null;
}

export interface CaptureJobData {
  requestId: string;
  url: string;
  reason: string;
  candidateId?: string;
  violationId?: string;
  trackedTitleId?: string;
  titleGroupId?: string;
  capturePoint?: string;
}

/** Hand pending capture requests to the queue, once each. */
export async function pollCaptureRequests(
  db: Queryable,
  send: (data: CaptureJobData) => Promise<unknown>,
  now: Date = new Date(),
): Promise<number> {
  const rows = (
    await db.query(
      `SELECT * FROM capture_request
        WHERE state = 'pending'
        ORDER BY created_at ASC
        LIMIT 50`,
    )
  ).rows as unknown as CaptureRequestRow[];
  let queued = 0;
  for (const row of rows) {
    const claimed = await db.query(
      "UPDATE capture_request SET state = 'queued', queued_at = $2 WHERE id = $1 AND state = 'pending'",
      [row.id, now],
    );
    if ((claimed.rowCount ?? 0) === 0) {
      continue;
    }
    try {
      await send({
        requestId: row.id,
        url: row.url,
        reason: row.reason,
        ...(row.candidate_id ? { candidateId: row.candidate_id } : {}),
        ...(row.violation_id ? { violationId: row.violation_id } : {}),
        ...(row.tracked_title_id
          ? { trackedTitleId: row.tracked_title_id }
          : {}),
        ...(row.title_group_id ? { titleGroupId: row.title_group_id } : {}),
        ...(row.capture_point ? { capturePoint: row.capture_point } : {}),
      });
    } catch (error) {
      await db.query(
        "UPDATE capture_request SET state = 'pending', queued_at = NULL WHERE id = $1",
        [row.id],
      );
      throw error;
    }
    queued += 1;
  }
  return queued;
}
