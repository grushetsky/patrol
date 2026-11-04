import { v7 as uuidv7 } from "uuid";
import type { Queryable } from "../db.js";
import { normalizeTitle } from "./normalize.js";
import type {
  Engine,
  IntentPhrase,
  PlannedQuery,
  QueryPlan,
  TitleWithVariants,
} from "./types.js";

export const LENGTH_CAP: Record<Engine, number> = {
  google: 2_048,
  yandex: 400,
};

export const UNITS_PER_QUERY: Record<Engine, number> = {
  google: 2,
  yandex: 1,
};

export interface PlanInput {
  engine: Engine;
  locales: string[];
  intents: Record<string, IntentPhrase[]>;
  titles: TitleWithVariants[];
  now: Date;
}

const VARIANT_ORDER = ["original", "localized", "transliterated"];

/** Derive the plan for one group or one title on one engine. */
export function buildQueryPlan(input: PlanInput): QueryPlan {
  const cap = LENGTH_CAP[input.engine];
  const queries: PlannedQuery[] = [];
  const seen = new Set<string>();

  for (const title of input.titles) {
    for (const locale of input.locales) {
      const language = locale.split("-")[0].toLowerCase();
      const eligible = VARIANT_ORDER.map((kind) =>
        title.variants.find(
          (variant) =>
            variant.kind === kind &&
            (kind === "original" ||
              variant.language.split("-")[0].toLowerCase() === language),
        ),
      ).filter((variant) => variant !== undefined);

      for (const variant of eligible) {
        const text = truncateAtWord(sanitizeQuery(variant.text), cap);
        const key = normalizeTitle(text, variant.language);
        if (key.length === 0 || seen.has(key)) {
          continue;
        }
        seen.add(key);
        queries.push({
          id: uuidv7(),
          trackedTitleId: title.id,
          locale,
          kind: "variant",
          text,
          variantId: variant.id,
        });
      }

      for (const phrase of (input.intents[language] ?? []).slice(0, 2)) {
        const displayTitle = sanitizeQuery(title.displayTitle);
        let text = `${displayTitle} ${phrase.text}`;
        if (text.length > cap) {
          text = displayTitle;
        }
        text = truncateAtWord(text, cap);
        const key = normalizeTitle(text, locale);
        if (key.length === 0 || seen.has(key)) {
          continue;
        }
        seen.add(key);
        queries.push({
          id: uuidv7(),
          trackedTitleId: title.id,
          locale,
          kind: "intent",
          text,
          intentPhrase: { text: phrase.text, version: phrase.version },
        });
      }
    }
  }

  return { generatedAt: input.now.toISOString(), queries };
}

export async function loadPlanInput(
  db: Queryable,
  titleGroupId: string,
  engine: Engine,
  trackedTitleId: string | undefined,
  now: Date,
): Promise<PlanInput & { titleGroupId: string }> {
  const group = (
    await db.query("SELECT locales FROM title_group WHERE id = $1", [
      titleGroupId,
    ])
  ).rows[0];
  if (!group) {
    throw new Error("The title group does not exist.");
  }
  const titleFilter = trackedTitleId ? "AND t.id = $2" : "";
  const values: unknown[] = [titleGroupId];
  if (trackedTitleId) {
    values.push(trackedTitleId);
  }
  const rows = (
    await db.query(
      `SELECT t.id AS title_id, original.text AS display_title,
              v.id AS variant_id, v.text, v.kind, v.language, v.territory
         FROM tracked_title t
         JOIN title_variant v ON v.tracked_title_id = t.id
         JOIN title_variant original ON original.id = t.original_variant_id
        WHERE t.title_group_id = $1
          AND t.merged_into_title_id IS NULL
          AND t.paused = false
          ${titleFilter}
        ORDER BY original.text ASC, t.id ASC, v.added_at ASC`,
      values,
    )
  ).rows;

  const titles: TitleWithVariants[] = [];
  const byId = new Map<string, TitleWithVariants>();
  for (const row of rows) {
    const id = String(row.title_id);
    let title = byId.get(id);
    if (!title) {
      title = {
        id,
        displayTitle: String(row.display_title),
        variants: [],
      };
      byId.set(id, title);
      titles.push(title);
    }
    title.variants.push({
      id: String(row.variant_id),
      text: String(row.text),
      kind: String(row.kind),
      language: String(row.language),
      territory: (row.territory as string | null) ?? undefined,
    });
  }

  const intents: Record<string, IntentPhrase[]> = {};
  for (const row of (
    await db.query("SELECT * FROM intent_phrase ORDER BY locale ASC, version ASC")
  ).rows) {
    const locale = String(row.locale);
    (intents[locale] ??= []).push({
      text: String(row.text),
      version: Number(row.version),
    });
  }

  return {
    titleGroupId,
    engine,
    locales: JSON.parse(String(group.locales)) as string[],
    intents,
    titles,
    now,
  };
}

export function territoryForLocale(locale: string): string | undefined {
  const [language, region] = locale.split("-");
  if (region) {
    return region.toUpperCase();
  }
  if (language.toLowerCase() === "ru") {
    return "RU";
  }
  if (language.toLowerCase() === "en") {
    return "US";
  }
  return undefined;
}

const OPERATOR_PREFIX = /^(site|inurl|intitle|filetype|link|related):/i;

/** No query carries a quotation mark or a search operator. */
export function sanitizeQuery(text: string): string {
  return text
    .split(/\s+/)
    .filter((token) => !OPERATOR_PREFIX.test(token) && !token.startsWith("-"))
    .join(" ")
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateAtWord(text: string, cap: number): string {
  if (text.length <= cap) {
    return text;
  }
  const slice = text.slice(0, cap);
  const boundary = slice.lastIndexOf(" ");
  return (boundary > 0 ? slice.slice(0, boundary) : slice).trimEnd();
}
