import { newDb } from "pg-mem";
import { migrate, type Connectable } from "../../api/src/db/migrations.js";

export const MIGRATIONS_DIR = new URL(
  "../../api/drizzle",
  import.meta.url,
).pathname;

export async function memoryDb(): Promise<Connectable> {
  const memory = newDb();
  const adapter = memory.adapters.createPg();
  const db = new adapter.Pool() as unknown as Connectable;
  await migrate(db, MIGRATIONS_DIR);
  return db;
}

export async function seedCatalogue(
  db: Connectable,
  options: {
    locales?: string[];
    original?: { text: string; language: string };
    localized?: { text: string; language: string };
  } = {},
): Promise<{ groupId: string; titleId: string; variantId: string }> {
  const groupId = "group-1";
  const titleId = "title-1";
  const variantId = "variant-1";
  const now = new Date("2026-11-04T03:00:00Z");
  await db.query(
    `INSERT INTO title_group
      (id, name, locales, scan_time, priority, created_at, updated_at)
     VALUES ($1, 'Group', $2, '02:00:00', 'normal', $3, $3)`,
    [groupId, JSON.stringify(options.locales ?? ["ru-RU"]), now],
  );
  await db.query(
    `INSERT INTO tracked_title
      (id, title_group_id, release_year, title_type, runtime_minutes,
       original_variant_id, paused, merged_into_title_id, source,
       entered_by, entered_at, updated_by, created_at, updated_at)
     VALUES ($1, $2, 1975, 'film', 184, $3, false, NULL,
             'operator_knowledge', 'operator', $4, 'operator', $4, $4)`,
    [titleId, groupId, variantId, now],
  );
  await db.query(
    `INSERT INTO title_variant
      (id, tracked_title_id, text, normalized_text, kind, language, script,
       territory, source, added_by, added_at)
     VALUES ($1, $2, $3, $4, 'original', $5, 'Cyrl', NULL,
             'operator_knowledge', 'operator', $6)`,
    [
      variantId,
      titleId,
      options.original?.text ?? "Ирония судьбы",
      "ironiya sudby",
      options.original?.language ?? "ru-RU",
      now,
    ],
  );
  if (options.localized) {
    await db.query(
      `INSERT INTO title_variant
        (id, tracked_title_id, text, normalized_text, kind, language, script,
         territory, source, added_by, added_at)
       VALUES ('variant-2', $1, $2, $3, 'localized', $4, 'Latn', NULL,
               'operator_knowledge', 'operator', $5)`,
      [
        titleId,
        options.localized.text,
        options.localized.text.toLowerCase(),
        options.localized.language,
        now,
      ],
    );
  }
  return { groupId, titleId, variantId };
}

export async function seedScan(
  db: Connectable,
  options: {
    groupId?: string;
    engine?: "google" | "yandex";
    trigger?: string;
    dueDate?: string;
    state?: string;
    createdAt?: Date;
  } = {},
): Promise<string> {
  const id = `scan-${Math.random().toString(36).slice(2, 10)}`;
  await db.query(
    `INSERT INTO scan
      (id, title_group_id, engine, trigger, due_date, requested_by,
       tracked_title_id, planned_queries, query_plan, state, queued_at,
       queued_reason, started_at, finished_at, issued_queries,
       failure_reason, failures, created_at)
     VALUES ($1, $2, $3, $4, $5, NULL, NULL, 0, NULL, $6, $7, NULL, NULL,
             NULL, NULL, NULL, NULL, $7)`,
    [
      id,
      options.groupId ?? "group-1",
      options.engine ?? "google",
      options.trigger ?? "scheduled",
      options.dueDate ?? "2026-11-04",
      options.state ?? "queued",
      options.createdAt ?? new Date("2026-11-04T03:00:00Z"),
    ],
  );
  return id;
}
