import type { Pool, PoolClient } from "pg";
import { ApiError } from "../../errors.js";
import { trackedTitleJson, type TrackedTitleRow } from "./serialize.js";
import { isUniqueViolation } from "./shared.js";
import { readTitleDetail, titleDetailJson } from "./tracked-titles.js";

/**
 * Merge semantics (docs/design/catalogue-entry.md "Duplicate and
 * near-duplicate handling"). A merge is offered only while the duplicate
 * has no candidate and no violation; it moves the duplicate's variants and
 * identifiers to the surviving title and archives the duplicate with a
 * mergedInto pointer for audit. A duplicate that already has candidates is
 * cleaned up first by resolving them as "wrong work"; a duplicate with any
 * violation is never merged, because a violation is keyed by its URL and
 * tracked title, and that identity is permanent.
 */

/**
 * One guard behind the merge refusal. The predicate list is pluggable so
 * slice 5 can register the candidate and violation guards when their tables
 * arrive — forward-only migrations mean 0002 cannot reference tables that
 * do not exist yet, so until then the structural checks below carry the
 * guard alone and this list is empty by design, not by omission.
 */
export interface MergeGuardPredicate {
  /** The predicate's name, for logs and tests. */
  name: string;
  /** True when the title may not merge. */
  blocks: (client: PoolClient, titleId: string) => Promise<boolean>;
}

export const MERGE_GUARD_PREDICATES: MergeGuardPredicate[] = [
  // Slice 5 registers here:
  // - candidates: any candidate referencing the duplicate blocks the merge;
  // - violations: any violation of the duplicate blocks the merge outright.
];

export interface MergeTitlesInput {
  duplicateId: string;
  survivingTitleId: string;
}

export interface MergeResult {
  survivingTitle: Record<string, unknown>;
  archivedTitle: Record<string, unknown>;
  movedVariantCount: number;
  movedIdentifierCount: number;
}

async function loadTitle(
  client: PoolClient,
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

/**
 * Merges a duplicate into a surviving title. Variants and identifiers move;
 * the duplicate's own original variant becomes an alternate on the
 * survivor, because exactly one variant of a title is original and the
 * survivor keeps its own. Text or identifier collisions with the survivor's
 * existing rows refuse the whole merge: Patrol never silently drops a
 * variant or reassigns an identifier the survivor already holds.
 */
export async function mergeTitles(
  pool: Pool,
  now: () => Date,
  actorId: string,
  input: MergeTitlesInput,
  predicates: readonly MergeGuardPredicate[] = MERGE_GUARD_PREDICATES,
): Promise<MergeResult> {
  if (input.duplicateId === input.survivingTitleId) {
    throw new ApiError(409, "state_conflict");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const duplicate = await loadTitle(client, input.duplicateId);
    const survivor = await loadTitle(client, input.survivingTitleId);
    if (duplicate.merged_into_title_id !== null || survivor.merged_into_title_id !== null) {
      // An archived title neither merges nor absorbs: its records already
      // moved, and the archive is an audit trail, not a working row.
      throw new ApiError(409, "state_conflict");
    }
    for (const predicate of predicates) {
      if (await predicate.blocks(client, input.duplicateId)) {
        throw new ApiError(409, "state_conflict", {
          blockingTitleId: input.duplicateId,
        });
      }
    }

    // The duplicate's original variant cannot stay original on a title that
    // has one; it moves as an alternate, keeping its text and provenance.
    await client.query(
      `update title_variants
          set kind = 'alternate'
        where tracked_title_id = $1 and kind = 'original'`,
      [input.duplicateId],
    );
    try {
      const movedVariants = await client.query(
        "update title_variants set tracked_title_id = $2 where tracked_title_id = $1",
        [input.duplicateId, input.survivingTitleId],
      );
      const movedIdentifiers = await client.query(
        "update external_identifiers set tracked_title_id = $2 where tracked_title_id = $1",
        [input.duplicateId, input.survivingTitleId],
      );
      await client.query(
        `update tracked_titles
            set merged_into_title_id = $2,
                paused = true,
                updated_by = $3,
                updated_at = $4
          where id = $1`,
        [input.duplicateId, input.survivingTitleId, actorId, now().toISOString()],
      );
      await client.query("commit");
      const survivingDetail = titleDetailJson(
        await readTitleDetail(pool, input.survivingTitleId),
      );
      // The archived duplicate as the contract's TrackedTitle; its
      // mergedInto pointer names the survivor for the audit trail.
      const archivedRow = (
        await pool.query<TrackedTitleRow>(
          "select * from tracked_titles where id = $1",
          [input.duplicateId],
        )
      ).rows[0];
      return {
        survivingTitle: survivingDetail,
        archivedTitle: trackedTitleJson(archivedRow),
        movedVariantCount: movedVariants.rowCount ?? 0,
        movedIdentifierCount: movedIdentifiers.rowCount ?? 0,
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "state_conflict", {
          fieldErrors: [
            {
              path: "/survivingTitleId",
              message:
                "the survivor already holds a variant or identifier with this value; resolve the collision first",
            },
          ],
        });
      }
      throw error;
    }
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
