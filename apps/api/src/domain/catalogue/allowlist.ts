import type { Pool, PoolClient } from "pg";
import {
  ALLOWLIST_TIER_ORDER,
  allowlistTier,
  entryMatchesUrl,
  findAllowlistHit as pureFindAllowlistHit,
  normalizeAllowlistValue as pureNormalizeAllowlistValue,
  type AllowlistHit,
  type AllowlistKind,
  type AllowlistMatchKind,
  type AllowlistOrigin,
  type AllowlistScope,
  type AllowlistTier,
} from "@patrol/domain";
import { ApiError } from "../../errors.js";
import { pageParams } from "../../routes/support.js";
import { allowlistEntryJson, type AllowlistEntryRow } from "./serialize.js";

/**
 * The scoped allowlist that suppresses authorization rather than
 * infringement. Validity (GLOSSARY invariants, contract checks): a
 * licensed destination requires a territory; a title-group scope requires a
 * title group and no title; a tracked-title scope requires a title and no
 * group; the rights-holder scope carries neither. Precedence when matching
 * (docs/design/matching-and-classification-rules.md): rights-holder
 * official domains, then global neutral sources, then learned entries,
 * then reputation blocklists — the blocklist tier arrives with slice 5 and
 * is structured here already, because blocklists never veto a per-URL
 * match. The vocabulary itself (kinds, match kinds, scopes, origins,
 * tiers) is shared with the capture worker and lives in @patrol/domain;
 * this module re-exports it so the API's import surface stays one door.
 */

export interface CreateAllowlistInput {
  kind: AllowlistKind;
  matchKind: AllowlistMatchKind;
  value: string;
  scope: AllowlistScope;
  titleGroupId?: string;
  trackedTitleId?: string;
  territory?: string;
}

export { ALLOWLIST_TIER_ORDER, allowlistTier, entryMatchesUrl };
export type {
  AllowlistKind,
  AllowlistMatchKind,
  AllowlistOrigin,
  AllowlistScope,
  AllowlistTier,
};

/**
 * Normalizes an entry value into its matching form through the shared pure
 * rule, mapping a refusal onto the request's field error.
 */
export function normalizeAllowlistValue(
  matchKind: AllowlistMatchKind,
  value: string,
): string {
  try {
    return pureNormalizeAllowlistValue(matchKind, value);
  } catch {
    throw new ApiError(422, "unprocessable", {
      fieldErrors: [
        {
          path: "/value",
          message: matchKind === "host" ? "not a host" : "not a URL prefix",
        },
      ],
    });
  }
}

/**
 * The highest-precedence entry matching a URL, or null. Scoped entries are
 * the caller's to filter first: matching here is about the value.
 */
export function findAllowlistHit(
  entries: Array<{ kind: AllowlistKind; origin?: AllowlistOrigin } & {
    matchKind: AllowlistMatchKind;
    value: string;
  }>,
  rawUrl: string,
): { matchKind: AllowlistMatchKind; value: string } | null {
  const hit: AllowlistHit | null = pureFindAllowlistHit(entries, rawUrl);
  return hit === null ? null : { matchKind: hit.matchKind, value: hit.value };
}

async function assertScopeTargets(
  client: PoolClient,
  input: CreateAllowlistInput,
): Promise<void> {
  const licensedNeedsTerritory =
    input.kind === "licensed_destination" && input.territory === undefined;
  if (licensedNeedsTerritory) {
    throw new ApiError(422, "unprocessable", {
      fieldErrors: [
        { path: "/territory", message: "a licensed destination requires a territory" },
      ],
    });
  }
  if (input.scope === "rights_holder") {
    if (input.titleGroupId !== undefined || input.trackedTitleId !== undefined) {
      throw new ApiError(422, "unprocessable", {
        fieldErrors: [
          { path: "/scope", message: "the rights-holder scope carries no group or title" },
        ],
      });
    }
    return;
  }
  if (input.scope === "title_group") {
    if (input.titleGroupId === undefined || input.trackedTitleId !== undefined) {
      throw new ApiError(422, "unprocessable", {
        fieldErrors: [
          { path: "/titleGroupId", message: "a title-group scope carries a group and no title" },
        ],
      });
    }
    const group = await client.query(
      "select id from title_groups where id = $1",
      [input.titleGroupId],
    );
    if (group.rows.length === 0) {
      throw new ApiError(422, "unprocessable", {
        fieldErrors: [{ path: "/titleGroupId", message: "no such title group" }],
      });
    }
    return;
  }
  if (input.trackedTitleId === undefined || input.titleGroupId !== undefined) {
    throw new ApiError(422, "unprocessable", {
      fieldErrors: [
        { path: "/trackedTitleId", message: "a tracked-title scope carries a title and no group" },
      ],
    });
  }
  const title = await client.query(
    "select id from tracked_titles where id = $1 and merged_into_title_id is null",
    [input.trackedTitleId],
  );
  if (title.rows.length === 0) {
    throw new ApiError(422, "unprocessable", {
      fieldErrors: [{ path: "/trackedTitleId", message: "no such tracked title" }],
    });
  }
}

/** Adds one entry, confirmed immediately by the operator who adds it. */
export async function createAllowlistEntry(
  pool: Pool,
  now: () => Date,
  actorId: string,
  input: CreateAllowlistInput,
): Promise<Record<string, unknown>> {
  const value = normalizeAllowlistValue(input.matchKind, input.value);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertScopeTargets(client, input);
    const duplicate = await client.query<{ id: string }>(
      `select id from allowlist_entries
        where kind = $1 and match_kind = $2 and value = $3 and scope = $4
          and title_group_id is not distinct from $5
          and tracked_title_id is not distinct from $6
          and territory is not distinct from $7`,
      [
        input.kind,
        input.matchKind,
        value,
        input.scope,
        input.titleGroupId ?? null,
        input.trackedTitleId ?? null,
        input.territory ?? null,
      ],
    );
    if (duplicate.rows.length > 0) {
      throw new ApiError(409, "duplicate_entity");
    }
    const inserted = await client.query<AllowlistEntryRow>(
      `insert into allowlist_entries
         (kind, match_kind, value, scope, title_group_id, tracked_title_id, territory, origin, confirmed_by, confirmed_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'operator', $8, $9)
       returning *`,
      [
        input.kind,
        input.matchKind,
        value,
        input.scope,
        input.titleGroupId ?? null,
        input.trackedTitleId ?? null,
        input.territory ?? null,
        actorId,
        now().toISOString(),
      ],
    );
    await client.query("commit");
    return allowlistEntryJson(inserted.rows[0]);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Removes an entry; the removal is recorded against the operator. */
export async function removeAllowlistEntry(
  pool: Pool,
  now: () => Date,
  actorId: string,
  allowlistEntryId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<AllowlistEntryRow>(
      "select * from allowlist_entries where id = $1",
      [allowlistEntryId],
    );
    if (existing.rows.length === 0) {
      throw new ApiError(404, "not_found");
    }
    // The removal record: security_events is the identity audit stream, and
    // an allowlist change is an operational decision worth its trail. The
    // entry itself is deleted; entries carry no lifecycle of their own.
    await client.query("delete from allowlist_entries where id = $1", [
      allowlistEntryId,
    ]);
    await client.query(
      `insert into security_events (operator_id, kind, detail, created_at)
       values ($1, 'allowlist_entry_removed', $2::jsonb, $3)`,
      [
        actorId,
        JSON.stringify({ entryId: allowlistEntryId, value: existing.rows[0].value }),
        now().toISOString(),
      ],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface AllowlistFilter {
  kind?: AllowlistKind;
  scope?: AllowlistScope;
  territory?: string;
}

/** Every entry, filtered by kind, scope, or territory. */
export async function listAllowlistEntries(
  pool: Pool,
  filter: AllowlistFilter,
  query: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { page, pageSize, limit, offset } = pageParams(query);
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.kind !== undefined) {
    params.push(filter.kind);
    conditions.push(`kind = $${params.length}`);
  }
  if (filter.scope !== undefined) {
    params.push(filter.scope);
    conditions.push(`scope = $${params.length}`);
  }
  if (filter.territory !== undefined) {
    params.push(filter.territory);
    conditions.push(`territory = $${params.length}`);
  }
  const where = conditions.length === 0 ? "" : `where ${conditions.join(" and ")}`;
  const items = await pool.query<AllowlistEntryRow>(
    `select * from allowlist_entries ${where}
      order by confirmed_at desc, id limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, limit, offset],
  );
  const total = await pool.query<{ count: string }>(
    `select count(*) as count from allowlist_entries ${where}`,
    params,
  );
  return {
    items: items.rows.map(allowlistEntryJson),
    total: Number(total.rows[0].count),
    page,
    pageSize,
  };
}
