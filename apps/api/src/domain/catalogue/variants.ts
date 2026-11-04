import type { Pool, PoolClient } from "pg";
import { normalizeTitleText } from "@patrol/domain";
import { ApiError } from "../../errors.js";
import { titleVariantJson, type TitleVariantRow, type TrackedTitleRow } from "./serialize.js";
import { isUniqueViolation } from "./shared.js";
import { assertSingleLineText } from "./tracked-titles.js";

/**
 * "Add as variant" on an existing title: the only route by which a variant
 * joins one. Its text must be unique within the title after normalization
 * (GLOSSARY invariant); a second original is refused because exactly one
 * variant of a title is original and the original is created with the
 * title, never here. A variant whose normalized text already appears on
 * another title with the same year and type warns — the operator decides;
 * Patrol never merges two records silently.
 */

export interface AddVariantInput {
  text: string;
  kind: "original" | "localized" | "transliterated" | "alternate";
  language: string;
  script: string;
  territory?: string;
  source: "rights_holder_record" | "operator_knowledge" | "wikidata";
}

export interface AddedVariant {
  variant: Record<string, unknown>;
  similarTitleId?: string;
}

async function loadLiveTitle(
  client: PoolClient,
  trackedTitleId: string,
): Promise<TrackedTitleRow> {
  const result = await client.query<TrackedTitleRow>(
    "select * from tracked_titles where id = $1 and merged_into_title_id is null",
    [trackedTitleId],
  );
  if (result.rows.length === 0) {
    throw new ApiError(404, "not_found");
  }
  return result.rows[0];
}

/** Adds one variant, refusing repeats and original kinds, warning on twins. */
export async function addTitleVariant(
  pool: Pool,
  now: () => Date,
  trackedTitleId: string,
  actorId: string,
  input: AddVariantInput,
): Promise<AddedVariant> {
  assertSingleLineText(input.text, "/text");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const title = await loadLiveTitle(client, trackedTitleId);
    if (input.kind === "original") {
      // Exactly one variant is original and it is created with the title;
      // the partial unique index would refuse this too, but the refusal is
      // the domain's, not the index's.
      throw new ApiError(409, "state_conflict", {
        fieldErrors: [{ path: "/kind", message: "the original variant is created with the title" }],
      });
    }
    const normalized = normalizeTitleText(input.text);
    const repeat = await client.query(
      "select 1 from title_variants where tracked_title_id = $1 and normalized_text = $2",
      [trackedTitleId, normalized],
    );
    if (repeat.rows.length > 0) {
      throw new ApiError(409, "duplicate_entity", {
        fieldErrors: [{ path: "/text", message: "this text already names the title after normalization" }],
      });
    }
    const inserted = await client.query<TitleVariantRow>(
      `insert into title_variants
         (tracked_title_id, text, normalized_text, kind, language, script, territory, source, added_by, added_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning *`,
      [
        trackedTitleId,
        input.text,
        normalized,
        input.kind,
        input.language,
        input.script,
        input.territory ?? null,
        input.source,
        actorId,
        now().toISOString(),
      ],
    );
    // The advisory warning: another live title with the same normalized
    // text, year, and type. Present as a fact the operator may overrule.
    const similar = await client.query<{ id: string }>(
      `select tt.id
         from tracked_titles tt
         join title_variants v on v.tracked_title_id = tt.id
        where v.normalized_text = $1
          and tt.release_year = $2
          and tt.title_type = $3
          and tt.merged_into_title_id is null
          and tt.id <> $4
        limit 1`,
      [normalized, title.release_year, title.title_type, trackedTitleId],
    );
    await client.query("commit");
    return {
      variant: titleVariantJson(inserted.rows[0]),
      ...(similar.rows.length > 0
        ? { similarTitleId: similar.rows[0].id }
        : {}),
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The repeat pre-check's race, settled by the title's own unique
      // index: the same 409 duplicate_entity the pre-check answers.
      await client.query("rollback").catch(() => undefined);
      throw new ApiError(409, "duplicate_entity", {
        fieldErrors: [
          { path: "/text", message: "this text already names the title after normalization" },
        ],
      });
    }
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
