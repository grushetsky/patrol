import type { Pool, PoolClient } from "pg";
import type { Recipient } from "./statements.js";
import { fitsSingleNotice, groupViolations, type GroupingCaps } from "./grouping.js";
import { rejectionBlockedViolations } from "./submissions.js";

/**
 * The draft composer (docs/design/notice-composition.md "What a notice
 * carries", "Grouping per recipient", "Composition triggers and windows"):
 * one transaction turns a selection of OPEN violations into draft notices —
 * grouped per the recipient's cardinality, stamped with the active
 * statement template, carrying work identification per cited title and the
 * form-ordered resolved field map — and the citations RESERVE the
 * violations the moment the draft cites them.
 *
 * Two invariants the database holds and this module translates:
 *
 * - RESERVATION: a violation is cited by at most one notice that is not
 *   withdrawn, superseded, rejected, or failed. On demand this is a
 *   refusal (`violation_reserved`); the scheduled path DROPS a violation
 *   another draft reserved and composes the rest, because a window that
 *   lost a race to a manual draft must still cover everything else.
 * - DEDUPLICATION: (recipient profile, normalized URL, tracked title) is
 *   unique among the same active states, so a recipient never receives the
 *   same URL twice.
 *
 * The race is covered by the partial unique indexes; the pre-checks give
 * the refusal its evidence (which violations, which notice).
 */

/** The composer's database and clock. */
export interface ComposeDeps {
  pool: Pool;
  now: () => Date;
}

/** What a composer call composes from. */
export interface ComposeSelection {
  recipient: Recipient;
  recipientProfileId: string;
  violationIds: string[];
  trigger: "on_demand" | "scheduled";
  /** The operator the notice records as its creator. */
  composedBy: string;
}

/** Every refusal the composer can answer, in the API's error vocabulary. */
export type ComposeRefusal =
  | { status: "profile_absent" }
  | { status: "recipient_mismatch"; profileRecipient: Recipient }
  | { status: "rights_holder_absent" }
  | { status: "recipient_ineligible"; reason: "territory" | "account" | "contact" }
  | { status: "template_absent" }
  | { status: "empty_selection" }
  | { status: "violation_absent"; violationIds: string[] }
  | { status: "violation_not_open"; violationId: string; state: string }
  | { status: "grouping_limit_exceeded"; batches: number }
  | {
      status: "violation_reserved";
      conflictingViolationIds: string[];
      existingNoticeId: string;
    }
  | {
      status: "violation_needs_review";
      conflictingViolationIds: string[];
      existingNoticeId: string;
    }
  | { status: "duplicate_entity"; violationId: string; existingNoticeId: string };

export type ComposeOutcome =
  | { status: "composed"; notices: ComposedNotice[] }
  | { status: "refused"; refusal: ComposeRefusal };

/** One composed draft. */
export interface ComposedNotice {
  noticeId: string;
  citationCount: number;
}

/** The rights-holder facts the resolved field map renders from. */
export interface RightsHolderFacts {
  legalName: string;
  country: string;
  address: string | null;
  roleMailbox: string | null;
  phone: string | null;
  signatoryFullLegalName: string | null;
}

/** The profile slice the composer reads. */
export interface ProfileFacts {
  id: string;
  recipient: Recipient;
  channel: "web_form" | "trusted_program";
  account: string;
  contactEmail: string | null;
  eligibleTerritories: string[];
  maxUrlsPerNotice: number | null;
  maxUrlsPerFile: number | null;
  lastObservedMaxUrlsPerFile: number | null;
}

/** One resolved field of the recipient's form, form-ordered. */
export interface ResolvedFieldSeed {
  name: string;
  value: string;
  required: boolean;
  maxLength?: number;
}

/** The recipient's form language Patrol composes in. */
export const NOTICE_LANGUAGE = "en";

/**
 * The citation states that keep a reservation and the recipient-level
 * dedup alive — a notice that is neither withdrawn, superseded, rejected,
 * nor failed. The same set is spelled as SQL literals in
 * packages/db/drizzle/0008_notices.sql (the notice_citations state CHECK's
 * active prefix and the two partial unique indexes); SQL cannot import
 * this constant, so the homes move together by hand.
 */
export const ACTIVE_CITATION_STATES = ["draft", "approved"] as const;

/**
 * The active-citation states as a SQL `in (...)` literal — the one place
 * the constant is spelled for queries (compose.ts and schedule.ts share
 * it; the migration's literals are cross-referenced above).
 */
export const ACTIVE_CITATION_STATES_SQL = `(${ACTIVE_CITATION_STATES.map(
  (state) => `'${state}'`,
).join(", ")})`;

/**
 * The territories Yandex's copyright process accepts rights holders from:
 * the United States, Switzerland, and the EU member states (the research's
 * territory note — docs/research/recipient-statements.md §3). This is the
 * CHANNEL floor; the profile's `eligibleTerritories` can only narrow it,
 * never widen it. The EU-27 membership list is fixed here, single-homed —
 * do not duplicate it elsewhere.
 */
export const YANDEX_ELIGIBLE_TERRITORIES: readonly string[] = [
  "US",
  "CH",
  // The EU member states, ISO 3166-1 alpha-2, alphabetical.
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
];

/**
 * The eligibility gate (design "Grouping per recipient / Eligibility"):
 * Google needs the profile's account, Bing the contact mailbox, Yandex a
 * rights holder inside the profile's eligible territories — where "inside"
 * means the Yandex CHANNEL FLOOR (US, Switzerland, EU member states) first
 * and the profile's list second: an empty territory list means the floor,
 * not every territory in the world.
 */
export function checkEligibility(
  recipient: Recipient,
  profile: ProfileFacts,
  rightsHolder: RightsHolderFacts,
): { ok: true } | { ok: false; reason: "territory" | "account" | "contact" } {
  switch (recipient) {
    case "google":
      return profile.account.trim() !== ""
        ? { ok: true }
        : { ok: false, reason: "account" };
    case "bing":
      return profile.contactEmail !== null && profile.contactEmail.trim() !== ""
        ? { ok: true }
        : { ok: false, reason: "contact" };
    case "yandex": {
      const territories =
        profile.eligibleTerritories.length === 0
          ? YANDEX_ELIGIBLE_TERRITORIES
          : profile.eligibleTerritories.filter((territory) =>
              YANDEX_ELIGIBLE_TERRITORIES.includes(territory),
            );
      return territories.includes(rightsHolder.country)
        ? { ok: true }
        : { ok: false, reason: "territory" };
    }
  }
}

/** Joins the rights holder's postal address into one form value. */
export function addressValue(rightsHolder: {
  address_line1: string | null;
  address_line2: string | null;
  address_city: string | null;
  address_region: string | null;
  address_postal_code: string | null;
}): string | null {
  const parts = [
    rightsHolder.address_line1,
    rightsHolder.address_line2,
    rightsHolder.address_city,
    rightsHolder.address_region,
    rightsHolder.address_postal_code,
  ].filter((part): part is string => part !== null && part.trim() !== "");
  return parts.length === 0 ? null : parts.join(", ");
}

/**
 * The form-ordered resolved field map per recipient, from the research's
 * field map (docs/research/notice-submission.md §1). The signature renders
 * the signatory's full legal name in every recipient's form; the DATE is
 * rendered into the pack at handoff, never into a notice, so it is not a
 * resolved field. The authorized example URL is the operator's to complete
 * where the form requires one Patrol cannot resolve.
 */
export function resolvedFieldsFor(
  recipient: Recipient,
  rightsHolder: RightsHolderFacts,
): ResolvedFieldSeed[] {
  const signature = rightsHolder.signatoryFullLegalName ?? "";
  const mailbox = rightsHolder.roleMailbox ?? "";
  switch (recipient) {
    case "google":
      return [
        { name: "product", value: "Web Search", required: true },
        { name: "copyright_owner", value: rightsHolder.legalName, required: true },
        { name: "owner_country", value: rightsHolder.country, required: true },
        { name: "contact_email", value: mailbox, required: true },
        { name: "signature", value: signature, required: true },
      ];
    case "bing":
      return [
        { name: "search_type", value: "Web", required: true },
        { name: "reporting_organization", value: rightsHolder.legalName, required: false },
        { name: "copyright_owner_name", value: rightsHolder.legalName, required: true },
        { name: "copyright_owner_country", value: rightsHolder.country, required: true },
        { name: "email", value: mailbox, required: true },
        { name: "signature", value: signature, required: true },
      ];
    case "yandex":
      return [
        { name: "product_type", value: "Web search", required: true },
        { name: "copyright_holder_name", value: rightsHolder.legalName, required: true },
        { name: "copyright_holder_country", value: rightsHolder.country, required: true },
        { name: "copyright_holder_address", value: rightsHolder.address ?? "", required: true },
        { name: "contact_email", value: mailbox, required: true },
        ...(rightsHolder.phone === null
          ? []
          : [{ name: "contact_phone", value: rightsHolder.phone, required: false }]),
        { name: "authorized_example_url", value: "", required: true },
        { name: "signature", value: signature, required: true },
      ];
  }
}

/** One violation the composer loaded, with the work identification facts. */
interface LoadedViolation extends CitationFacts {
  normalizedUrl: string;
  url: string;
  evidence: Array<{ evidenceId: string; capturedAt: string; reason: string }>;
}

/** The active template row the composer stamps from. */
interface LoadedTemplate {
  identifier: string;
  statements: Array<{ key: string; text: string }>;
}

/** The template facts content resolution reads: the set a notice stamps. */
export interface TemplateFacts {
  identifier: string;
  statements: ReadonlyArray<{ key: string; text: string }>;
}

/** The citation facts a work identification renders from. */
export interface CitationFacts {
  violationId: string;
  trackedTitleId: string;
  displayTitle: string;
  releaseYear: number;
  titleType: "film" | "series" | "miniseries" | "other";
}

/** Everything the notice's content resolves from — all live reads. */
export interface NoticeContentInputs {
  recipient: Recipient;
  template: TemplateFacts;
  rightsHolder: RightsHolderFacts;
  citations: readonly CitationFacts[];
}

/** One work identification seed, in first-appearance order. */
export interface WorkIdentificationSeed {
  trackedTitleId: string;
  displayTitle: string;
  releaseYear: number;
  titleType: CitationFacts["titleType"];
}

/** The notice's resolved content: what the child tables store. */
export interface ResolvedNoticeContent {
  templateVersion: string;
  statements: ReadonlyArray<{ key: string; text: string }>;
  workIdentifications: ReadonlyArray<WorkIdentificationSeed>;
  resolvedFields: ResolvedFieldSeed[];
}

/**
 * Resolves the notice's content from the inputs it is handed — a PURE
 * function, no database. The composer calls it with the reads it just took,
 * so a draft carries a preview of the resolved field map (the signature
 * included) and the work identifications; the design freezes them at
 * APPROVAL, not composition, so the approval (approval.ts) recomputes
 * through this same function from FRESH rights-holder/signatory/profile
 * reads before it freezes — a draft's stored values are never trusted as
 * the frozen content.
 */
export function resolveNoticeContent(inputs: NoticeContentInputs): ResolvedNoticeContent {
  // One work identification per cited tracked title, in first-appearance
  // order.
  const seenTitles = new Set<string>();
  const workIdentifications: WorkIdentificationSeed[] = [];
  for (const citation of inputs.citations) {
    if (seenTitles.has(citation.trackedTitleId)) {
      continue;
    }
    seenTitles.add(citation.trackedTitleId);
    workIdentifications.push({
      trackedTitleId: citation.trackedTitleId,
      displayTitle: citation.displayTitle,
      releaseYear: citation.releaseYear,
      titleType: citation.titleType,
    });
  }
  return {
    templateVersion: inputs.template.identifier,
    statements: [...inputs.template.statements],
    workIdentifications,
    resolvedFields: resolvedFieldsFor(inputs.recipient, inputs.rightsHolder),
  };
}

async function loadProfile(client: PoolClient, id: string): Promise<ProfileFacts | null> {
  const result = await client.query<{
    id: string;
    recipient: Recipient;
    channel: "web_form" | "trusted_program";
    account: string;
    contact_email: string | null;
    eligible_territories: string[] | null;
    max_urls_per_notice: number | null;
    max_urls_per_file: number | null;
    last_observed_max_urls_per_file: number | null;
  }>(
    `select id, recipient, channel, account, contact_email, eligible_territories,
            max_urls_per_notice, max_urls_per_file, last_observed_max_urls_per_file
     from recipient_profiles where id = $1 for update`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    recipient: row.recipient,
    channel: row.channel,
    account: row.account,
    contactEmail: row.contact_email,
    eligibleTerritories: row.eligible_territories ?? [],
    maxUrlsPerNotice: row.max_urls_per_notice,
    maxUrlsPerFile: row.max_urls_per_file,
    lastObservedMaxUrlsPerFile: row.last_observed_max_urls_per_file,
  };
}

async function loadRightsHolder(client: PoolClient): Promise<RightsHolderFacts | null> {
  const result = await client.query<{
    legal_name: string;
    country: string;
    address_line1: string | null;
    address_line2: string | null;
    address_city: string | null;
    address_region: string | null;
    address_postal_code: string | null;
    role_mailbox: string | null;
    phone: string | null;
    signatory_full_legal_name: string | null;
  }>(
    `select legal_name, country, address_line1, address_line2, address_city,
            address_region, address_postal_code, role_mailbox, phone,
            signatory_full_legal_name
     from rights_holder limit 1`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    legalName: row.legal_name,
    country: row.country,
    address: addressValue(row),
    roleMailbox: row.role_mailbox,
    phone: row.phone,
    signatoryFullLegalName: row.signatory_full_legal_name,
  };
}

async function loadTemplate(
  client: PoolClient,
  recipient: Recipient,
): Promise<LoadedTemplate | null> {
  const result = await client.query<{ identifier: string; statements: unknown }>(
    `select identifier, statements from notice_templates
      where recipient = $1 and language = $2 and active
      order by major desc limit 1`,
    [recipient, NOTICE_LANGUAGE],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  const statements = row.statements as LoadedTemplate["statements"];
  if (!Array.isArray(statements)) {
    return null;
  }
  return { identifier: row.identifier, statements };
}

async function loadViolations(
  client: PoolClient,
  violationIds: string[],
): Promise<LoadedViolation[]> {
  if (violationIds.length === 0) {
    return [];
  }
  const result = await client.query<{
    id: string;
    tracked_title_id: string;
    url: string;
    normalized_url: string;
    state: string;
    release_year: number;
    title_type: LoadedViolation["titleType"];
    display_title: string;
    evidence: Array<{ evidenceId: string; capturedAt: string; reason: string }> | null;
  }>(
    `select v.id, v.tracked_title_id, v.url, v.normalized_url, v.state,
            t.release_year, t.title_type, ov.text as display_title,
            (
              select coalesce(jsonb_agg(jsonb_build_object(
                        'evidenceId', ve.evidence_id::text,
                        'capturedAt', to_char(ve.cited_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                        'reason', ve.role
                      ) order by ve.cited_at desc), '[]'::jsonb)
              from violation_evidence ve where ve.violation_id = v.id
            ) as evidence
     from violations v
     join tracked_titles t on t.id = v.tracked_title_id
     join title_variants ov on ov.id = t.original_variant_id
     where v.id = any($1::uuid[])`,
    [violationIds],
  );
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  // Preserve the selection's order (the cart order, or the confirmed-time
  // order the scheduled path selected).
  return violationIds.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined
      ? []
      : [
          {
            violationId: row.id,
            trackedTitleId: row.tracked_title_id,
            normalizedUrl: row.normalized_url,
            url: row.url,
            displayTitle: row.display_title,
            releaseYear: Number(row.release_year),
            titleType: row.title_type,
            evidence: row.evidence ?? [],
          },
        ];
  });
}

/** Violations another ACTIVE notice cites — the reservation pre-check. */
async function reservedViolations(
  client: PoolClient,
  violationIds: string[],
): Promise<Map<string, string>> {
  if (violationIds.length === 0) {
    return new Map();
  }
  const result = await client.query<{ violation_id: string; notice_id: string }>(
    `select violation_id, notice_id from notice_citations
      where violation_id = any($1::uuid[]) and state in ${ACTIVE_CITATION_STATES_SQL}`,
    [violationIds],
  );
  return new Map(result.rows.map((row) => [row.violation_id, row.notice_id]));
}

/** Dedup conflicts: an active notice of THIS profile already carries the pair. */
async function duplicatedPairs(
  client: PoolClient,
  profileId: string,
  violations: LoadedViolation[],
): Promise<Map<string, string>> {
  if (violations.length === 0) {
    return new Map();
  }
  const result = await client.query<{ violation_id: string; notice_id: string }>(
    `select c.violation_id, c.notice_id from notice_citations c
      join notices n on n.id = c.notice_id
      where c.recipient_profile_id = $1
        and c.state in ${ACTIVE_CITATION_STATES_SQL}
        and (c.normalized_url, c.tracked_title_id) in (
          select unnest($2::text[]), unnest($3::uuid[])
        )`,
    [
      profileId,
      violations.map((violation) => violation.normalizedUrl),
      violations.map((violation) => violation.trackedTitleId),
    ],
  );
  return new Map(result.rows.map((row) => [row.violation_id, row.notice_id]));
}

function groupingCaps(profile: ProfileFacts): GroupingCaps {
  return {
    maxUrlsPerNotice: profile.maxUrlsPerNotice,
    maxUrlsPerFile: profile.maxUrlsPerFile,
    lastObservedMaxUrlsPerFile: profile.lastObservedMaxUrlsPerFile,
  };
}

/** A unique-index violation on the citations (Postgres 23505), classified. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

/** Inserts one draft notice with all of its content rows. */
async function insertNotice(
  client: PoolClient,
  input: {
    now: Date;
    selection: ComposeSelection;
    profile: ProfileFacts;
    template: LoadedTemplate;
    rightsHolder: RightsHolderFacts;
    citations: LoadedViolation[];
  },
): Promise<string> {
  const { now, selection, profile, template, rightsHolder, citations } = input;
  // The content is a DRAFT PREVIEW of live reads; the approval recomputes
  // it through resolveNoticeContent from fresh reads before freezing.
  const content = resolveNoticeContent({
    recipient: selection.recipient,
    template,
    rightsHolder,
    citations,
  });
  const notice = await client.query<{ id: string }>(
    `insert into notices
       (recipient, recipient_profile_id, channel, state, template_version, language,
        composed_at, composed_by, trigger_kind, updated_at)
     values ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $6)
     returning id`,
    [
      selection.recipient,
      profile.id,
      profile.channel,
      content.templateVersion,
      NOTICE_LANGUAGE,
      now.toISOString(),
      selection.composedBy,
      selection.trigger,
    ],
  );
  const noticeId = notice.rows[0].id;

  await client.query(
    `insert into notice_citations
       (notice_id, violation_id, recipient_profile_id, tracked_title_id, url,
        normalized_url, state, position, evidence)
     select $1, v.violation_id, $2, v.tracked_title_id, v.url, v.normalized_url,
            'draft', v.position, v.evidence
     from (
       select unnest($3::uuid[]) as violation_id, unnest($4::uuid[]) as tracked_title_id,
              unnest($5::text[]) as url, unnest($6::text[]) as normalized_url,
              unnest($7::int[]) as position, unnest($8::jsonb[]) as evidence
     ) v`,
    [
      noticeId,
      profile.id,
      citations.map((c) => c.violationId),
      citations.map((c) => c.trackedTitleId),
      citations.map((c) => c.url),
      citations.map((c) => c.normalizedUrl),
      citations.map((_, index) => index),
      citations.map((c) => JSON.stringify(c.evidence)),
    ],
  );

  const works = content.workIdentifications;
  if (works.length > 0) {
    await client.query(
      `insert into notice_work_identifications
         (notice_id, tracked_title_id, display_title, release_year, title_type, position)
       select $1, t.tracked_title_id, t.display_title, t.release_year, t.title_type, t.position
       from (
         select unnest($2::uuid[]) as tracked_title_id, unnest($3::text[]) as display_title,
                unnest($4::int[]) as release_year, unnest($5::text[]) as title_type,
                unnest($6::int[]) as position
       ) t`,
      [
        noticeId,
        works.map((work) => work.trackedTitleId),
        works.map((work) => work.displayTitle),
        works.map((work) => work.releaseYear),
        works.map((work) => work.titleType),
        works.map((_, index) => index),
      ],
    );
  }

  // The statements, stamped with the SAME set identifier as the notice —
  // the trigger refuses any other value.
  await client.query(
    `insert into notice_statements (notice_id, position, key, text, template_version)
     select $1, s.position, s.key, s.text, $2
     from (
       select unnest($3::text[]) as key, unnest($4::text[]) as text,
              unnest($5::int[]) as position
     ) s`,
    [
      noticeId,
      content.templateVersion,
      content.statements.map((statement) => statement.key),
      content.statements.map((statement) => statement.text),
      content.statements.map((_, index) => index),
    ],
  );

  // The resolved field map is computed at composition from live reads but
  // frozen at APPROVAL — the approval recomputes it from fresh reads next
  // to the freeze columns before the notice becomes immutable.
  const fields = content.resolvedFields;
  await client.query(
    `insert into notice_resolved_fields (notice_id, position, name, value, required, max_length)
     select $1, f.position, f.name, f.value, f.required, f.max_length
     from (
       select unnest($2::text[]) as name, unnest($3::text[]) as value,
              unnest($4::boolean[]) as required,
              unnest($5::int[]) + 1 as position,
              unnest($6::int[]) as max_length
     ) f`,
    [
      noticeId,
      fields.map((field) => field.name),
      fields.map((field) => field.value),
      fields.map((field) => field.required),
      fields.map((_, index) => index),
      fields.map((field) => field.maxLength ?? null),
    ],
  );
  return noticeId;
}

/**
 * Composes draft notices from a selection of open violations, grouped per
 * the recipient. On demand the selection must fit ONE notice (POST /notices
 * composes one draft and answers once — an over-cap batch is the operator's
 * to split); the scheduled path splits into one notice per batch and drops
 * violations a concurrent draft reserved.
 */
export async function composeNotices(
  deps: ComposeDeps,
  selection: ComposeSelection,
): Promise<ComposeOutcome> {
  const client = await deps.pool.connect();
  try {
    await client.query("begin");
    const outcome = await composeInTransaction(client, deps.now, selection);
    if (outcome.status === "refused") {
      await client.query("rollback");
      return outcome;
    }
    await client.query("commit");
    return outcome;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The composer's core, inside a caller's transaction. The scheduled runner
 * shares ITS transaction (claiming the window row takes a KEY SHARE lock
 * on the profile through the foreign key, which a second connection's
 * `for update` would wait on forever — a classic self-deadlock), so this
 * export exists for it; every other caller goes through `composeNotices`.
 */
export async function composeInTransaction(
  client: PoolClient,
  now: () => Date,
  selection: ComposeSelection,
): Promise<ComposeOutcome> {
  const profile = await loadProfile(client, selection.recipientProfileId);
  if (profile === null) {
    return refused({ status: "profile_absent" });
  }
  if (profile.recipient !== selection.recipient) {
    return refused({ status: "recipient_mismatch", profileRecipient: profile.recipient });
  }
  if (selection.violationIds.length === 0) {
    return refused({ status: "empty_selection" });
  }

  const rightsHolder = await loadRightsHolder(client);
  if (rightsHolder === null) {
    return refused({ status: "rights_holder_absent" });
  }
  const eligibility = checkEligibility(selection.recipient, profile, rightsHolder);
  if (!eligibility.ok) {
    return refused({ status: "recipient_ineligible", reason: eligibility.reason });
  }

  const template = await loadTemplate(client, selection.recipient);
  if (template === null) {
    return refused({ status: "template_absent" });
  }

  const loaded = await loadViolations(client, selection.violationIds);
  const absent = selection.violationIds.filter(
    (id) => !loaded.some((violation) => violation.violationId === id),
  );
  if (absent.length > 0) {
    return refused({ status: "violation_absent", violationIds: absent });
  }
  // Every selected violation must stand open — a closed or removed one is
  // never citable by a new draft.
  const stateRows = await client.query<{ id: string; state: string }>(
    "select id, state from violations where id = any($1::uuid[])",
    [selection.violationIds],
  );
  const states = new Map(stateRows.rows.map((row) => [row.id, row.state]));
  const closed = loaded.find((violation) => states.get(violation.violationId) !== "open");
  if (closed !== undefined) {
    return refused({
      status: "violation_not_open",
      violationId: closed.violationId,
      state: states.get(closed.violationId) ?? "unknown",
    });
  }

  const caps = groupingCaps(profile);
  if (selection.trigger === "on_demand") {
    if (!fitsSingleNotice(selection.recipient, loaded, caps)) {
      const batches = groupViolations(selection.recipient, loaded, caps).length;
      return refused({ status: "grouping_limit_exceeded", batches });
    }
  }

  // The rejection gate (notice-composition.md "Volume and accuracy
  // safeguards"): a violation a REJECTED submission cited needs a review
  // decision before it is cited again — the reservation ENDED with the
  // rejection, but a new draft may not repeat an unexamined refusal. On
  // demand this is a refusal; the scheduled path drops the blocked
  // violations the same way it drops reserved ones.
  const blockedByRejection = await rejectionBlockedViolations(
    client,
    loaded.map((violation) => violation.violationId),
  );
  if (selection.trigger === "on_demand" && blockedByRejection.size > 0) {
    const [violationId, noticeId] = [...blockedByRejection.entries()][0];
    return refused({
      status: "violation_needs_review",
      conflictingViolationIds: [...blockedByRejection.keys()],
      existingNoticeId: noticeId,
    });
  }

  // The reservation and dedup pre-checks. Scheduled drops the conflicts
  // (a window that lost a race to a manual draft still covers the rest);
  // on demand they are refusals carrying the conflicting evidence.
  let candidates = loaded.filter(
    (violation) => !blockedByRejection.has(violation.violationId),
  );
  for (let attempt = 0; ; attempt += 1) {
    const reserved = await reservedViolations(
      client,
      candidates.map((violation) => violation.violationId),
    );
    const duplicated = await duplicatedPairs(client, profile.id, candidates);
    if (selection.trigger === "on_demand") {
      if (reserved.size > 0) {
        const [violationId, noticeId] = [...reserved.entries()][0];
        return refused({
          status: "violation_reserved",
          conflictingViolationIds: [...reserved.keys()],
          existingNoticeId: noticeId,
        });
      }
      if (duplicated.size > 0) {
        const [violationId, noticeId] = [...duplicated.entries()][0];
        return refused({
          status: "duplicate_entity",
          violationId,
          existingNoticeId: noticeId,
        });
      }
    }
    const remaining = candidates.filter(
      (violation) =>
        !reserved.has(violation.violationId) && !duplicated.has(violation.violationId),
    );
    if (remaining.length === 0) {
      return { status: "composed", notices: [] };
    }
    const batches = groupViolations(selection.recipient, remaining, caps);
    const composed: ComposedNotice[] = [];
    try {
      for (const batch of batches) {
        const noticeId = await insertNotice(client, {
          now: now(),
          selection,
          profile,
          template,
          rightsHolder,
          citations: batch,
        });
        composed.push({ noticeId, citationCount: batch.length });
      }
      return { status: "composed", notices: composed };
    } catch (error) {
      if (isUniqueViolation(error) && attempt < candidates.length) {
        // A concurrent draft won the race between the pre-check and the
        // insert. Drop whatever now conflicts and try the rest again.
        candidates = remaining;
        continue;
      }
      throw error;
    }
  }
}

function refused(refusal: ComposeRefusal): ComposeOutcome {
  return { status: "refused", refusal };
}
