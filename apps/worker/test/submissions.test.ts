import { describe, expect, it } from "vitest";
import type { Connectable } from "../../api/src/db/migrations.js";
import { findStalePending } from "../src/submissions/remind.js";
import { memoryDb } from "./support.js";

const NOW = new Date("2026-11-04T12:00:00Z");

async function seedSubmission(
  db: Connectable,
  id: string,
  options: {
    createdAt: Date;
    state?: string;
    cancelledAt?: Date | null;
  },
) {
  const noticeId = `notice-${id}`;
  await db.query(
    `INSERT INTO notice
      (id, recipient, recipient_profile_id, channel, state, template_version,
       created_by, created_at, updated_at)
     VALUES ($1, 'google', 'profile-1', 'web_form', 'approved', 'google.en.v1@hash',
             'operator-1', $2, $2)`,
    [noticeId, options.createdAt],
  );
  await db.query(
    `INSERT INTO submission
      (id, recipient_profile_id, state, notice_id, channel, pack_language,
       attempt_count, created_at, updated_at, cancelled_at)
     VALUES ($1, 'profile-1', $2, $3, 'web_form', 'en', 1, $4, $4, $5)`,
    [
      id,
      options.state ?? "pending",
      noticeId,
      options.createdAt,
      options.cancelledAt ?? null,
    ],
  );
}

describe("submission reminders", () => {
  it("returns only uncancelled pending submissions older than seven days", async () => {
    const db = await memoryDb();
    const eightDaysAgo = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000);
    const sixDaysAgo = new Date(NOW.getTime() - 6 * 24 * 60 * 60 * 1000);

    await seedSubmission(db, "stale", { createdAt: eightDaysAgo });
    await seedSubmission(db, "fresh", { createdAt: sixDaysAgo });
    await seedSubmission(db, "cancelled", {
      createdAt: eightDaysAgo,
      cancelledAt: NOW,
    });
    await seedSubmission(db, "delivered", {
      createdAt: eightDaysAgo,
      state: "delivered",
    });

    const reminders = await findStalePending(db, NOW);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({
      submissionId: "stale",
      noticeId: "notice-stale",
      recipient: "google",
    });
    expect(reminders[0].createdAt.toISOString()).toBe(eightDaysAgo.toISOString());
  });
});
