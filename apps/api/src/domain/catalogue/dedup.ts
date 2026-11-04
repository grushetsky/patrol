import type { PoolClient } from "pg";
import { normalizeTitleText } from "@patrol/domain";
import { ApiError } from "../../errors.js";

/**
 * The two hard duplicate checks (docs/design/catalogue-entry.md "Duplicate
 * and near-duplicate handling"), run before a title is created, across every
 * title group, in the design's fixed order:
 *
 * 1. External identifier equality: a supplied (scheme, value) that already
 *    exists identifies that title, whatever its text says.
 * 2. Identity triple, when no identifier is supplied: the same normalized
 *    original-title text, release year, and title type identify the same
 *    work.
 *
 * Either check blocks creation with 409 duplicate_title and the
 * existingTitleId; the block is never overridden by pressing create again.
 * A same-named remake with another year or type passes and is created as
 * its own title.
 */

export interface NewIdentifierInput {
  scheme: "wikidata" | "imdb" | "kinopoisk";
  value: string;
}

export interface DuplicateCheckInput {
  externalIdentifiers: NewIdentifierInput[];
  originalText: string;
  releaseYear: number;
  titleType: "film" | "series" | "miniseries" | "other";
}

/** The surviving title the first matching check names, or null. */
export async function findDuplicate(
  client: PoolClient,
  input: DuplicateCheckInput,
): Promise<string | null> {
  // Check one: external identifier equality, across every title group.
  for (const identifier of input.externalIdentifiers) {
    const hit = await client.query<{ tracked_title_id: string }>(
      "select tracked_title_id from external_identifiers where scheme = $1 and value = $2",
      [identifier.scheme, identifier.value],
    );
    if (hit.rows.length > 0) {
      return hit.rows[0].tracked_title_id;
    }
  }

  // Check two: the identity triple of normalized original text, release
  // year, and title type.
  const normalized = normalizeTitleText(input.originalText);
  const triple = await client.query<{ id: string }>(
    `select tt.id
       from tracked_titles tt
       join title_variants v on v.tracked_title_id = tt.id and v.kind = 'original'
      where v.normalized_text = $1
        and tt.release_year = $2
        and tt.title_type = $3
        and tt.merged_into_title_id is null
      limit 1`,
    [normalized, input.releaseYear, input.titleType],
  );
  return triple.rows[0]?.id ?? null;
}

/** Runs both checks in order and raises the 409 when one matches. */
export async function assertNoDuplicate(
  client: PoolClient,
  input: DuplicateCheckInput,
): Promise<void> {
  const existingTitleId = await findDuplicate(client, input);
  if (existingTitleId !== null) {
    throw new ApiError(409, "duplicate_title", { existingTitleId });
  }
}
