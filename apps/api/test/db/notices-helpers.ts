import type { Pool } from "pg";
import type {
  ArtifactUpload,
  EvidenceStore,
  PresignRequest,
  PresignedDownload,
  StoredObject,
} from "@patrol/evidence";
import { artifactKey } from "@patrol/evidence";

/**
 * The notice lifecycle suites' shared seeding and fakes: the catalogue and
 * violation seeds the compose suite uses, plus the recording pack store the
 * approval and handoff suites inject in place of S3. Nothing here touches
 * the HTTP ceremony; the callers bring their own signed-in operator.
 */

export const FROZEN = "2026-01-01T00:00:00.000Z";

export interface NoticeWorld {
  operatorId: string;
  titleA: string;
  titleB: string;
  variantA: string;
  variantB: string;
}

export async function seedTitle(
  pool: Pool,
  operatorId: string,
  name: string,
  year: number,
): Promise<{ titleId: string; variantId: string }> {
  const group = await pool.query<{ id: string }>(
    `insert into title_groups (name, locales) values ($1, '{en}') returning id`,
    [name],
  );
  const title = await pool.query<{ id: string }>(
    `insert into tracked_titles
       (title_group_id, release_year, title_type, runtime_minutes, source, entered_by, entered_at, updated_by, created_at, updated_at)
     values ($1, $2, 'film', 100, 'operator_knowledge', $3, $4, $3, $4, $4) returning id`,
    [group.rows[0].id, year, operatorId, FROZEN],
  );
  const variant = await pool.query<{ id: string }>(
    `insert into title_variants
       (tracked_title_id, text, normalized_text, kind, language, script, source, added_by, added_at)
     values ($1, $2, lower($2), 'original', 'en', 'Latn', 'operator_knowledge', $3, $4) returning id`,
    [title.rows[0].id, name, operatorId, FROZEN],
  );
  await pool.query("update tracked_titles set original_variant_id = $2 where id = $1", [
    title.rows[0].id,
    variant.rows[0].id,
  ]);
  return { titleId: title.rows[0].id, variantId: variant.rows[0].id };
}

/** One OPEN violation with a confirmed decision and one pinned capture. */
export async function seedViolation(
  pool: Pool,
  world: NoticeWorld,
  input: {
    url: string;
    titleId?: string;
    variantId?: string;
    confirmedAt?: string;
    observedAt?: string;
    outcome?: "captured" | "dead";
  },
): Promise<string> {
  const host = new URL(input.url).hostname;
  const normalized = `${host}${new URL(input.url).pathname}`;
  const confirmedAt = input.confirmedAt ?? FROZEN;
  const observedAt = input.observedAt ?? confirmedAt;
  const candidate = await pool.query<{ id: string }>(
    `insert into candidates
       (tracked_title_id, url, normalized_url, host, registrable_domain, source, engine,
        engines, best_rank, matched_variant_id, matched_variant, score, band,
        score_components, reputation, first_seen_at, last_observed_at, state,
        review_decision_id, violation_id, confirmed_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'serp', 'google', '{google}', 1, $6,
        '{"id":"x","text":"v","kind":"original","language":"en","script":"Latn"}'::jsonb,
        0.75, 'b', '{"titleMatch":0.6,"signals":[],"reputation":0}'::jsonb,
        '{"registrableDomain":"","confirmedViolations":0,"bonus":0,"blocklisted":false}'::jsonb,
        $7, $7, 'pending', null, null, null, $7, $7)
     returning id`,
    [
      input.titleId ?? world.titleA,
      input.url,
      normalized,
      host,
      host.split(".").slice(-2).join("."),
      input.variantId ?? world.variantA,
      confirmedAt,
    ],
  );
  const capture = await pool.query<{ id: string }>(
    `insert into captures (requested_url, normalized_url, reason, point_key, state, requested_at, finished_at)
     values ($1, $2, 'detection', $3, 'done', $4, $4) returning id`,
    [input.url, normalized, `seed@${Math.random().toString(36).slice(2)}`, observedAt],
  );
  const evidence = await pool.query<{ id: string }>(
    `insert into evidence
       (capture_id, requested_url, normalized_url, final_url, host, host_source, reason,
        outcome, http_status, attempt_number, observed_at, capture_profile)
     values ($1, $2, $3, $2, $4, 'landing_page', 'detection', $5, 200, 1, $6,
        '{"userAgent":"patrol","viewportWidth":1280,"viewportHeight":720,"locale":"en","timezone":"UTC",
          "javascriptEnabled":true,"blockedResourceKinds":[],"navigationPolicy":"load","extractorVersion":"1"}'::jsonb)
     returning id`,
    [capture.rows[0].id, input.url, normalized, host, input.outcome ?? "captured", observedAt],
  );
  const ids = await pool.query<{ decision_id: string; violation_id: string }>(
    "select uuidv7()::text as decision_id, uuidv7()::text as violation_id",
  );
  const decisionId = ids.rows[0].decision_id;
  const violationId = ids.rows[0].violation_id;
  await pool.query(
    `insert into review_decisions (id, candidate_id, operator_id, action, decided_at, evidence_ids, violation_id)
     values ($1, $2, $3, 'violation', $4, $5, $6)`,
    [decisionId, candidate.rows[0].id, world.operatorId, confirmedAt, [evidence.rows[0].id], violationId],
  );
  await pool.query(
    `insert into violations
       (id, tracked_title_id, candidate_id, review_decision_id, url, normalized_url, host,
        host_source, registrable_domain, detected_at, confirmed_at, confirmed_by, state, opened_at,
        created_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'landing_page', $8, $9, $9, $10, 'open', $9, $9)`,
    [
      violationId,
      input.titleId ?? world.titleA,
      candidate.rows[0].id,
      decisionId,
      input.url,
      normalized,
      host,
      host.split(".").slice(-2).join("."),
      confirmedAt,
      world.operatorId,
    ],
  );
  await pool.query(
    `update candidates set state = 'confirmed', review_decision_id = $2, violation_id = $3,
        confirmed_at = $4 where id = $1`,
    [candidate.rows[0].id, decisionId, violationId, confirmedAt],
  );
  await pool.query(
    `insert into violation_evidence (violation_id, evidence_id, role, cited_at, pinned_versions)
     values ($1, $2, 'detection', $3, '[]'::jsonb)`,
    [violationId, evidence.rows[0].id, confirmedAt],
  );
  return violationId;
}

/** Completes the bootstrap rights holder's contact and signatory profile. */
export async function seedRightsHolderContact(pool: Pool): Promise<void> {
  await pool.query(
    `insert into rights_holder (singleton, legal_name, country, address_line1, address_city,
        address_postal_code, role_mailbox, signatory_full_legal_name, signatory_authority_basis,
        signatory_contact_email)
     values (true, 'Example Rights GmbH', 'DE', '1 Example Street', 'Exampleville', '10001',
        'legal@example.test', 'Anna Beispiel', 'Copyright owner', 'signatory@example.test')
     on conflict (singleton) do update set
        address_line1 = excluded.address_line1,
        address_city = excluded.address_city,
        address_postal_code = excluded.address_postal_code,
        role_mailbox = excluded.role_mailbox,
        signatory_full_legal_name = excluded.signatory_full_legal_name,
        signatory_authority_basis = excluded.signatory_authority_basis,
        signatory_contact_email = excluded.signatory_contact_email`,
  );
}

/** The three seeded profiles, keyed by recipient. */
export async function profiles(
  pool: Pool,
): Promise<Map<"google" | "bing" | "yandex", { id: string }>> {
  const admin = await pool.query<{ id: string }>(
    `select id from operators where role = 'administrator' order by created_at asc limit 1`,
  );
  const updatedBy = admin.rows[0].id;
  const rows = (
    await pool.query<{ id: string; recipient: string }>(
      `insert into recipient_profiles (recipient, window_time, account, contact_email, eligible_territories, updated_by)
       values
         ('google', '07:00:00', 'noticeops@example.test', null, '{}', $1),
         ('bing', '07:00:00', '', 'legal@example.test', '{}', $1),
         ('yandex', '07:00:00', '', null, '{US,FR,CH}', $1)
       on conflict (recipient) do update set account = excluded.account, contact_email = excluded.contact_email,
         eligible_territories = excluded.eligible_territories
       returning id, recipient`,
      [updatedBy],
    )
  ).rows;
  return new Map(
    rows.map((row) => [row.recipient as "google" | "bing" | "yandex", { id: row.id }]),
  );
}

export async function seedNoticeWorld(pool: Pool, operatorId: string): Promise<NoticeWorld> {
  await seedRightsHolderContact(pool);
  const a = await seedTitle(pool, operatorId, "Sunrise", 2024);
  const b = await seedTitle(pool, operatorId, "Moonlight", 2023);
  return {
    operatorId,
    titleA: a.titleId,
    titleB: b.titleId,
    variantA: a.variantId,
    variantB: b.variantId,
  };
}

/**
 * The recording pack store: content-addressed puts under the packs prefix
 * with HEAD-style dedup, presigned URLs derived from the key. Tests read
 * the stored bytes back to assert the pack's frozen contents.
 */
export class FakePackStore implements Pick<EvidenceStore, "putArtifact" | "presignDownload"> {
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  /** Every key a put actually wrote (a deduplicated put never lands here). */
  readonly putKeys: string[] = [];

  async putArtifact(upload: ArtifactUpload): Promise<StoredObject> {
    const key = artifactKey(upload.kind, upload.sha256);
    if (this.objects.has(key)) {
      return { sha256: upload.sha256, objectVersion: null, existed: true };
    }
    this.objects.set(key, {
      bytes: upload.bytes.slice(),
      contentType: upload.contentType,
    });
    this.putKeys.push(key);
    return { sha256: upload.sha256, objectVersion: null, existed: false };
  }

  async presignDownload(request: PresignRequest): Promise<PresignedDownload> {
    return {
      url: `https://signed.test/${artifactKey(request.kind, request.sha256)}`,
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    };
  }

  /** The stored bytes of one pack artifact's key, decoded — the frozen content. */
  text(sha256: string): string | null {
    const object = this.objects.get(artifactKey("handoff_markdown", sha256));
    return object === undefined ? null : new TextDecoder().decode(object.bytes);
  }

  /** Whether anything was ever written for the digest. */
  has(sha256: string): boolean {
    return this.objects.has(artifactKey("handoff_markdown", sha256));
  }
}
