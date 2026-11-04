import type { Pool, PoolClient } from "pg";
import { ApiError } from "../../errors.js";
import { pageParams } from "../../routes/support.js";
import { titleGroupJson, type TitleGroupRow } from "./serialize.js";
import { parsePlainTime } from "./shared.js";

/**
 * Title groups: operator-defined sets of tracked titles sharing scan
 * settings and allowlist scope. A group declares at least one locale
 * (GLOSSARY invariant) and a scan_time inside the 02:00-05:59 UTC spreading
 * window; the default is derived deterministically from the group's
 * identity, so a hundred groups do not all become due on the same minute
 * (docs/design/scan-scheduling.md).
 */

/** The scheduling window the design fixes: 02:00 to 05:59 UTC. */
export const SCAN_WINDOW_START_MINUTES = 2 * 60;
export const SCAN_WINDOW_MINUTES = 4 * 60;

/**
 * The scan_time derived from a group's identity: the random tail of the
 * group's UUIDv7 (the seventy-four bits after the timestamp) is hashed over
 * the window, so the same group always lands on the same minute while two
 * groups rarely collide. The timestamp head is deliberately not used — it
 * is shared by every group created inside one millisecond and moves only
 * with wall time, so ids minted in the same hours would otherwise pile onto
 * a handful of minutes.
 */
export function deriveScanTime(groupId: string): string {
  // Drop the dashes and the leading 48-bit timestamp: what remains is the
  // version, variant, and random bits, hashed as a whole so any id shape
  // (test fixtures included) still spreads.
  const tail = groupId.replaceAll("-", "").slice(12);
  let hash = 0x811c9dc5;
  for (let index = 0; index < tail.length; index += 1) {
    hash ^= tail.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // Force the accumulator unsigned before the modulo.
  const spread = (hash >>> 0) % SCAN_WINDOW_MINUTES;
  const minuteOfDay = SCAN_WINDOW_START_MINUTES + spread;
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;
}

function assertScanTimeInWindow(columnTime: string): void {
  const [hours, minutes] = columnTime.split(":").map(Number);
  const minuteOfDay = hours * 60 + minutes;
  if (
    minuteOfDay < SCAN_WINDOW_START_MINUTES ||
    minuteOfDay >= SCAN_WINDOW_START_MINUTES + SCAN_WINDOW_MINUTES
  ) {
    throw new ApiError(400, "validation_failed", {
      fieldErrors: [
        {
          path: "/scanTime",
          message: "scan time must lie inside the 02:00-05:59 UTC window",
        },
      ],
    });
  }
}

export interface CreateTitleGroupInput {
  name: string;
  locales: string[];
  scanTime?: string;
  priority: "high" | "normal" | "low";
}

export async function createTitleGroup(
  pool: Pool,
  input: CreateTitleGroupInput,
): Promise<Record<string, unknown>> {
  if (input.locales.length === 0) {
    throw new ApiError(400, "validation_failed", {
      fieldErrors: [
        { path: "/locales", message: "at least one locale is required" },
      ],
    });
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    // The derived default: when the caller did not choose a time, the
    // group's own id decides, so the insert lands first and its id picks
    // the minute inside the spreading window. The contract's
    // CreateTitleGroupRequest requires scanTime, so the API path always
    // supplies one; the derivation serves the tests, the CLI, and any
    // future caller that omits it, and keeps the column's spreading
    // default honest when it does.
    const seeded = await client.query<TitleGroupRow>(
      `insert into title_groups (name, locales, priority)
       values ($1, $2, $3)
       returning *`,
      [input.name, input.locales, input.priority],
    );
    const scanTime =
      input.scanTime !== undefined
        ? parsePlainTime(input.scanTime, "/scanTime")
        : deriveScanTime(seeded.rows[0].id);
    assertScanTimeInWindow(scanTime);
    const updated = await client.query<TitleGroupRow>(
      "update title_groups set scan_time = $1::time where id = $2 returning *",
      [scanTime, seeded.rows[0].id],
    );
    await client.query("commit");
    return titleGroupJson(updated.rows[0]);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function findTitleGroup(
  pool: Pool | PoolClient,
  id: string,
): Promise<TitleGroupRow | null> {
  const result = await pool.query<TitleGroupRow>(
    "select * from title_groups where id = $1",
    [id],
  );
  return result.rows[0] ?? null;
}

export interface UpdateTitleGroupInput {
  name?: string;
  locales?: string[];
  scanTime?: string;
  priority?: "high" | "normal" | "low";
}

export async function updateTitleGroup(
  pool: Pool,
  id: string,
  input: UpdateTitleGroupInput,
): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await findTitleGroup(client, id);
    if (existing === null) {
      await client.query("rollback");
      throw new ApiError(404, "not_found");
    }
    if (input.locales !== undefined && input.locales.length === 0) {
      throw new ApiError(400, "validation_failed", {
        fieldErrors: [
          { path: "/locales", message: "at least one locale is required" },
        ],
      });
    }
    if (input.scanTime !== undefined) {
      assertScanTimeInWindow(parsePlainTime(input.scanTime, "/scanTime"));
    }
    const updated = await client.query<TitleGroupRow>(
      `update title_groups set
         name = coalesce($2, name),
         locales = coalesce($3, locales),
         scan_time = coalesce($4::time, scan_time),
         priority = coalesce($5, priority),
         updated_at = now()
       where id = $1
       returning *`,
      [
        id,
        input.name ?? null,
        input.locales ?? null,
        input.scanTime !== undefined
          ? parsePlainTime(input.scanTime, "/scanTime")
          : null,
        input.priority ?? null,
      ],
    );
    await client.query("commit");
    return titleGroupJson(updated.rows[0]);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listTitleGroups(
  pool: Pool,
  query: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { page, pageSize, limit, offset } = pageParams(query);
  const items = await pool.query<TitleGroupRow>(
    "select * from title_groups order by name limit $1 offset $2",
    [limit, offset],
  );
  const total = await pool.query<{ count: string }>(
    "select count(*) as count from title_groups",
  );
  return {
    items: items.rows.map(titleGroupJson),
    total: Number(total.rows[0].count),
    page,
    pageSize,
  };
}
