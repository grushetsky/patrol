import type { Pool } from "pg";
import type { PackStore } from "@patrol/notices";
import { buildHandoffPackIfMissing, loadCaptureFlagsForCitations, recipientFormUrl } from "@patrol/notices";
import { ApiError } from "../../errors.js";

/**
 * GET /notices/{id}/pack (Patrol.Http `pack`): the frozen pack, with a
 * signed download per artifact and the capture flags read LIVE — the flags
 * exist precisely so a pre-handoff capture that came back dead or blocked
 * after the freeze is VISIBLE at handoff, so they track the evidence
 * table, not the frozen bytes (which carry the same warning where the
 * operator reads it).
 *
 * The pack's BYTES are built here, lazily and idempotently, when they do
 * not stand yet: the deployment topology grants the object store to the
 * API alone, so the worker's settle hook creates only the submission row
 * and the first pack read builds and stores the pack (bytes first, rows
 * second — an interrupted build leaves orphaned content-addressed bytes a
 * retry re-covers, never a dangling reference). Until the notice is
 * approved AND its submission has settled there is nothing to build, and
 * the read answers not found — the contract's only declared error here.
 */

/** The artifact kind each pack file name is (the manifest's fixed names). */
function artifactKind(fileName: string): "notice_html" | "fields_json" | "upload_file" | "handoff_markdown" {
  switch (fileName) {
    case "notice.html":
      return "notice_html";
    case "fields.json":
      return "fields_json";
    case "upload.txt":
      return "upload_file";
    case "handoff.md":
      return "handoff_markdown";
    default:
      throw new ApiError(500, "internal_error");
  }
}

const ARTIFACT_CONTENT_TYPES: Record<string, string> = {
  notice_html: "text/html; charset=utf-8",
  fields_json: "application/json",
  upload_file: "text/plain; charset=utf-8",
  handoff_markdown: "text/markdown; charset=utf-8",
};

/** Reads the pack — building it first when it does not stand — and presigns its artifacts. */
export async function readHandoffPack(
  deps: { pool: Pool; store: PackStore; now: () => Date; ttlSeconds: number },
  noticeId: string,
  builtBy: string,
): Promise<Record<string, unknown>> {
  const notice = await deps.pool.query<{
    recipient: "google" | "bing" | "yandex";
    profile_snapshot: { formUrl?: string } | null;
  }>(
    "select recipient, profile_snapshot from notices where id = $1",
    [noticeId],
  );
  if (notice.rows.length === 0) {
    throw new ApiError(404, "not_found");
  }

  // The API-side half of the topology split: build the pack's bytes when
  // they do not stand. A notice that is not approved, or whose captures
  // have not settled, builds nothing and reads as not found below.
  await buildHandoffPackIfMissing(
    { pool: deps.pool, now: deps.now, store: deps.store },
    noticeId,
    builtBy,
  );

  const pack = await deps.pool.query<{
    content_key: string;
    hash: string;
    built_at: Date;
    files: Array<{ name: string; sha256: string; size: number }>;
  }>(
    "select content_key, hash, built_at, files from handoff_packs where notice_id = $1",
    [noticeId],
  );
  if (pack.rows.length === 0) {
    // The pack exists once approval has settled its captures; before that
    // there is nothing to download, and the contract's only declared error
    // for this read is not found.
    throw new ApiError(404, "not_found");
  }
  const row = pack.rows[0];
  const submission = await deps.pool.query<{ id: string; pack_language: "en" | "ru" }>(
    "select id, pack_language from submissions where notice_id = $1",
    [noticeId],
  );

  const artifacts = [];
  for (const file of row.files) {
    const kind = artifactKind(file.name);
    const reference = await deps.store.presignDownload({
      kind,
      sha256: file.sha256,
      contentType: ARTIFACT_CONTENT_TYPES[kind],
      expiresInSeconds: deps.ttlSeconds,
    });
    artifacts.push({
      kind,
      fileName: file.name,
      contentType: ARTIFACT_CONTENT_TYPES[kind],
      byteSize: file.size,
      downloadUrl: reference.url,
    });
  }

  // The live capture flags, through the one shared loader the pack builder
  // itself reads — per cited URL, the newest capture and, when it is dead
  // or blocked, the earlier live capture beside it. The contract spells the
  // earlier live capture OPTIONAL, so its absence omits the field rather
  // than nulling it.
  const captureFlags = (await loadCaptureFlagsForCitations(deps.pool, noticeId)).map((flag) => ({
    violationId: flag.violationId,
    url: flag.url,
    newestEvidenceId: flag.newestEvidenceId,
    newestOutcome: flag.newestOutcome,
    ...(flag.earlierLiveEvidenceId === null ? {} : { earlierLiveEvidenceId: flag.earlierLiveEvidenceId }),
  }));

  return {
    submissionId: submission.rows[0]?.id,
    packRef: row.content_key,
    packSha256: row.hash,
    generatedAt: row.built_at.toISOString(),
    packLanguage: submission.rows[0]?.pack_language ?? "en",
    formUrl:
      (notice.rows[0].profile_snapshot as { formUrl?: string } | null)?.formUrl ??
      recipientFormUrl(notice.rows[0].recipient),
    artifacts,
    captureFlags,
  };
}
