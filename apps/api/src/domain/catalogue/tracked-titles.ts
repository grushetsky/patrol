import type { Pool, PoolClient } from "pg";
import { normalizeTitleText } from "@patrol/domain";
import { ApiError } from "../../errors.js";
import { pageParams } from "../../routes/support.js";
import { assertNoDuplicate, findDuplicate } from "./dedup.js";
import { assertIdentifierShape, type IdentifierScheme } from "./identifiers.js";
import {
  allowlistEntryJson,
  externalIdentifierJson,
  titleVariantJson,
  trackedTitleJson,
  type AllowlistEntryRow,
  type ExternalIdentifierRow,
  type TitleVariantRow,
  type TrackedTitleRow,
} from "./serialize.js";
import { isUniqueViolation } from "./shared.js";

/**
 * Tracked titles: creation with the two duplicate checks, the read models
 * the catalogue screens render, and in-place correction. A title and its
 * original variant are born in one transaction — the title row exists
 * mid-transaction without its original_variant_id, which is why that column
 * is nullable and set by the same transaction that creates both rows.
 */

export type CatalogueSource =
  | "rights_holder_record"
  | "operator_knowledge"
  | "wikidata";

export interface NewVariantInput {
  text: string;
  kind: "localized" | "transliterated" | "alternate";
  language: string;
  script: string;
  territory?: string;
  source: CatalogueSource;
}

export interface CreateTrackedTitleInput {
  titleGroupId: string;
  originalVariant: { text: string; language: string; script: string };
  releaseYear: number;
  titleType: "film" | "series" | "miniseries" | "other";
  runtimeMinutes?: number;
  additionalVariants: NewVariantInput[];
  externalIdentifiers: Array<{ scheme: IdentifierScheme; value: string }>;
  source: CatalogueSource;
}

/** A variant text carrying one line only: a multi-line paste is rejected
 * rather than split, because splitting it would be a bulk import by
 * another name (docs/design/catalogue-entry.md "The entry surface"). */
export function assertSingleLineText(text: string, path: string): void {
  if (/[\r\n]/.test(text)) {
    throw new ApiError(400, "validation_failed", {
      fieldErrors: [{ path, message: "one title per save; multi-line text is refused" }],
    });
  }
}

async function insertVariant(
  client: PoolClient,
  input: {
    trackedTitleId: string;
    text: string;
    kind: "original" | "localized" | "transliterated" | "alternate";
    language: string;
    script: string;
    territory?: string;
    source: CatalogueSource;
    addedBy: string;
    addedAt: string;
  },
): Promise<TitleVariantRow> {
  const inserted = await client.query<TitleVariantRow>(
    `insert into title_variants
       (tracked_title_id, text, normalized_text, kind, language, script, territory, source, added_by, added_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning *`,
    [
      input.trackedTitleId,
      input.text,
      normalizeTitleText(input.text),
      input.kind,
      input.language,
      input.script,
      input.territory ?? null,
      input.source,
      input.addedBy,
      input.addedAt,
    ],
  );
  return inserted.rows[0];
}

/**
 * Settles a unique-index refusal inside title creation: the race the
 * pre-checks cannot see. The index names the collision, and a failed
 * statement leaves the transaction aborted, so the rollback runs before
 * the duplicate checks re-run — outside the transaction, where the READ
 * COMMITTED snapshot now sees the winner. The refusal is the same 409
 * duplicate_title the pre-check answers, with the existingTitleId the
 * contract's ConflictBody carries.
 */
async function duplicateFromViolation(
  client: PoolClient,
  input: CreateTrackedTitleInput,
): Promise<ApiError> {
  await client.query("rollback").catch(() => undefined);
  const existingTitleId = await findDuplicate(client, {
    externalIdentifiers: input.externalIdentifiers,
    originalText: input.originalVariant.text,
    releaseYear: input.releaseYear,
    titleType: input.titleType,
  }).catch(() => null);
  return new ApiError(409, "duplicate_title", {
    ...(existingTitleId !== null ? { existingTitleId } : {}),
  });
}export interface CreatedTitle {
  title: Record<string, unknown>;
  detail: Record<string, unknown>;
}

/**
 * Creates one tracked title with its original variant, additional variants,
 * and identifier facts, atomically, with provenance recorded per row. The
 * duplicate checks run first, in the design's fixed order.
 */
export async function createTrackedTitle(
  pool: Pool,
  now: () => Date,
  actorId: string,
  input: CreateTrackedTitleInput,
): Promise<string> {
  assertSingleLineText(input.originalVariant.text, "/originalVariant/text");
  for (const [index, variant] of input.additionalVariants.entries()) {
    assertSingleLineText(variant.text, `/additionalVariants/${index}/text`);
  }
  for (const identifier of input.externalIdentifiers) {
    assertIdentifierShape(identifier.scheme, identifier.value);
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const group = await client.query<{ id: string }>(
      "select id from title_groups where id = $1",
      [input.titleGroupId],
    );
    if (group.rows.length === 0) {
      await client.query("rollback");
      throw new ApiError(404, "not_found");
    }
    await assertNoDuplicate(client, {
      externalIdentifiers: input.externalIdentifiers,
      originalText: input.originalVariant.text,
      releaseYear: input.releaseYear,
      titleType: input.titleType,
    });
    const at = now().toISOString();
    const inserted = await client.query<{ id: string }>(
      `insert into tracked_titles
         (title_group_id, release_year, title_type, runtime_minutes, source, entered_by, entered_at, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $6)
       returning id`,
      [
        input.titleGroupId,
        input.releaseYear,
        input.titleType,
        input.runtimeMinutes ?? null,
        input.source,
        actorId,
        at,
      ],
    );
    const titleId = inserted.rows[0].id;
    const original = await insertVariant(client, {
      trackedTitleId: titleId,
      text: input.originalVariant.text,
      kind: "original",
      language: input.originalVariant.language,
      script: input.originalVariant.script,
      source: input.source,
      addedBy: actorId,
      addedAt: at,
    });
    await client.query(
      "update tracked_titles set original_variant_id = $1 where id = $2",
      [original.id, titleId],
    );
    for (const variant of input.additionalVariants) {
      await insertVariant(client, {
        trackedTitleId: titleId,
        text: variant.text,
        kind: variant.kind,
        language: variant.language,
        script: variant.script,
        territory: variant.territory,
        source: variant.source,
        addedBy: actorId,
        addedAt: at,
      });
    }
    for (const identifier of input.externalIdentifiers) {
      await client.query(
        `insert into external_identifiers (tracked_title_id, scheme, value, source, retrieved_at)
         values ($1, $2, $3, $4, $5)`,
        [titleId, identifier.scheme, identifier.value, input.source, at],
      );
    }
    await client.query("commit");
    return titleId;
  } catch (error) {
    if (isUniqueViolation(error)) {
      // duplicateFromViolation rolls the aborted transaction back itself,
      // then names the winner outside it.
      throw await duplicateFromViolation(client, input);
    }
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function loadTitle(
  client: Pool | PoolClient,
  id: string,
): Promise<TrackedTitleRow> {
  const result = await client.query<TrackedTitleRow>(
    "select * from tracked_titles where id = $1",
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(404, "not_found");
  }
  return result.rows[0];
}

export interface TitleDetail {
  title: TrackedTitleRow;
  displayTitle: string;
  variants: TitleVariantRow[];
  identifiers: ExternalIdentifierRow[];
  allowlistEntries: AllowlistEntryRow[];
  counts: {
    variants: number;
    externalIdentifiers: number;
    allowlistEntries: number;
    candidates: number;
    openViolations: number;
    notices: number;
  };
}

/**
 * The title detail read model. The candidate, violation, and notice counts
 * stay zero until the slices that own those tables land; the read model's
 * shape is final so the route never changes when they do.
 */
export async function readTitleDetail(
  pool: Pool | PoolClient,
  id: string,
): Promise<TitleDetail> {
  const title = await loadTitle(pool, id);
  const variants = await pool.query<TitleVariantRow>(
    "select * from title_variants where tracked_title_id = $1 order by added_at, id",
    [id],
  );
  const identifiers = await pool.query<ExternalIdentifierRow>(
    "select * from external_identifiers where tracked_title_id = $1 order by retrieved_at, id",
    [id],
  );
  const allowlist = await pool.query<AllowlistEntryRow>(
    `select * from allowlist_entries
      where scope = 'rights_holder'
         or (scope = 'title_group' and title_group_id = $2)
         or (scope = 'tracked_title' and tracked_title_id = $1)
      order by confirmed_at, id`,
    [id, title.title_group_id],
  );
  const displayTitle =
    variants.rows.find((row) => row.id === title.original_variant_id)?.text ??
    "";
  return {
    title,
    displayTitle,
    variants: variants.rows,
    identifiers: identifiers.rows,
    allowlistEntries: allowlist.rows,
    counts: {
      variants: variants.rows.length,
      externalIdentifiers: identifiers.rows.length,
      allowlistEntries: allowlist.rows.length,
      // Slice 5 owns candidates and violations; slice 6 owns notices.
      candidates: 0,
      openViolations: 0,
      notices: 0,
    },
  };
}

/** The detail as the contract's TrackedTitleDetail. */
export function titleDetailJson(detail: TitleDetail): Record<string, unknown> {
  return {
    title: trackedTitleJson(detail.title),
    displayTitle: detail.displayTitle,
    variants: detail.variants.map(titleVariantJson),
    externalIdentifiers: detail.identifiers.map(externalIdentifierJson),
    allowlistEntries: detail.allowlistEntries.map(allowlistEntryJson),
    counts: detail.counts,
  };
}

export interface UpdateTrackedTitleInput {
  titleGroupId?: string;
  releaseYear?: number;
  titleType?: "film" | "series" | "miniseries" | "other";
  runtimeMinutes?: number;
  paused?: boolean;
}

/** Corrects a title in place; the edit records the editor and the time. */
export async function updateTrackedTitle(
  pool: Pool,
  now: () => Date,
  id: string,
  actorId: string,
  input: UpdateTrackedTitleInput,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const title = await loadTitle(client, id);
    if (title.merged_into_title_id !== null) {
      // An archived title is an audit row, not a working one: its records
      // moved to the survivor, so a correction belongs there.
      throw new ApiError(409, "state_conflict");
    }
    if (input.titleGroupId !== undefined) {
      const group = await client.query(
        "select id from title_groups where id = $1",
        [input.titleGroupId],
      );
      if (group.rows.length === 0) {
        throw new ApiError(404, "not_found");
      }
    }
    await client.query(
      `update tracked_titles set
         title_group_id = coalesce($2, title_group_id),
         release_year = coalesce($3, release_year),
         title_type = coalesce($4, title_type),
         runtime_minutes = coalesce($5, runtime_minutes),
         paused = coalesce($6, paused),
         updated_by = $7,
         updated_at = $8
       where id = $1`,
      [
        id,
        input.titleGroupId ?? null,
        input.releaseYear ?? null,
        input.titleType ?? null,
        input.runtimeMinutes ?? null,
        input.paused ?? null,
        actorId,
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

export interface ListTitlesFilter {
  titleGroupId?: string;
  query?: string;
  paused?: boolean;
}

/** Escapes a literal for LIKE's metacharacters. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** The catalogue list: live (non-archived) titles as TrackedTitleCards. */
export async function listTrackedTitles(
  pool: Pool,
  filter: ListTitlesFilter,
  paging: { limit: number; offset: number; page: number; pageSize: number },
): Promise<Record<string, unknown>> {
  const conditions = ["tt.merged_into_title_id is null"];
  const params: unknown[] = [];
  if (filter.titleGroupId !== undefined) {
    params.push(filter.titleGroupId);
    conditions.push(`tt.title_group_id = $${params.length}`);
  }
  if (filter.paused !== undefined) {
    params.push(filter.paused);
    conditions.push(`tt.paused = $${params.length}`);
  }
  if (filter.query !== undefined && filter.query.trim().length > 0) {
    params.push(`%${escapeLike(normalizeTitleText(filter.query.trim()))}%`);
    conditions.push(`exists (
      select 1 from title_variants fv
       where fv.tracked_title_id = tt.id and fv.normalized_text like $${params.length}
    )`);
  }
  const where = conditions.join(" and ");
  const items = await pool.query(
    `select tt.*,
            g.name as group_name,
            ov.text as display_title,
            (select count(*) from title_variants vc where vc.tracked_title_id = tt.id) as variant_count,
            (select count(*) from allowlist_entries ac
              where ac.scope = 'rights_holder'
                 or (ac.scope = 'title_group' and ac.title_group_id = tt.title_group_id)
                 or (ac.scope = 'tracked_title' and ac.tracked_title_id = tt.id)) as allowlist_count
       from tracked_titles tt
       join title_groups g on g.id = tt.title_group_id
       join title_variants ov on ov.id = tt.original_variant_id
      where ${where}
      order by ov.text, tt.id
      limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, paging.limit, paging.offset],
  );
  // The cards embed each title's identifiers; only the page's titles are
  // fetched, not the whole catalogue's.
  const identifiers = await pool.query<ExternalIdentifierRow>(
    `select * from external_identifiers
      where tracked_title_id = any($${params.length + 1}::uuid[])
      order by retrieved_at, id`,
    [items.rows.map((row) => row.id)],
  );
  const byTitle = new Map<string, ExternalIdentifierRow[]>();
  for (const row of identifiers.rows) {
    const list = byTitle.get(row.tracked_title_id) ?? [];
    list.push(row);
    byTitle.set(row.tracked_title_id, list);
  }
  const total = await pool.query<{ count: string }>(
    `select count(*) as count from tracked_titles tt where ${where}`,
    params,
  );
  return {
    items: items.rows.map((row) => ({
      id: row.id,
      displayTitle: row.display_title,
      releaseYear: row.release_year,
      titleType: row.title_type,
      titleGroupId: row.title_group_id,
      titleGroupName: row.group_name,
      variantCount: Number(row.variant_count),
      externalIdentifiers: (byTitle.get(row.id) ?? []).map(externalIdentifierJson),
      allowlistEntryCount: Number(row.allowlist_count),
      paused: row.paused,
      // mergedIntoTitleId stays absent: the list's where-clause keeps every
      // row live, so an archived title never appears here.
      // Slice 5 fills the open violation count.
      openViolationCount: 0,
    })),
    total: Number(total.rows[0].count),
    page: paging.page,
    pageSize: paging.pageSize,
  };
}

