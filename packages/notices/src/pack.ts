import { t, type Locale } from "@patrol/i18n";
import { sha256Hex } from "@patrol/evidence";
import type { Recipient } from "./statements.js";

/**
 * The handoff pack's pure builder (docs/design/notice-composition.md "The
 * handoff pack"; ADR 0020): four artifacts rendered from the FROZEN notice —
 * the printable notice, the resolved field map with the registry's labels,
 * the recipient's upload file where one applies, and the operator checklist
 * in the approving operator's language. Every byte derives from frozen
 * content alone, so an identical rebuild hashes identically and lands on
 * the identical content address; a pack that must change means a superseded
 * notice, never a regeneration.
 *
 * The DATE is deliberately absent from every artifact's computed values:
 * the design renders the submission date at handoff (the operator types it
 * into the form), never into the notice, and a generation timestamp would
 * break determinism for nothing.
 */

/** The artifact kinds the contract's HandoffArtifactKind fixes. */
export type HandoffArtifactKind =
  | "notice_html"
  | "fields_json"
  | "upload_file"
  | "handoff_markdown";

/** One built file of the pack. */
export interface BuiltPackFile {
  kind: HandoffArtifactKind;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * The pack-level capture flag for one cited URL. The newest capture's id
 * and outcome are present by construction — the shared loader skips a URL
 * nothing has observed, the same rule the contract's CaptureFlag fixes.
 */
export interface PackCaptureFlag {
  violationId: string;
  url: string;
  newestEvidenceId: string;
  newestOutcome: "captured" | "dead" | "blocked" | "error";
  /** The newest capture whose outcome was captured, when one exists. */
  earlierLiveEvidenceId: string | null;
}

/** One cited URL the pack renders. */
export interface PackCitation {
  violationId: string;
  url: string;
  displayTitle: string;
  evidence: ReadonlyArray<{ evidenceId: string; capturedAt: string }>;
}

/** The frozen facts the pack renders from — everything live is already in. */
export interface HandoffPackInput {
  recipient: Recipient;
  /** The approving operator's language, frozen at approval. */
  packLanguage: Locale;
  approvedAt: string;
  formUrl: string;
  templateVersion: string;
  statements: ReadonlyArray<{ key: string; text: string }>;
  /** The registry's field labels ({name, label, required}), hash-excluded. */
  fieldLabels: ReadonlyArray<{ name: string; label: string; required: boolean }>;
  resolvedFields: ReadonlyArray<{
    name: string;
    value: string;
    required: boolean;
    maxLength?: number;
  }>;
  works: ReadonlyArray<{
    displayTitle: string;
    releaseYear: number;
    titleType: string;
    authorizedExampleUrl?: string;
  }>;
  citations: ReadonlyArray<PackCitation>;
  rightsHolder: {
    legalName: string;
    country: string;
    address: string | null;
    roleMailbox: string;
    phone?: string;
  };
  signatory: {
    fullLegalName: string;
    authorityBasis: string;
    contactEmail: string;
  };
  /** Per cited URL, the newest capture outcome at pack build. */
  captureFlags: ReadonlyArray<PackCaptureFlag>;
}

/** The recipients whose forms take a URL file. */
export function recipientTakesUploadFile(recipient: Recipient): boolean {
  return recipient === "google" || recipient === "bing";
}

/**
 * The recipient's form URL, carried from the verified statement research
 * (docs/research/recipient-statements.md) and snapshotted into the profile
 * snapshot at approval — the form the checklist tells the operator to open.
 */
export function recipientFormUrl(recipient: Recipient): string {
  switch (recipient) {
    case "google":
      return "https://reportcontent.google.com/forms/dmca_search";
    case "bing":
      return "https://www.bing.com/webmaster/contentremovalform/showcontentremovalform";
    case "yandex":
      return "https://forms.yandex.com/surveys/1773/?lang=en";
  }
}

/**
 * The pack-level digest: SHA-256 over `name:sha256` lines in the fixed
 * artifact order. Identical content lands on the identical digest, so the
 * pack's content address and the stored manifest row are stable.
 */
export function packManifestHash(files: readonly BuiltPackFile[]): string {
  const canonical = files.map((file) => `${file.fileName}:${sha256Hex(file.bytes)}\n`).join("");
  return sha256Hex(new TextEncoder().encode(canonical));
}

/**
 * The pack's content-addressed DATABASE reference (`packs/<hash>`) — the
 * logical id the handoff_packs row and the submission's pack_ref carry.
 * Not an object-store key: the object keys are the evidence store's own
 * (`artifactKey` in @patrol/evidence, `packs/sha256/<shards>/<hash>`), and
 * the two spellings are deliberately different things.
 */
export function packContentKey(packSha256: string): string {
  return `packs/${packSha256}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The printable notice: recipient's field order, statements verbatim. */
function buildNoticeHtml(input: HandoffPackInput): string {
  const lines: string[] = [];
  lines.push("<!doctype html>");
  lines.push('<html lang="en">');
  lines.push("<head><meta charset=\"utf-8\"><title>Notice</title></head>");
  lines.push("<body>");
  lines.push(
    `<h1>Notice of copyright infringement — ${escapeHtml(input.recipient === "google" ? "Google Search" : input.recipient === "bing" ? "Bing content removal" : "Yandex copyright form")}</h1>`,
  );
  lines.push(`<p>Approved at ${escapeHtml(input.approvedAt)}.</p>`);
  lines.push("<h2>Claimant</h2>");
  lines.push("<dl>");
  lines.push(`<dt>Copyright owner</dt><dd>${escapeHtml(input.rightsHolder.legalName)}</dd>`);
  lines.push(`<dt>Country</dt><dd>${escapeHtml(input.rightsHolder.country)}</dd>`);
  if (input.rightsHolder.address !== null) {
    lines.push(`<dt>Address</dt><dd>${escapeHtml(input.rightsHolder.address)}</dd>`);
  }
  lines.push(`<dt>Contact</dt><dd>${escapeHtml(input.rightsHolder.roleMailbox)}</dd>`);
  if (input.rightsHolder.phone !== undefined) {
    lines.push(`<dt>Phone</dt><dd>${escapeHtml(input.rightsHolder.phone)}</dd>`);
  }
  lines.push("</dl>");
  lines.push("<h2>Signatory</h2>");
  lines.push("<dl>");
  lines.push(`<dt>Full legal name</dt><dd>${escapeHtml(input.signatory.fullLegalName)}</dd>`);
  lines.push(`<dt>Authority</dt><dd>${escapeHtml(input.signatory.authorityBasis)}</dd>`);
  lines.push(`<dt>Contact</dt><dd>${escapeHtml(input.signatory.contactEmail)}</dd>`);
  lines.push("</dl>");
  lines.push("<h2>Resolved fields</h2>");
  lines.push("<table><thead><tr><th>Field</th><th>Value</th><th>Required</th></tr></thead><tbody>");
  for (const field of input.resolvedFields) {
    lines.push(
      `<tr><td>${escapeHtml(field.name)}</td><td>${escapeHtml(field.value)}</td><td>${field.required ? "yes" : "no"}</td></tr>`,
    );
  }
  lines.push("</tbody></table>");
  lines.push("<h2>Work identification</h2>");
  lines.push("<table><thead><tr><th>Work</th><th>Year</th><th>Type</th><th>Authorized example</th></tr></thead><tbody>");
  for (const work of input.works) {
    lines.push(
      `<tr><td>${escapeHtml(work.displayTitle)}</td><td>${work.releaseYear}</td><td>${escapeHtml(work.titleType)}</td><td>${escapeHtml(work.authorizedExampleUrl ?? "")}</td></tr>`,
    );
  }
  lines.push("</tbody></table>");
  lines.push("<h2>Cited URLs and evidence</h2>");
  lines.push("<table><thead><tr><th>Work</th><th>URL</th><th>Evidence</th></tr></thead><tbody>");
  for (const citation of input.citations) {
    const evidence = citation.evidence
      .map((pin) => `${escapeHtml(pin.evidenceId)} (${escapeHtml(pin.capturedAt)})`)
      .join(", ");
    lines.push(
      `<tr><td>${escapeHtml(citation.displayTitle)}</td><td>${escapeHtml(citation.url)}</td><td>${evidence}</td></tr>`,
    );
  }
  lines.push("</tbody></table>");
  lines.push("<h2>Statements</h2>");
  lines.push("<ol>");
  for (const statement of input.statements) {
    lines.push(`<li><p>${escapeHtml(statement.text)}</p></li>`);
  }
  lines.push("</ol>");
  lines.push(
    `<p>Signature: ${escapeHtml(input.signatory.fullLegalName)}</p>`,
  );
  lines.push("</body></html>");
  return lines.join("\n");
}

/** fields.json: the resolved field map with the registry's labels. */
function buildFieldsJson(input: HandoffPackInput): string {
  const labels = new Map(input.fieldLabels.map((label) => [label.name, label]));
  return `${JSON.stringify(
    {
      recipient: input.recipient,
      templateVersion: input.templateVersion,
      fields: input.resolvedFields.map((field) => ({
        name: field.name,
        ...(labels.has(field.name) ? { label: labels.get(field.name)!.label } : {}),
        value: field.value,
        required: field.required,
        ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
      })),
    },
    null,
    2,
  )}\n`;
}

/** The upload file: one URL per line, `# <title>` comment lines for Google. */
function buildUploadFile(input: HandoffPackInput): string {
  if (input.recipient === "google") {
    const byTitle = new Map<string, string[]>();
    for (const citation of input.citations) {
      const urls = byTitle.get(citation.displayTitle) ?? [];
      urls.push(citation.url);
      byTitle.set(citation.displayTitle, urls);
    }
    const lines: string[] = [];
    for (const [title, urls] of byTitle) {
      lines.push(`# ${title}`);
      lines.push(...urls);
    }
    return `${lines.join("\n")}\n`;
  }
  // Bing: one URL per line, no comments.
  return `${input.citations.map((citation) => citation.url).join("\n")}\n`;
}

function fill(template: string, values: Record<string, string>): string {
  let filled = template;
  for (const [key, value] of Object.entries(values)) {
    filled = filled.replaceAll(`{${key}}`, value);
  }
  return filled;
}

/** handoff.md: the operator checklist in the frozen pack language. */
function buildHandoffMarkdown(input: HandoffPackInput): string {
  const lang = input.packLanguage;
  const lines: string[] = [];
  lines.push(`# ${t(lang, "pack.handoff.title")}`);
  lines.push("");
  lines.push(`## ${t(lang, "pack.handoff.form")}`);
  lines.push("");
  lines.push(`${input.formUrl}`);
  lines.push("");
  lines.push(
    t(lang, input.recipient === "google" ? "pack.handoff.signIn.required" : "pack.handoff.signIn.none"),
  );
  lines.push("");
  lines.push(`## ${t(lang, "pack.handoff.steps")}`);
  lines.push("");
  const steps = [
    t(lang, "pack.handoff.step.open"),
    t(lang, "pack.handoff.step.fields"),
    ...(recipientTakesUploadFile(input.recipient)
      ? [fill(t(lang, "pack.handoff.step.upload"), { file: "upload.txt" })]
      : []),
    t(lang, "pack.handoff.step.tick"),
    t(lang, "pack.handoff.step.sign"),
    t(lang, "pack.handoff.step.date"),
    t(lang, "pack.handoff.step.submit"),
  ];
  steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  lines.push("");
  lines.push(t(lang, "pack.handoff.publicity"));
  lines.push("");
  lines.push(`## ${t(lang, "pack.handoff.statements")}`);
  lines.push("");
  for (const statement of input.statements) {
    lines.push(`- [ ] ${statement.text}`);
  }
  lines.push("");
  lines.push(`## ${t(lang, "pack.handoff.ack")}`);
  lines.push("");
  lines.push(
    t(
      lang,
      input.recipient === "google"
        ? "pack.handoff.ack.google"
        : input.recipient === "bing"
          ? "pack.handoff.ack.bing"
          : "pack.handoff.ack.yandex",
    ),
  );
  lines.push("");

  // Capture warnings: a dead or blocked newest capture flags the URL beside
  // the earlier live capture — never a silent drop.
  const warnings = input.captureFlags.filter(
    (flag) => flag.newestOutcome === "dead" || flag.newestOutcome === "blocked",
  );
  if (warnings.length > 0) {
    lines.push(`## ${t(lang, "pack.handoff.flags")}`);
    lines.push("");
    for (const flag of warnings) {
      const earlier =
        flag.earlierLiveEvidenceId === null ? "" : ` (${flag.earlierLiveEvidenceId})`;
      lines.push(
        fill(t(lang, flag.newestOutcome === "dead" ? "pack.handoff.flag.dead" : "pack.handoff.flag.blocked"), {
          url: flag.url,
          earlier,
        }),
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Builds the pack's files from the frozen notice. The artifact order is
 * fixed — notice.html, fields.json, the upload file where one applies,
 * handoff.md — because the manifest digest runs over it.
 */
export function buildPackFiles(input: HandoffPackInput): BuiltPackFile[] {
  const encoder = new TextEncoder();
  const files: BuiltPackFile[] = [
    {
      kind: "notice_html",
      fileName: "notice.html",
      contentType: "text/html; charset=utf-8",
      bytes: encoder.encode(buildNoticeHtml(input)),
    },
    {
      kind: "fields_json",
      fileName: "fields.json",
      contentType: "application/json",
      bytes: encoder.encode(buildFieldsJson(input)),
    },
  ];
  if (recipientTakesUploadFile(input.recipient)) {
    files.push({
      kind: "upload_file",
      fileName: "upload.txt",
      contentType: "text/plain; charset=utf-8",
      bytes: encoder.encode(buildUploadFile(input)),
    });
  }
  files.push({
    kind: "handoff_markdown",
    fileName: "handoff.md",
    contentType: "text/markdown; charset=utf-8",
    bytes: encoder.encode(buildHandoffMarkdown(input)),
  });
  return files;
}
