import { describe, expect, it } from "vitest";
import { sha256Hex } from "@patrol/evidence";
import {
  buildPackFiles,
  packManifestHash,
  recipientFormUrl,
  type HandoffPackInput,
} from "../src/pack.js";

/**
 * The handoff pack builder's pure half (docs/design/notice-composition.md
 * "The handoff pack"; ADR 0020): the four artifacts' contents, the dead
 * capture flag that never drops a URL, the checklist's frozen language, and
 * the deterministic digest that makes an identical rebuild land on the
 * identical content address.
 */

const BASE: HandoffPackInput = {
  recipient: "google",
  packLanguage: "en",
  approvedAt: "2026-01-01T00:00:00.000Z",
  formUrl: recipientFormUrl("google"),
  templateVersion: "google-search.en.v1@ed9f34155836",
  statements: [
    {
      key: "good_faith_belief",
      text: "I have a good faith belief that use of the copyrighted materials described above as allegedly infringing is not authorized by the copyright owner, its agent, or the law.",
    },
    {
      key: "accuracy_perjury_authority",
      text: "The information in this notification is accurate and I swear, under penalty of perjury, that I am the copyright owner or am authorized to act on behalf of the owner of an exclusive right that is allegedly infringed.",
    },
  ],
  fieldLabels: [{ name: "signature", label: "Signature", required: true }],
  resolvedFields: [
    { name: "product", value: "Web Search", required: true },
    { name: "copyright_owner", value: "Example Rights GmbH", required: true },
    { name: "owner_country", value: "DE", required: true },
    { name: "contact_email", value: "legal@example.test", required: true },
    { name: "signature", value: "Anna Beispiel", required: true },
  ],
  works: [
    { displayTitle: "Sunrise", releaseYear: 2024, titleType: "film" },
    { displayTitle: "Moonlight", releaseYear: 2023, titleType: "series" },
  ],
  citations: [
    {
      violationId: "00000000-0000-7000-8000-000000000001",
      url: "https://pirate.net/sunrise-1",
      displayTitle: "Sunrise",
      evidence: [
        { evidenceId: "00000000-0000-7000-8000-0000000000a1", capturedAt: "2025-12-01T00:00:00Z" },
      ],
    },
    {
      violationId: "00000000-0000-7000-8000-000000000002",
      url: "https://pirate.net/moonlight-1",
      displayTitle: "Moonlight",
      evidence: [
        { evidenceId: "00000000-0000-7000-8000-0000000000b1", capturedAt: "2025-12-02T00:00:00Z" },
      ],
    },
  ],
  rightsHolder: {
    legalName: "Example Rights GmbH",
    country: "DE",
    address: "1 Example Street, Exampleville, 10001",
    roleMailbox: "legal@example.test",
    phone: "+49 30 000000",
  },
  signatory: {
    fullLegalName: "Anna Beispiel",
    authorityBasis: "Copyright owner",
    contactEmail: "signatory@example.test",
  },
  captureFlags: [
    {
      violationId: "00000000-0000-7000-8000-000000000001",
      url: "https://pirate.net/sunrise-1",
      newestEvidenceId: "00000000-0000-7000-8000-0000000000a1",
      newestOutcome: "captured",
      earlierLiveEvidenceId: null,
    },
    {
      violationId: "00000000-0000-7000-8000-000000000002",
      url: "https://pirate.net/moonlight-1",
      newestEvidenceId: "00000000-0000-7000-8000-0000000000b9",
      newestOutcome: "dead",
      earlierLiveEvidenceId: "00000000-0000-7000-8000-0000000000b1",
    },
  ],
};

function fileByName(files: ReturnType<typeof buildPackFiles>, name: string) {
  const file = files.find((candidate) => candidate.fileName === name);
  if (file === undefined) {
    throw new Error(`pack carries no ${name}`);
  }
  return file;
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("the handoff pack builder", () => {
  it("builds the four artifacts for a Google notice", () => {
    const files = buildPackFiles(BASE);
    expect(files.map((file) => file.kind)).toEqual([
      "notice_html",
      "fields_json",
      "upload_file",
      "handoff_markdown",
    ]);

    // notice.html: printable, in the recipient's field order, statements
    // verbatim, signatory in the signature field, works with citations.
    const html = decode(fileByName(files, "notice.html").bytes);
    expect(html).toContain("Example Rights GmbH");
    expect(html).toContain("Anna Beispiel");
    expect(html).toContain("Sunrise");
    expect(html).toContain("https://pirate.net/sunrise-1");
    for (const field of BASE.resolvedFields) {
      expect(html).toContain(field.value);
    }
    for (const statement of BASE.statements) {
      expect(html).toContain(statement.text);
    }
    expect(html).toContain("00000000-0000-7000-8000-0000000000a1");

    // fields.json: the resolved field map with the registry's labels.
    const fieldsJson = JSON.parse(decode(fileByName(files, "fields.json").bytes));
    expect(fieldsJson.recipient).toBe("google");
    expect(fieldsJson.templateVersion).toBe("google-search.en.v1@ed9f34155836");
    expect(fieldsJson.fields).toHaveLength(BASE.resolvedFields.length);
    const signature = fieldsJson.fields.find(
      (field: { name: string }) => field.name === "signature",
    );
    expect(signature).toMatchObject({ value: "Anna Beispiel", required: true });
    // The registry's label text rides beside the field it labels.
    expect(fieldsJson.fields.find((f: { name: string }) => f.name === "product").label).toBeUndefined();

    // The upload file: one URL per line with # <title> comment lines.
    const upload = decode(fileByName(files, "upload.txt").bytes);
    expect(upload).toContain("# Sunrise");
    expect(upload).toContain("https://pirate.net/sunrise-1");
    expect(upload).toContain("# Moonlight");
    expect(upload).toContain("https://pirate.net/moonlight-1");

    // handoff.md: the checklist names the form, the sign-in, the steps,
    // the statements, and Google's acknowledgement shape.
    const handoff = decode(fileByName(files, "handoff.md").bytes);
    expect(handoff).toContain(recipientFormUrl("google"));
    expect(handoff).toContain(BASE.statements[0].text);
    expect(handoff).toContain("Removals Dashboard");
  });

  it("flags a dead newest capture and never drops the URL", () => {
    const files = buildPackFiles(BASE);
    const handoff = decode(fileByName(files, "handoff.md").bytes);
    // The dead URL is still cited everywhere and flagged with the earlier
    // live capture beside it.
    expect(handoff).toContain("https://pirate.net/moonlight-1");
    expect(handoff).toMatch(/dead/i);
    expect(handoff).toContain("00000000-0000-7000-8000-0000000000b1");
    const upload = decode(fileByName(files, "upload.txt").bytes);
    expect(upload).toContain("https://pirate.net/moonlight-1");
  });

  it("omits the upload file for Yandex, whose form takes a single URL", () => {
    const files = buildPackFiles({ ...BASE, recipient: "yandex" });
    expect(files.map((file) => file.kind)).not.toContain("upload_file");
    expect(files.map((file) => file.fileName)).toEqual([
      "notice.html",
      "fields.json",
      "handoff.md",
    ]);
    const handoff = decode(fileByName(files, "handoff.md").bytes);
    expect(handoff).toContain("Message-ID");
  });

  it("builds the checklist in the pack language, frozen at approval", () => {
    const ru = buildPackFiles({ ...BASE, packLanguage: "ru" });
    const handoffRu = decode(fileByName(ru, "handoff.md").bytes);
    expect(handoffRu).toContain("Контрольный список");
    expect(handoffRu).not.toContain("Handoff checklist");
    // The recipient-facing statements stay verbatim English regardless.
    expect(handoffRu).toContain(BASE.statements[0].text);
  });

  it("is deterministic: an identical rebuild hashes identically", () => {
    const first = buildPackFiles(BASE);
    const second = buildPackFiles(BASE);
    expect(packManifestHash(second)).toBe(packManifestHash(first));
    for (const file of first) {
      const twin = fileByName(second, file.fileName);
      expect(sha256Hex(twin.bytes)).toBe(sha256Hex(file.bytes));
    }
    // A content change moves the digest.
    const changed = buildPackFiles({
      ...BASE,
      resolvedFields: BASE.resolvedFields.map((field) =>
        field.name === "copyright_owner" ? { ...field, value: "Renamed GmbH" } : field,
      ),
    });
    expect(packManifestHash(changed)).not.toBe(packManifestHash(first));
  });

  it("hashes the manifest over names and file digests in artifact order", () => {
    const files = buildPackFiles(BASE);
    const expected = sha256Hex(
      new TextEncoder().encode(
        files.map((file) => `${file.fileName}:${sha256Hex(file.bytes)}\n`).join(""),
      ),
    );
    expect(packManifestHash(files)).toBe(expected);
  });
});
