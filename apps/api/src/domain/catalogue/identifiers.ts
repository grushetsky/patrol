import type { Pool, PoolClient } from "pg";
import { ApiError } from "../../errors.js";
import { externalIdentifierJson, type ExternalIdentifierRow } from "./serialize.js";
import { isUniqueViolation } from "./shared.js";

/**
 * External identifier facts: shapes, uniqueness, and lifecycle. The accepted
 * shapes (docs/design/catalogue-entry.md): a Wikidata QID (`Q` followed by
 * digits), an IMDb id (`tt` followed by at least seven digits), and a
 * KinoPoisk id (digits). A value is unique within its scheme across
 * tracked titles — identifier equality identifies one title whatever its
 * text says. A KinoPoisk id is lawful as a fact, preferably from Wikidata's
 * CC0 P2603 statement; no KinoPoisk page is ever fetched.
 */

export type IdentifierScheme = "wikidata" | "imdb" | "kinopoisk";

/** The accepted shape per scheme, as anchored regular expressions. */
const SHAPES: Record<IdentifierScheme, RegExp> = {
  wikidata: /^Q\d+$/,
  imdb: /^tt\d{7,}$/,
  kinopoisk: /^\d+$/,
};

/** True when the value carries the scheme's accepted shape. */
export function isValidIdentifierValue(scheme: IdentifierScheme, value: string): boolean {
  return SHAPES[scheme].test(value);
}

/**
 * Validates one identifier's shape, answering 400 validation_failed with the
 * offending field when it does not match.
 */
export function assertIdentifierShape(scheme: IdentifierScheme, value: string): void {
  if (!isValidIdentifierValue(scheme, value)) {
    throw new ApiError(400, "validation_failed", {
      fieldErrors: [
        {
          path: "/value",
          message: `not an accepted ${scheme} identifier shape`,
        },
      ],
    });
  }
}

async function findTitleRow(
  client: Pool | PoolClient,
  trackedTitleId: string,
): Promise<{ id: string } | null> {
  const result = await client.query<{ id: string }>(
    "select id from tracked_titles where id = $1 and merged_into_title_id is null",
    [trackedTitleId],
  );
  return result.rows[0] ?? null;
}

async function findIdentifierRow(
  client: Pool | PoolClient,
  trackedTitleId: string,
  externalIdentifierId: string,
): Promise<ExternalIdentifierRow | null> {
  const result = await client.query<ExternalIdentifierRow>(
    `select ei.* from external_identifiers ei
       join tracked_titles tt on tt.id = ei.tracked_title_id
      where ei.id = $1 and ei.tracked_title_id = $2
        and tt.merged_into_title_id is null`,
    [externalIdentifierId, trackedTitleId],
  );
  return result.rows[0] ?? null;
}

export interface AddIdentifierInput {
  scheme: IdentifierScheme;
  value: string;
  source: "rights_holder_record" | "operator_knowledge" | "wikidata";
}

/**
 * Records one identifier on a title. The shape is validated first; a
 * scheme-and-value pair that already exists is refused with the title that
 * holds it (409 duplicate_entity, existingTitleId).
 */
export async function addExternalIdentifier(
  pool: Pool,
  now: () => Date,
  trackedTitleId: string,
  input: AddIdentifierInput,
): Promise<Record<string, unknown>> {
  assertIdentifierShape(input.scheme, input.value);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const title = await findTitleRow(client, trackedTitleId);
    if (title === null) {
      await client.query("rollback");
      throw new ApiError(404, "not_found");
    }
    const existing = await client.query<{ tracked_title_id: string }>(
      "select tracked_title_id from external_identifiers where scheme = $1 and value = $2",
      [input.scheme, input.value],
    );
    if (existing.rows.length > 0) {
      await client.query("rollback");
      throw new ApiError(409, "duplicate_entity", {
        existingTitleId: existing.rows[0].tracked_title_id,
      });
    }
    const inserted = await client.query<ExternalIdentifierRow>(
      `insert into external_identifiers (tracked_title_id, scheme, value, source, retrieved_at)
       values ($1, $2, $3, $4, $5)
       returning *`,
      [trackedTitleId, input.scheme, input.value, input.source, now().toISOString()],
    );
    await client.query("commit");
    return externalIdentifierJson(inserted.rows[0]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The existence pre-check's race, settled by the scheme-and-value
      // unique index. The failed statement leaves the transaction aborted,
      // so the rollback runs first and the re-query reads outside it —
      // where READ COMMITTED sees the winner and the refusal names the
      // title that holds the value, exactly like the pre-check's 409.
      await client.query("rollback").catch(() => undefined);
      const owning = await client
        .query<{ tracked_title_id: string }>(
          "select tracked_title_id from external_identifiers where scheme = $1 and value = $2",
          [input.scheme, input.value],
        )
        .catch(() => null);
      throw new ApiError(409, "duplicate_entity", {
        ...(owning !== null && owning.rows.length > 0
          ? { existingTitleId: owning.rows[0].tracked_title_id }
          : {}),
      });
    }
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Removes a wrong identifier. The correction records nothing else: the
 * identifier was a fact, not a key, so the record keeps its candidates,
 * violations, and notices keyed by Patrol's own title id either way.
 */
export async function removeExternalIdentifier(
  pool: Pool,
  trackedTitleId: string,
  externalIdentifierId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const row = await findIdentifierRow(client, trackedTitleId, externalIdentifierId);
    if (row === null) {
      await client.query("rollback");
      throw new ApiError(404, "not_found");
    }
    await client.query("delete from external_identifiers where id = $1", [
      externalIdentifierId,
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
