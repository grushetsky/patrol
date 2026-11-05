import type { Pool } from "pg";
import type { EvidenceStore } from "@patrol/evidence";
import { sha256Hex } from "@patrol/evidence";
import { recomputeProfilePause } from "./pause.js";
import {
  recipientFormUrl,
  buildPackFiles,
  packContentKey,
  packManifestHash,
  type BuiltPackFile,
  type HandoffPackInput,
  type PackCaptureFlag,
} from "./pack.js";
import type { Recipient } from "./statements.js";

/**
 * The submission that approval settles into (docs/design/
 * notice-composition.md "Approval" step 4; ADR 0020): ONE pending row per
 * notice — the unique key makes a duplicate wake-up a no-op — created once
 * every pre-handoff capture the approval queued has reached a terminal
 * state.
 *
 * The work is split by deployment topology, and the split is a fact of the
 * design, not an implementation detail: the WORKER settles captures, so its
 * settle hook writes DATABASE rows only (the submission row, nothing else);
 * the API owns the object store, so the pack's BYTES are built and stored
 * from the API — idempotently, on the first pack read, an interrupted build
 * leaves orphaned content-addressed bytes rather than a dangling pack
 * reference. The pack renders in the language FROZEN at approval (the
 * notice's approval_language column), never in a preference read at settle
 * or build time.
 */

/** The half of the evidence store the pack write path needs. */
export type PackStore = Pick<EvidenceStore, "putArtifact" | "presignDownload">;

/** The settle path's dependencies: the database and the clock, nothing else. */
export interface SettleDeps {
  pool: Pool;
  now: () => Date;
}

/** The pack build path's dependencies (an API-side caller brings the store). */
export interface PackBuildDeps {
  pool: Pool;
  now: () => Date;
  store: PackStore;
}

/** The capture states nothing more will happen in. */
export const TERMINAL_CAPTURE_STATES: readonly string[] = ["done", "failed", "skipped"];

/** One frozen notice, read back for the pack. */
interface FrozenNotice {
  id: string;
  recipient: Recipient;
  recipient_profile_id: string;
  channel: "web_form" | "trusted_program";
  state: "draft" | "approved" | "withdrawn" | "superseded";
  approved_at: Date | null;
  approved_by: string;
  template_version: string;
  approval_language: "en" | "ru" | null;
  rights_holder_snapshot: Record<string, unknown>;
  signatory_snapshot: Record<string, unknown>;
}

/** Reads everything the pack renders from. */
async function loadFrozenNotice(pool: Pool, noticeId: string): Promise<FrozenNotice | null> {
  const result = await pool.query<FrozenNotice>(
    `select id, recipient, recipient_profile_id, channel, state, approved_at, approved_by,
            template_version, approval_language, rights_holder_snapshot, signatory_snapshot
     from notices where id = $1`,
    [noticeId],
  );
  return result.rows[0] ?? null;
}

/**
 * The pack-level capture flags for every cited URL, in one batched query —
 * the newest capture per URL and, when that newest is not itself a live
 * capture, the newest capture that is. This is the ONE loader the pack
 * builder and the pack read share, so the two can never drift.
 *
 * Null-handling, fixed and documented: a cited URL with no capture at all
 * produces NO flag — the contract's CaptureFlag requires the newest
 * capture's id and outcome, and a URL nothing ever observed cannot fill
 * them. (In practice every cited URL carries at least the composition-time
 * capture; the guard is for the vacuum case.)
 */
export async function loadCaptureFlagsForCitations(
  pool: Pool,
  noticeId: string,
): Promise<PackCaptureFlag[]> {
  const result = await pool.query<{
    violation_id: string;
    url: string;
    newest_evidence_id: string | null;
    newest_outcome: PackCaptureFlag["newestOutcome"];
    earlier_live_evidence_id: string | null;
  }>(
    `select c.violation_id, c.url, newest.id as newest_evidence_id, newest.outcome as newest_outcome,
            earlier.id as earlier_live_evidence_id
     from notice_citations c
     left join lateral (
       select e.id, e.outcome from evidence e
        where e.normalized_url = c.normalized_url
        order by e.observed_at desc, e.id
        limit 1
     ) newest on true
     left join lateral (
       select e.id from evidence e
        where e.normalized_url = c.normalized_url and e.outcome = 'captured'
          and (newest.id is null or e.id <> newest.id)
        order by e.observed_at desc, e.id
        limit 1
     ) earlier on true
     where c.notice_id = $1
     order by c.position`,
    [noticeId],
  );
  const flags: PackCaptureFlag[] = [];
  for (const row of result.rows) {
    if (row.newest_evidence_id === null) {
      continue;
    }
    flags.push({
      violationId: row.violation_id,
      url: row.url,
      newestEvidenceId: row.newest_evidence_id,
      newestOutcome: row.newest_outcome,
      earlierLiveEvidenceId: row.earlier_live_evidence_id,
    });
  }
  return flags;
}

/**
 * Assembles the pack input from the frozen notice's stored content. State
 * guard: only an APPROVED notice has a pack — a withdrawn or superseded
 * notice never gets bytes built (the read answers not found), and a draft
 * has nothing frozen to render.
 */
export async function loadPackInput(pool: Pool, noticeId: string): Promise<HandoffPackInput | null> {
  const notice = await loadFrozenNotice(pool, noticeId);
  if (notice === null || notice.state !== "approved") {
    return null;
  }
  const citations = await pool.query<{
    violation_id: string;
    url: string;
    normalized_url: string;
    display_title: string;
    evidence: Array<{ evidenceId: string; capturedAt: string }>;
  }>(
    `select c.violation_id, c.url, c.normalized_url, ov.text as display_title, c.evidence
     from notice_citations c
     join tracked_titles t on t.id = c.tracked_title_id
     join title_variants ov on ov.id = t.original_variant_id
     where c.notice_id = $1
     order by c.position`,
    [noticeId],
  );
  const works = await pool.query<{
    display_title: string;
    release_year: number;
    title_type: string;
    authorized_example_url: string | null;
  }>(
    "select display_title, release_year, title_type, authorized_example_url from notice_work_identifications where notice_id = $1 order by position",
    [noticeId],
  );
  const statements = await pool.query<{ key: string; text: string }>(
    "select key, text from notice_statements where notice_id = $1 order by position",
    [noticeId],
  );
  const fields = await pool.query<{
    name: string;
    value: string;
    required: boolean;
    max_length: number | null;
  }>(
    "select name, value, required, max_length from notice_resolved_fields where notice_id = $1 order by position",
    [noticeId],
  );
  const template = await pool.query<{ fields: unknown }>(
    "select fields from notice_templates where identifier = $1",
    [notice.template_version],
  );
  const templateFields = template.rows[0]?.fields;
  // The language frozen at approval; a preference read NOW never enters.
  const packLanguage = notice.approval_language ?? "en";

  const rightsHolder = notice.rights_holder_snapshot as {
    legalName: string;
    country: string;
    address?: {
      line1: string;
      line2?: string;
      city: string;
      region?: string;
      postalCode: string;
      country: string;
    };
    roleMailbox: string;
    phone?: string;
  };
  const signatory = notice.signatory_snapshot as HandoffPackInput["signatory"];

  const citationRows = citations.rows.map((row) => ({
    violationId: row.violation_id,
    url: row.url,
    normalizedUrl: row.normalized_url,
    displayTitle: row.display_title,
    evidence: row.evidence ?? [],
  }));

  return {
    recipient: notice.recipient,
    packLanguage,
    approvedAt: (notice.approved_at ?? new Date(0)).toISOString(),
    formUrl: recipientFormUrl(notice.recipient),
    templateVersion: notice.template_version,
    statements: statements.rows,
    fieldLabels: Array.isArray(templateFields)
      ? (templateFields as HandoffPackInput["fieldLabels"])
      : [],
    resolvedFields: fields.rows.map((field) => ({
      name: field.name,
      value: field.value,
      required: field.required,
      ...(field.max_length === null ? {} : { maxLength: field.max_length }),
    })),
    works: works.rows.map((work) => ({
      displayTitle: work.display_title,
      releaseYear: Number(work.release_year),
      titleType: work.title_type,
      ...(work.authorized_example_url === null
        ? {}
        : { authorizedExampleUrl: work.authorized_example_url }),
    })),
    citations: citationRows,
    rightsHolder: {
      legalName: rightsHolder.legalName,
      country: rightsHolder.country,
      address: rightsHolder.address?.line1 === undefined ? null : addressText(rightsHolder.address),
      roleMailbox: rightsHolder.roleMailbox,
      ...(rightsHolder.phone === undefined ? {} : { phone: rightsHolder.phone }),
    },
    signatory: {
      fullLegalName: signatory.fullLegalName,
      authorityBasis: signatory.authorityBasis,
      contactEmail: signatory.contactEmail,
    },
    captureFlags: await loadCaptureFlagsForCitations(pool, noticeId),
  };
}

/** Joins a snapshot's postal address into the pack's one-line form value. */
function addressText(address: {
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
}): string {
  return [address.line1, address.line2, address.city, address.region, address.postalCode]
    .filter((part) => part !== undefined && part !== null && part !== "")
    .join(", ");
}

/** Whether every pre-handoff capture the approval queued has settled. */
async function capturesSettled(pool: Pool, noticeId: string): Promise<boolean> {
  const unsettled = await pool.query<{ count: string }>(
    `select count(*) as count from notice_pre_handoff_captures l
      join captures c on c.id = l.capture_id
      where l.notice_id = $1 and c.state not in ('done', 'failed', 'skipped')`,
    [noticeId],
  );
  return Number(unsettled.rows[0].count) === 0;
}

/**
 * Builds the pack's files and stores them content-addressed. Deterministic
 * by construction: identical frozen content produces identical bytes, and
 * the store's HEAD dedup makes the second write of the same bytes a no-op.
 */
export async function storePackFiles(
  store: PackStore,
  input: HandoffPackInput,
): Promise<{ files: BuiltPackFile[]; hash: string; manifest: Array<{ name: string; sha256: string; size: number }> }> {
  const files = buildPackFiles(input);
  const manifest: Array<{ name: string; sha256: string; size: number }> = [];
  for (const file of files) {
    const sha256 = sha256Hex(file.bytes);
    await store.putArtifact({
      kind: file.kind,
      sha256,
      bytes: file.bytes,
      contentType: file.contentType,
    });
    manifest.push({ name: file.fileName, sha256, size: file.bytes.byteLength });
  }
  return { files, hash: packManifestHash(files), manifest };
}

export interface SubmissionCreation {
  created: boolean;
  submissionId: string | null;
}

/**
 * Creates the notice's pending submission once the captures have settled —
 * DATABASE rows only: the pack's bytes are the API's to build (see the
 * module comment). Idempotent: a second call finds the submission row
 * standing and writes nothing.
 */
export async function createPendingSubmissionIfSettled(
  deps: SettleDeps,
  noticeId: string,
): Promise<SubmissionCreation> {
  const notice = await loadFrozenNotice(deps.pool, noticeId);
  if (notice === null || notice.state !== "approved" || notice.approved_at === null) {
    return { created: false, submissionId: null };
  }
  const existing = await deps.pool.query<{ id: string }>(
    "select id from submissions where notice_id = $1",
    [noticeId],
  );
  if (existing.rows.length > 0) {
    return { created: false, submissionId: existing.rows[0].id };
  }
  if (!(await capturesSettled(deps.pool, noticeId))) {
    return { created: false, submissionId: null };
  }

  const inserted = await deps.pool.query<{ id: string }>(
    `insert into submissions (notice_id, recipient_profile_id, channel, state, attempt_count, pack_language, created_at)
     values ($1, $2, $3, 'pending', 0, $4, $5)
     on conflict (notice_id) do nothing
     returning id`,
    [
      noticeId,
      notice.recipient_profile_id,
      notice.channel,
      // The language frozen at approval, never a preference read now.
      notice.approval_language ?? "en",
      deps.now().toISOString(),
    ],
  );
  if (inserted.rows.length === 0) {
    // A concurrent settle won the race; nothing to write.
    const winner = await deps.pool.query<{ id: string }>(
      "select id from submissions where notice_id = $1",
      [noticeId],
    );
    return { created: false, submissionId: winner.rows[0]?.id ?? null };
  }

  // The pause threshold reads the profile's submission window; the row's
  // arrival is the moment the window can change.
  await recomputeProfilePause(deps.pool, deps.now, notice.recipient_profile_id);
  return { created: true, submissionId: inserted.rows[0].id };
}

export interface PackBuildOutcome {
  built: boolean;
}

/**
 * Builds and stores the notice's handoff pack when it does not stand — the
 * API-side half of the topology split (the worker settles rows, the API
 * owns the object store). Idempotent three ways at once: a pack that
 * already stands is left alone; a submission row that already stands is
 * never duplicated (only its pack reference is filled); and the bytes go
 * into the content-addressed store FIRST, so a failure between the bytes
 * and the rows leaves orphaned objects a retry re-covers, never a pack
 * reference pointing at nothing.
 *
 * Refused (built: false) for a notice that is not approved — a withdrawn or
 * superseded notice never gets a pack — and before the settle has created
 * the submission row; the read route answers not found for both.
 */
export async function buildHandoffPackIfMissing(
  deps: PackBuildDeps,
  noticeId: string,
  builtBy: string,
): Promise<PackBuildOutcome> {
  const notice = await loadFrozenNotice(deps.pool, noticeId);
  if (notice === null || notice.state !== "approved") {
    return { built: false };
  }
  const settled = await deps.pool.query<{ id: string; pack_ref: string | null }>(
    "select id, pack_ref from submissions where notice_id = $1",
    [noticeId],
  );
  if (settled.rows.length === 0) {
    // The captures approval queued have not settled yet; there is no
    // submission to hang a pack on.
    return { built: false };
  }
  const standing = await deps.pool.query<{ content_key: string }>(
    "select content_key from handoff_packs where notice_id = $1",
    [noticeId],
  );
  if (standing.rows.length > 0) {
    return { built: false };
  }

  // Bytes first: an interrupted build leaves orphaned content-addressed
  // objects, never a dangling reference.
  const packInput = await loadPackInput(deps.pool, noticeId);
  if (packInput === null) {
    return { built: false };
  }
  const { hash, manifest } = await storePackFiles(deps.store, packInput);

  const client = await deps.pool.connect();
  try {
    await client.query("begin");
    const row = await client.query<{ content_key: string }>(
      `insert into handoff_packs (notice_id, content_key, built_at, built_by, hash, files)
       values ($1, $2, $3, $4, $5, $6::jsonb)
       on conflict (notice_id) do nothing
       returning content_key`,
      [noticeId, packContentKey(hash), deps.now().toISOString(), builtBy, hash, JSON.stringify(manifest)],
    );
    if (row.rows.length === 0) {
      // A concurrent read built the same pack; its bytes are identical
      // (content addressing), so there is nothing more to do.
      await client.query("rollback");
      return { built: false };
    }
    await client.query(
      "update submissions set pack_ref = $2, pack_sha256 = $3 where notice_id = $1",
      [noticeId, packContentKey(hash), hash],
    );
    await client.query("commit");
    return { built: true };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The capture runner's post-terminal hook (slice 6b's worker half): a
 * pre-handoff capture that reached a terminal state wakes the notices that
 * waited on it, and each whose queue has fully settled gets its pending
 * submission — the DATABASE row alone; the pack's bytes are built by the
 * API (the topology grants the object store to it alone), idempotently on
 * the first pack read. Returns the submission ids it created; failures are
 * the caller's to log — the capture's own record already stands.
 */
export async function settlePreHandoffCapture(
  deps: SettleDeps,
  captureId: string,
): Promise<string[]> {
  const linked = await deps.pool.query<{ notice_id: string }>(
    `select n.id as notice_id
     from notice_pre_handoff_captures l
     join notices n on n.id = l.notice_id
     where l.capture_id = $1 and n.state = 'approved'`,
    [captureId],
  );
  const created: string[] = [];
  for (const row of linked.rows) {
    const outcome = await createPendingSubmissionIfSettled(deps, row.notice_id);
    if (outcome.created && outcome.submissionId !== null) {
      created.push(outcome.submissionId);
    }
  }
  return created;
}
