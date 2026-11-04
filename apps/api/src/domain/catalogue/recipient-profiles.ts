import type { Pool, PoolClient } from "pg";
import { ApiError } from "../../errors.js";
import { pageParams } from "../../routes/support.js";
import { recipientProfileJson, type RecipientProfileRow } from "./serialize.js";
import { parsePlainTime } from "./shared.js";

/**
 * Recipient profiles: one per recipient, seeded lazily because migrations
 * run before any operator exists to record as updated_by — the first read
 * after bootstrap creates the three rows, attributed to the deployment's
 * first administrator. Every edit raises the profile's version, which an
 * approval snapshots into a notice (slice 6).
 */

/** The recipients a profile exists for, in listing order. */
export const RECIPIENTS = ["google", "bing", "yandex"] as const;
export type Recipient = (typeof RECIPIENTS)[number];

/** The scheduled composition window the design defaults to: 07:00 UTC. */
const DEFAULT_WINDOW_TIME = "07:00:00";

/** Seeds any missing profile row; idempotent under concurrency. */
export async function ensureRecipientProfiles(
  pool: Pool,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const firstAdmin = await client.query<{ id: string }>(
      `select id from operators
        where role = 'administrator' and state = 'active'
        order by created_at asc limit 1`,
    );
    const updatedBy = firstAdmin.rows[0]?.id;
    if (updatedBy === undefined) {
      // The settings surface is setup-gated: an administrator exists by the
      // time any read reaches here. Guarding anyway keeps the seeding pure.
      await client.query("rollback");
      return;
    }
    for (const recipient of RECIPIENTS) {
      await client.query(
        `insert into recipient_profiles (recipient, window_time, updated_by)
         values ($1, $2::time, $3)
         on conflict (recipient) do nothing`,
        [recipient, DEFAULT_WINDOW_TIME, updatedBy],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function findProfile(
  client: Pool | PoolClient,
  id: string,
): Promise<RecipientProfileRow> {
  const result = await client.query<RecipientProfileRow>(
    "select * from recipient_profiles where id = $1",
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(404, "not_found");
  }
  return result.rows[0];
}

/** Every profile, seeded first; ordered by recipient. */
export async function listRecipientProfiles(
  pool: Pool,
  query: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await ensureRecipientProfiles(pool);
  const { page, pageSize, limit, offset } = pageParams(query);
  const items = await pool.query<RecipientProfileRow>(
    "select * from recipient_profiles order by recipient limit $1 offset $2",
    [limit, offset],
  );
  const total = await pool.query<{ count: string }>(
    "select count(*) as count from recipient_profiles",
  );
  return {
    items: items.rows.map(recipientProfileJson),
    total: Number(total.rows[0].count),
    page,
    pageSize,
  };
}

export interface UpdateRecipientProfileInput {
  channel?: "web_form" | "trusted_program";
  account?: string;
  contactEmail?: string;
  compositionTrigger?: "scheduled" | "on_demand";
  windowTime?: string;
  eligibleTerritories?: string[];
  maxUrlsPerNotice?: number;
  maxUrlsPerFile?: number;
  maxUrlsPerDay?: number;
}

/** Edits a profile; the version rises on every edit. */
export async function updateRecipientProfile(
  pool: Pool,
  now: () => Date,
  id: string,
  actorId: string,
  input: UpdateRecipientProfileInput,
): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await findProfile(client, id);
    const nextTrigger = input.compositionTrigger ?? existing.composition_trigger;
    const nextWindow =
      input.windowTime !== undefined
        ? parsePlainTime(input.windowTime, "/windowTime")
        : existing.window_time;
    if (nextTrigger === "scheduled" && nextWindow === null) {
      // The database CHECK holds the same rule; refusing here answers with
      // the offending field instead of a constraint error.
      throw new ApiError(400, "validation_failed", {
        fieldErrors: [
          {
            path: "/windowTime",
            message: "a scheduled trigger needs a composition window time",
          },
        ],
      });
    }
    const updated = await client.query<RecipientProfileRow>(
      `update recipient_profiles set
         channel = coalesce($2, channel),
         account = coalesce($3, account),
         contact_email = coalesce($4, contact_email),
         composition_trigger = coalesce($5, composition_trigger),
         window_time = case when $6::time is null then window_time else $6::time end,
         eligible_territories = coalesce($7, eligible_territories),
         max_urls_per_notice = coalesce($8, max_urls_per_notice),
         max_urls_per_file = coalesce($9, max_urls_per_file),
         max_urls_per_day = coalesce($10, max_urls_per_day),
         version = version + 1,
         updated_by = $11,
         updated_at = $12
       where id = $1
       returning *`,
      [
        id,
        input.channel ?? null,
        input.account ?? null,
        input.contactEmail ?? null,
        input.compositionTrigger ?? null,
        input.windowTime !== undefined
          ? parsePlainTime(input.windowTime, "/windowTime")
          : null,
        input.eligibleTerritories ?? null,
        input.maxUrlsPerNotice ?? null,
        input.maxUrlsPerFile ?? null,
        input.maxUrlsPerDay ?? null,
        actorId,
        now().toISOString(),
      ],
    );
    await client.query("commit");
    return recipientProfileJson(updated.rows[0]);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Clears a pause the rejection threshold set. A profile whose last twenty
 * submissions still exceed the threshold cannot be cleared (the slice-7
 * write path maintains those counters; at zero submissions nothing exceeds
 * anything). The clearance is recorded against the profile: who, when, why.
 */
export async function clearProfilePause(
  pool: Pool,
  now: () => Date,
  id: string,
  actorId: string,
  reason: string,
): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await findProfile(client, id);
    if (!existing.paused) {
      throw new ApiError(409, "state_conflict");
    }
    const thresholdExceeded =
      existing.recent_window_size > 0 &&
      (existing.recent_rejected + existing.recent_failed) /
        existing.recent_window_size >
        0.1;
    if (thresholdExceeded) {
      throw new ApiError(409, "state_conflict", {
        fieldErrors: [
          {
            path: "/",
            message:
              "the last twenty submissions still exceed the rejection threshold; the pause stands",
          },
        ],
      });
    }
    const updated = await client.query<RecipientProfileRow>(
      `update recipient_profiles set
         paused = false,
         pause_reason = null,
         cleared_reason = $2,
         cleared_by = $3,
         cleared_at = $4,
         version = version + 1,
         updated_by = $3,
         updated_at = $4
       where id = $1
       returning *`,
      [id, reason, actorId, now().toISOString()],
    );
    await client.query("commit");
    return recipientProfileJson(updated.rows[0]);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
