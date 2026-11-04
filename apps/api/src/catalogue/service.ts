import { ApiError, unprocessable } from "../errors.js";
import type { Connectable, Queryable } from "../db/migrations.js";
import { newId } from "../auth/tokens.js";
import { normalizePlainTime } from "../time.js";
import { pageOf, type Page } from "../http.js";
import { normalizeTitle, searchKey } from "./normalize.js";
import {
  toAllowlistEntry,
  toExternalIdentifier,
  toTitleGroup,
  toTitleVariant,
  toTrackedTitle,
} from "./records.js";
import {
  WikidataClient,
  type WikidataEntityFacts,
  type WikidataSource,
  type WikidataSuggestion,
} from "./wikidata.js";

export interface CreateTitleGroupInput {
  name: string;
  locales: string[];
  scanTime: string;
  priority: string;
}

export interface UpdateTitleGroupInput {
  name?: string;
  locales?: string[];
  scanTime?: string;
  priority?: string;
}

export interface NewOriginalVariantInput {
  text: string;
  language: string;
  script: string;
}

export interface NewTitleVariantInput {
  text: string;
  kind: string;
  language: string;
  script: string;
  territory?: string;
  source: string;
}

export interface NewExternalIdentifierInput {
  scheme: string;
  value: string;
}

export interface CreateTrackedTitleInput {
  titleGroupId: string;
  originalVariant: NewOriginalVariantInput;
  releaseYear: number;
  titleType: string;
  runtimeMinutes?: number;
  additionalVariants: NewTitleVariantInput[];
  externalIdentifiers: NewExternalIdentifierInput[];
  source: string;
}

export interface UpdateTrackedTitleInput {
  titleGroupId?: string;
  releaseYear?: number;
  titleType?: string;
  runtimeMinutes?: number;
  paused?: boolean;
}

export interface MergeTitlesInput {
  survivingTitleId: string;
}

export interface TitleListFilters {
  titleGroupId?: string;
  query?: string;
  paused?: boolean;
}

const IDENTIFIER_SHAPES: Record<string, RegExp> = {
  wikidata: /^Q\d+$/,
  imdb: /^tt\d{7,}$/,
  kinopoisk: /^\d+$/,
};

/** Catalogue reads and writes, keyed by Patrol's own identifiers. */
export class CatalogueService {
  constructor(
    private readonly db: Connectable,
    private readonly wikidata: WikidataSource = new WikidataClient(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async listTitleGroups(page: Page) {
    const rows = (
      await this.db.query("SELECT * FROM title_group ORDER BY name ASC")
    ).rows;
    return pageOf(rows.map(toTitleGroup), page);
  }

  async createTitleGroup(input: CreateTitleGroupInput) {
    const name = this.requireName(input.name);
    const locales = this.requireLocales(input.locales);
    const scanTime = normalizePlainTime(input.scanTime, "/scanTime");
    const now = this.clock();
    const id = newId();
    await this.db.query(
      `INSERT INTO title_group
        (id, name, locales, scan_time, priority, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [id, name, JSON.stringify(locales), scanTime, input.priority, now],
    );
    return this.readTitleGroup(id);
  }

  async readTitleGroup(id: string) {
    const row = await this.findTitleGroup(this.db, id);
    if (!row) {
      throw new ApiError(404, "not_found", "The title group does not exist.");
    }
    return toTitleGroup(row);
  }

  async updateTitleGroup(id: string, input: UpdateTitleGroupInput) {
    await this.readTitleGroup(id);
    const sets: string[] = [];
    const values: unknown[] = [];
    if (input.name !== undefined) {
      values.push(this.requireName(input.name));
      sets.push(`name = $${values.length}`);
    }
    if (input.locales !== undefined) {
      values.push(JSON.stringify(this.requireLocales(input.locales)));
      sets.push(`locales = $${values.length}`);
    }
    if (input.scanTime !== undefined) {
      values.push(normalizePlainTime(input.scanTime, "/scanTime"));
      sets.push(`scan_time = $${values.length}`);
    }
    if (input.priority !== undefined) {
      values.push(input.priority);
      sets.push(`priority = $${values.length}`);
    }
    if (sets.length > 0) {
      values.push(this.clock());
      sets.push(`updated_at = $${values.length}`);
      await this.db.query(
        `UPDATE title_group SET ${sets.join(", ")} WHERE id = $${values.length + 1}`,
        [...values, id],
      );
    }
    return this.readTitleGroup(id);
  }

  async listTitles(filters: TitleListFilters, page: Page) {
    const titleRows = (
      await this.db.query(
        `SELECT t.*, g.name AS group_name, v.text AS display_title
           FROM tracked_title t
           LEFT JOIN title_group g ON g.id = t.title_group_id
           LEFT JOIN title_variant v ON v.id = t.original_variant_id
          ORDER BY t.created_at ASC`,
      )
    ).rows;
    const variants = (
      await this.db.query("SELECT * FROM title_variant")
    ).rows;
    const identifiers = (
      await this.db.query("SELECT * FROM external_identifier")
    ).rows;
    const allowlist = (
      await this.db.query("SELECT * FROM allowlist_entry WHERE removed_at IS NULL")
    ).rows;
    const violations = (
      await this.db.query("SELECT tracked_title_id FROM violation WHERE state = 'open'")
    ).rows;

    const variantsByTitle = groupBy(variants, "tracked_title_id");
    const identifiersByTitle = groupBy(identifiers, "tracked_title_id");
    const openViolations = countBy(violations, "tracked_title_id");
    const rightsHolderEntries = allowlist.filter(
      (row) => row.scope === "rights_holder",
    ).length;
    const groupEntries = countBy(
      allowlist.filter((row) => row.scope === "title_group"),
      "title_group_id",
    );
    const titleEntries = countBy(
      allowlist.filter((row) => row.scope === "tracked_title"),
      "tracked_title_id",
    );

    const normalizedQuery =
      filters.query && filters.query.trim().length > 0
        ? searchKey(filters.query)
        : undefined;
    const cards = titleRows
      .filter((row) => {
        if (filters.titleGroupId && row.title_group_id !== filters.titleGroupId) {
          return false;
        }
        if (filters.paused !== undefined && Boolean(row.paused) !== filters.paused) {
          return false;
        }
        if (!normalizedQuery) {
          return true;
        }
        return (variantsByTitle.get(String(row.id)) ?? []).some((variant) =>
          searchKey(String(variant.text), String(variant.language)).includes(
            normalizedQuery,
          ),
        );
      })
      .map((row) => {
        const id = String(row.id);
        const groupId = String(row.title_group_id);
        return {
          id,
          displayTitle: String(row.display_title ?? ""),
          releaseYear: Number(row.release_year),
          titleType: String(row.title_type),
          titleGroupId: groupId,
          titleGroupName: String(row.group_name ?? ""),
          variantCount: (variantsByTitle.get(id) ?? []).length,
          externalIdentifiers: (identifiersByTitle.get(id) ?? []).map(
            toExternalIdentifier,
          ),
          allowlistEntryCount:
            rightsHolderEntries +
            (groupEntries.get(groupId) ?? 0) +
            (titleEntries.get(id) ?? 0),
          paused: Boolean(row.paused),
          mergedIntoTitleId:
            (row.merged_into_title_id as string | null) ?? undefined,
          openViolationCount: openViolations.get(id) ?? 0,
        };
      })
      .sort((left, right) => left.displayTitle.localeCompare(right.displayTitle));

    return pageOf(cards, page);
  }

  async createTitle(input: CreateTrackedTitleInput, operatorId: string) {
    return this.withClient(async (db) => {
      if (!(await this.findTitleGroup(db, input.titleGroupId))) {
        throw unprocessable([
          { path: "/titleGroupId", message: "No such title group." },
        ]);
      }

      const originalNormalized = this.requireNormalizedText(
        input.originalVariant.text,
        input.originalVariant.language,
        "/originalVariant/text",
      );
      const additional = input.additionalVariants ?? [];
      const normalized = new Map<string, number>();
      normalized.set(originalNormalized, -1);
      additional.forEach((variant, index) => {
        if (variant.kind === "original") {
          throw unprocessable([
            {
              path: `/additionalVariants/${index}/kind`,
              message: "The original variant is created with the title.",
            },
          ]);
        }
        const key = this.requireNormalizedText(
          variant.text,
          variant.language,
          `/additionalVariants/${index}/text`,
        );
        if (normalized.has(key)) {
          throw new ApiError(
            409,
            "duplicate_entity",
            "A variant with that text already exists on this title.",
          );
        }
        normalized.set(key, index);
      });

      const identifiers = input.externalIdentifiers ?? [];
      const seen = new Set<string>();
      identifiers.forEach((identifier, index) => {
        this.requireIdentifierShape(
          identifier,
          `/externalIdentifiers/${index}/value`,
        );
        const key = `${identifier.scheme}:${identifier.value}`;
        if (seen.has(key)) {
          throw new ApiError(
            409,
            "duplicate_entity",
            "The same external identifier appears twice.",
          );
        }
        seen.add(key);
      });
      for (const identifier of identifiers) {
        const existing = await db.query(
          "SELECT id, tracked_title_id FROM external_identifier WHERE scheme = $1 AND value = $2 LIMIT 1",
          [identifier.scheme, identifier.value],
        );
        if (existing.rows.length > 0) {
          throw new ApiError(
            409,
            "duplicate_title",
            "That external identifier already belongs to a tracked title.",
            undefined,
            { existingTitleId: String(existing.rows[0].tracked_title_id) },
          );
        }
      }

      if (identifiers.length === 0) {
        const duplicate = await db.query(
          `SELECT t.id
             FROM tracked_title t
             JOIN title_variant v ON v.tracked_title_id = t.id
            WHERE t.merged_into_title_id IS NULL
              AND t.release_year = $1
              AND t.title_type = $2
              AND v.id = t.original_variant_id
              AND v.normalized_text = $3
            LIMIT 1`,
          [input.releaseYear, input.titleType, originalNormalized],
        );
        if (duplicate.rows.length > 0) {
          throw new ApiError(
            409,
            "duplicate_title",
            "An identical title, year, and type already exists.",
            undefined,
            { existingTitleId: String(duplicate.rows[0].id) },
          );
        }
      }

      const now = this.clock();
      const titleId = newId();
      const originalVariantId = newId();
      await db.query(
        `INSERT INTO tracked_title
          (id, title_group_id, release_year, title_type, runtime_minutes,
           original_variant_id, paused, merged_into_title_id, source,
           entered_by, entered_at, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, false, NULL, $7, $8, $9, $8, $9, $9)`,
        [
          titleId,
          input.titleGroupId,
          input.releaseYear,
          input.titleType,
          input.runtimeMinutes ?? null,
          originalVariantId,
          input.source,
          operatorId,
          now,
        ],
      );
      await db.query(
        `INSERT INTO title_variant
          (id, tracked_title_id, text, normalized_text, kind, language, script,
           territory, source, added_by, added_at)
         VALUES ($1, $2, $3, $4, 'original', $5, $6, NULL, $7, $8, $9)`,
        [
          originalVariantId,
          titleId,
          input.originalVariant.text,
          originalNormalized,
          input.originalVariant.language,
          input.originalVariant.script,
          input.source,
          operatorId,
          now,
        ],
      );
      for (const variant of additional) {
        await db.query(
          `INSERT INTO title_variant
            (id, tracked_title_id, text, normalized_text, kind, language, script,
             territory, source, added_by, added_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            newId(),
            titleId,
            variant.text,
            normalizeTitle(variant.text, variant.language),
            variant.kind,
            variant.language,
            variant.script,
            variant.territory ?? null,
            variant.source,
            operatorId,
            now,
          ],
        );
      }
      for (const identifier of identifiers) {
        await db.query(
          `INSERT INTO external_identifier
            (id, tracked_title_id, scheme, value, source, retrieved_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [newId(), titleId, identifier.scheme, identifier.value, input.source, now],
        );
      }

      return this.titleDetail(db, titleId);
    });
  }

  async readTitle(id: string) {
    return this.titleDetail(this.db, id);
  }

  async updateTitle(
    id: string,
    input: UpdateTrackedTitleInput,
    operatorId: string,
  ) {
    return this.withClient(async (db) => {
      const existing = await this.findTitle(db, id);
      if (!existing) {
        throw new ApiError(404, "not_found", "The tracked title does not exist.");
      }
      if (input.titleGroupId !== undefined) {
        const group = await this.findTitleGroup(db, input.titleGroupId);
        if (!group) {
          throw unprocessable([
            { path: "/titleGroupId", message: "No such title group." },
          ]);
        }
      }
      const sets: string[] = [];
      const values: unknown[] = [];
      if (input.titleGroupId !== undefined) {
        values.push(input.titleGroupId);
        sets.push(`title_group_id = $${values.length}`);
      }
      if (input.releaseYear !== undefined) {
        values.push(input.releaseYear);
        sets.push(`release_year = $${values.length}`);
      }
      if (input.titleType !== undefined) {
        values.push(input.titleType);
        sets.push(`title_type = $${values.length}`);
      }
      if (input.runtimeMinutes !== undefined) {
        values.push(input.runtimeMinutes);
        sets.push(`runtime_minutes = $${values.length}`);
      }
      if (input.paused !== undefined) {
        values.push(input.paused);
        sets.push(`paused = $${values.length}`);
      }
      values.push(operatorId, this.clock());
      sets.push(`updated_by = $${values.length - 1}`, `updated_at = $${values.length}`);
      await db.query(
        `UPDATE tracked_title SET ${sets.join(", ")} WHERE id = $${values.length + 1}`,
        [...values, id],
      );
      return this.titleDetail(db, id);
    });
  }

  async addVariant(
    id: string,
    input: NewTitleVariantInput,
    operatorId: string,
  ) {
    return this.withClient(async (db) => {
      const title = await this.findTitle(db, id);
      if (!title || title.merged_into_title_id) {
        throw new ApiError(404, "not_found", "The tracked title does not exist.");
      }
      if (input.kind === "original") {
        throw unprocessable([
          {
            path: "/kind",
            message: "A title has exactly one original variant.",
          },
        ]);
      }
      const normalized = this.requireNormalizedText(
        input.text,
        input.language,
        "/text",
      );
      const existing = await db.query(
        "SELECT id FROM title_variant WHERE tracked_title_id = $1 AND normalized_text = $2 LIMIT 1",
        [id, normalized],
      );
      if (existing.rows.length > 0) {
        throw new ApiError(
          409,
          "duplicate_entity",
          "A variant with that text already exists on this title.",
        );
      }
      const similar = await db.query(
        `SELECT t.id
           FROM tracked_title t
           JOIN title_variant v ON v.tracked_title_id = t.id
          WHERE t.id <> $1
            AND t.merged_into_title_id IS NULL
            AND t.release_year = $2
            AND t.title_type = $3
            AND v.normalized_text = $4
          LIMIT 1`,
        [id, title.release_year, title.title_type, normalized],
      );

      const variantId = newId();
      await db.query(
        `INSERT INTO title_variant
          (id, tracked_title_id, text, normalized_text, kind, language, script,
           territory, source, added_by, added_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          variantId,
          id,
          input.text,
          normalized,
          input.kind,
          input.language,
          input.script,
          input.territory ?? null,
          input.source,
          operatorId,
          this.clock(),
        ],
      );
      const variant = (
        await db.query("SELECT * FROM title_variant WHERE id = $1", [variantId])
      ).rows[0];
      return {
        variant: toTitleVariant(variant),
        similarTitleId:
          similar.rows.length > 0 ? String(similar.rows[0].id) : undefined,
      };
    });
  }

  async addExternalIdentifier(
    id: string,
    input: NewExternalIdentifierInput,
  ) {
    return this.withClient(async (db) => {
      const title = await this.findTitle(db, id);
      if (!title || title.merged_into_title_id) {
        throw new ApiError(404, "not_found", "The tracked title does not exist.");
      }
      this.requireIdentifierShape(input, "/value");
      const existing = await db.query(
        "SELECT id, tracked_title_id FROM external_identifier WHERE scheme = $1 AND value = $2 LIMIT 1",
        [input.scheme, input.value],
      );
      if (existing.rows.length > 0) {
        throw new ApiError(
          409,
          "duplicate_entity",
          "That external identifier already belongs to a tracked title.",
          undefined,
          { existingTitleId: String(existing.rows[0].tracked_title_id) },
        );
      }
      const identifierId = newId();
      const now = this.clock();
      await db.query(
        `INSERT INTO external_identifier
          (id, tracked_title_id, scheme, value, source, retrieved_at)
         VALUES ($1, $2, $3, $4, 'operator_knowledge', $5)`,
        [identifierId, id, input.scheme, input.value, now],
      );
      const row = (
        await db.query("SELECT * FROM external_identifier WHERE id = $1", [
          identifierId,
        ])
      ).rows[0];
      return toExternalIdentifier(row);
    });
  }

  async removeExternalIdentifier(id: string, identifierId: string) {
    const existing = await this.db.query(
      "SELECT id FROM external_identifier WHERE id = $1 AND tracked_title_id = $2",
      [identifierId, id],
    );
    if (existing.rows.length === 0) {
      throw new ApiError(404, "not_found", "The external identifier does not exist.");
    }
    await this.db.query("DELETE FROM external_identifier WHERE id = $1", [
      identifierId,
    ]);
  }

  async mergeTitles(
    id: string,
    input: MergeTitlesInput,
    operatorId: string,
  ) {
    return this.withClient(async (db) => {
      const duplicate = await this.findTitle(db, id);
      const survivor = await this.findTitle(db, input.survivingTitleId);
      if (
        !duplicate ||
        !survivor ||
        duplicate.merged_into_title_id ||
        survivor.merged_into_title_id
      ) {
        throw new ApiError(404, "not_found", "The tracked title does not exist.");
      }
      if (id === input.survivingTitleId) {
        throw new ApiError(
          422,
          "validation_failed",
          "A title cannot be merged into itself.",
        );
      }
      const candidates = await db.query(
        "SELECT id FROM candidate WHERE tracked_title_id = $1 LIMIT 1",
        [id],
      );
      const violations = await db.query(
        "SELECT id FROM violation WHERE tracked_title_id = $1 LIMIT 1",
        [id],
      );
      if (candidates.rows.length > 0 || violations.rows.length > 0) {
        throw new ApiError(
          409,
          "state_conflict",
          "The duplicate still has a candidate or a violation.",
          undefined,
          { blockingTitleId: id },
        );
      }

      const survivorVariants = (
        await db.query(
          "SELECT normalized_text FROM title_variant WHERE tracked_title_id = $1",
          [input.survivingTitleId],
        )
      ).rows;
      const taken = new Set(survivorVariants.map((row) => String(row.normalized_text)));
      const duplicateVariants = (
        await db.query("SELECT * FROM title_variant WHERE tracked_title_id = $1", [id])
      ).rows;
      let movedVariantCount = 0;
      for (const variant of duplicateVariants) {
        // The archived title keeps its original variant as its display title.
        if (String(variant.id) === String(duplicate.original_variant_id)) {
          continue;
        }
        if (taken.has(String(variant.normalized_text))) {
          continue;
        }
        await db.query(
          "UPDATE title_variant SET tracked_title_id = $2 WHERE id = $1",
          [String(variant.id), input.survivingTitleId],
        );
        movedVariantCount += 1;
      }
      const movedIdentifiers = await db.query(
        "UPDATE external_identifier SET tracked_title_id = $2 WHERE tracked_title_id = $1 RETURNING id",
        [id, input.survivingTitleId],
      );
      await db.query(
        "UPDATE tracked_title SET merged_into_title_id = $2, updated_by = $3, updated_at = $4 WHERE id = $1",
        [id, input.survivingTitleId, operatorId, this.clock()],
      );
      const archivedRow = await this.findTitle(db, id);
      return {
        survivingTitle: await this.titleDetail(db, input.survivingTitleId),
        archivedTitle: toTrackedTitle(archivedRow!),
        movedVariantCount,
        movedIdentifierCount: movedIdentifiers.rows.length,
      };
    });
  }

  async search(query: string, titleGroupId?: string) {
    const trimmed = query.trim();
    const rows = (
      await this.db.query(
        `SELECT t.id AS title_id, t.title_group_id, t.release_year, t.title_type,
                g.name AS group_name, original.text AS display_title, v.*
           FROM title_variant v
           JOIN tracked_title t ON t.id = v.tracked_title_id
           LEFT JOIN title_group g ON g.id = t.title_group_id
           LEFT JOIN title_variant original ON original.id = t.original_variant_id
          WHERE t.merged_into_title_id IS NULL
          ORDER BY v.added_at ASC`,
      )
    ).rows;
    const key = searchKey(trimmed);
    const best = new Map<string, { rank: number; row: Record<string, unknown> }>();
    if (key.length > 0) {
      for (const row of rows) {
        if (titleGroupId && row.title_group_id !== titleGroupId) {
          continue;
        }
        const candidate = searchKey(String(row.text), String(row.language));
        const rank = candidate === key ? 0 : candidate.startsWith(key) ? 1 : candidate.includes(key) ? 2 : -1;
        if (rank < 0) {
          continue;
        }
        const titleId = String(row.title_id);
        const current = best.get(titleId);
        if (!current || rank < current.rank) {
          best.set(titleId, { rank, row });
        }
      }
    }
    const suggestions = [...best.values()]
      .sort((left, right) => {
        if (left.rank !== right.rank) {
          return left.rank - right.rank;
        }
        return String(left.row.text).localeCompare(String(right.row.text));
      })
      .slice(0, 10)
      .map(({ row }) => ({
        trackedTitleId: String(row.title_id),
        displayTitle: String(row.display_title ?? row.text),
        releaseYear: Number(row.release_year),
        titleType: String(row.title_type),
        titleGroupId: String(row.title_group_id),
        titleGroupName: String(row.group_name ?? ""),
        matchedVariant: {
          id: String(row.id),
          text: String(row.text),
          kind: String(row.kind),
          language: String(row.language),
          script: String(row.script),
          territory: (row.territory as string | null) ?? undefined,
        },
      }));

    return {
      query: trimmed,
      suggestions,
      createProposal: trimmed,
    };
  }

  searchWikidata(query: string, locale: string): Promise<WikidataSuggestion[]> {
    if (query.trim().length < 3) {
      return Promise.resolve([]);
    }
    return this.wikidata.search(query, locale);
  }

  readWikidataEntity(qid: string): Promise<WikidataEntityFacts> {
    return this.wikidata.entity(qid);
  }

  private async titleDetail(db: Queryable, id: string) {
    const row = await this.findTitle(db, id);
    if (!row) {
      throw new ApiError(404, "not_found", "The tracked title does not exist.");
    }
    const variants = (
      await db.query(
        "SELECT * FROM title_variant WHERE tracked_title_id = $1 ORDER BY added_at ASC, id ASC",
        [id],
      )
    ).rows;
    const identifiers = (
      await db.query(
        "SELECT * FROM external_identifier WHERE tracked_title_id = $1 ORDER BY retrieved_at ASC",
        [id],
      )
    ).rows;
    const allowlist = (
      await db.query(
        `SELECT * FROM allowlist_entry
          WHERE removed_at IS NULL
            AND (scope = 'rights_holder'
              OR (scope = 'title_group' AND title_group_id = $1)
              OR (scope = 'tracked_title' AND tracked_title_id = $2))
          ORDER BY confirmed_at DESC`,
        [String(row.title_group_id), id],
      )
    ).rows;
    const candidates = await db.query(
      "SELECT count(*) AS count FROM candidate WHERE tracked_title_id = $1",
      [id],
    );
    const violations = await db.query(
      "SELECT count(*) AS count FROM violation WHERE tracked_title_id = $1 AND state = 'open'",
      [id],
    );
    const displayTitle =
      variants.find((variant) => variant.id === row.original_variant_id)?.text ??
      variants[0]?.text ??
      "";

    return {
      title: toTrackedTitle(row),
      displayTitle: String(displayTitle),
      variants: variants.map(toTitleVariant),
      externalIdentifiers: identifiers.map(toExternalIdentifier),
      allowlistEntries: allowlist.map(toAllowlistEntry),
      counts: {
        variants: variants.length,
        externalIdentifiers: identifiers.length,
        allowlistEntries: allowlist.length,
        candidates: Number(candidates.rows[0]?.count ?? 0),
        openViolations: Number(violations.rows[0]?.count ?? 0),
        // Notice citations arrive with the notice tables; none can exist yet.
        notices: 0,
      },
    };
  }

  private async findTitle(db: Queryable, id: string) {
    const rows = (
      await db.query("SELECT * FROM tracked_title WHERE id = $1", [id])
    ).rows;
    return rows[0];
  }

  private async findTitleGroup(db: Queryable, id: string) {
    const rows = (
      await db.query("SELECT * FROM title_group WHERE id = $1", [id])
    ).rows;
    return rows[0];
  }

  private requireName(value: string) {
    const name = value.trim();
    if (name.length === 0) {
      throw unprocessable([{ path: "/name", message: "A name is required." }]);
    }
    return name;
  }

  private requireLocales(value: string[]) {
    if (!Array.isArray(value) || value.length === 0) {
      throw unprocessable([
        { path: "/locales", message: "At least one locale is required." },
      ]);
    }
    return [...new Set(value)];
  }

  private requireNormalizedText(text: string, language: string, path: string) {
    const normalized = normalizeTitle(text, language);
    if (normalized.length === 0) {
      throw unprocessable([
        { path, message: "The title text is empty after normalization." },
      ]);
    }
    return normalized;
  }

  private requireIdentifierShape(
    identifier: NewExternalIdentifierInput,
    path: string,
  ) {
    const pattern = IDENTIFIER_SHAPES[identifier.scheme];
    if (!pattern || !pattern.test(identifier.value)) {
      throw new ApiError(
        422,
        "validation_failed",
        "The external identifier does not match its scheme.",
        undefined,
        {
          fieldErrors: [
            {
              path,
              message: `does not match the ${identifier.scheme} identifier shape`,
            },
          ],
        },
      );
    }
  }

  private async withClient<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function groupBy(
  rows: Array<Record<string, unknown>>,
  key: string,
): Map<string, Array<Record<string, unknown>>> {
  const result = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const id = String(row[key]);
    const bucket = result.get(id);
    if (bucket) {
      bucket.push(row);
    } else {
      result.set(id, [row]);
    }
  }
  return result;
}

function countBy(
  rows: Array<Record<string, unknown>>,
  key: string,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    const id = String(row[key]);
    result.set(id, (result.get(id) ?? 0) + 1);
  }
  return result;
}
