import type { Pool } from "pg";
import { normalizeTitleText } from "@patrol/domain";
import { variantSnapshotJson } from "./serialize.js";

/**
 * The local half of the add-title field: the catalogue's own index over
 * every variant of every tracked title, across every title group, so a
 * duplicate is caught before another record exists
 * (docs/design/catalogue-entry.md "The entry surface").
 *
 * Ranking choice, documented: an exact normalized-text match ranks first, a
 * prefix match second, a containment match third — equal ranks order by the
 * display title. This is deliberately pragmatic (ILIKE containment over the
 * stored normalized key); slice 5's matcher replaces the ranking with the
 * similarity scoring the matching document fixes, without changing the
 * response shape.
 */

export interface CatalogueSuggestion {
  trackedTitleId: string;
  displayTitle: string;
  releaseYear: number;
  titleType: string;
  titleGroupId: string;
  titleGroupName: string;
  matchedVariant: Record<string, unknown>;
}

export interface CatalogueSearchResult {
  query: string;
  suggestions: CatalogueSuggestion[];
  createProposal: string;
}

/** The local suggestion count, kept at Wikidata's limit of ten. */
export const LOCAL_SUGGESTION_LIMIT = 10;

/** Escapes a literal for LIKE's metacharacters. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Searches the local catalogue. The answer always offers free-text creation
 * as well: createProposal echoes the query, and an empty or unmatched query
 * still returns the proposal.
 */
export async function searchCatalogue(
  pool: Pool,
  input: { query: string; titleGroupId?: string },
): Promise<CatalogueSearchResult> {
  const result: CatalogueSearchResult = {
    query: input.query,
    suggestions: [],
    createProposal: input.query,
  };
  const normalized = normalizeTitleText(input.query.trim());
  if (normalized.length === 0) {
    return result;
  }
  const needle = escapeLike(normalized);
  const params: unknown[] = [needle, `${needle}%`, `%${needle}%`];
  const groupFilter =
    input.titleGroupId !== undefined
      ? `and tt.title_group_id = $${(params.push(input.titleGroupId), params.length)}`
      : "";
  const rows = await pool.query(
    `select tt.id, tt.release_year, tt.title_type, tt.title_group_id,
            g.name as group_name,
            ov.text as display_title,
            v.id as matched_id, v.text as matched_text, v.normalized_text,
            v.kind, v.language, v.script, v.territory, v.source, v.added_by, v.added_at,
            (case when v.normalized_text = $1 then 0
                  when v.normalized_text like $2 then 1
                  else 2 end) as rank
       from title_variants v
       join tracked_titles tt on tt.id = v.tracked_title_id
       join title_groups g on g.id = tt.title_group_id
       join title_variants ov on ov.id = tt.original_variant_id
      where tt.merged_into_title_id is null
        and (v.normalized_text = $1 or v.normalized_text like $2 or v.normalized_text like $3)
        ${groupFilter}
      order by rank asc, ov.text asc, v.added_at asc
      limit 40`,
    params,
  );
  const seen = new Set<string>();
  for (const row of rows.rows) {
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    result.suggestions.push({
      trackedTitleId: row.id,
      displayTitle: row.display_title,
      releaseYear: row.release_year,
      titleType: row.title_type,
      titleGroupId: row.title_group_id,
      titleGroupName: row.group_name,
      matchedVariant: variantSnapshotJson({
        id: row.matched_id,
        tracked_title_id: row.id,
        text: row.matched_text,
        normalized_text: row.normalized_text,
        kind: row.kind,
        language: row.language,
        script: row.script,
        territory: row.territory,
        source: row.source,
        added_by: row.added_by,
        added_at: row.added_at,
      }),
    });
    if (result.suggestions.length === LOCAL_SUGGESTION_LIMIT) {
      break;
    }
  }
  return result;
}
