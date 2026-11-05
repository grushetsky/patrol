import { type Locale } from "@patrol/i18n";
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
export type HandoffArtifactKind = "notice_html" | "fields_json" | "upload_file" | "handoff_markdown";
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
    evidence: ReadonlyArray<{
        evidenceId: string;
        capturedAt: string;
    }>;
}
/** The frozen facts the pack renders from — everything live is already in. */
export interface HandoffPackInput {
    recipient: Recipient;
    /** The approving operator's language, frozen at approval. */
    packLanguage: Locale;
    approvedAt: string;
    formUrl: string;
    templateVersion: string;
    statements: ReadonlyArray<{
        key: string;
        text: string;
    }>;
    /** The registry's field labels ({name, label, required}), hash-excluded. */
    fieldLabels: ReadonlyArray<{
        name: string;
        label: string;
        required: boolean;
    }>;
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
export declare function recipientTakesUploadFile(recipient: Recipient): boolean;
/**
 * The recipient's form URL, carried from the verified statement research
 * (docs/research/recipient-statements.md) and snapshotted into the profile
 * snapshot at approval — the form the checklist tells the operator to open.
 */
export declare function recipientFormUrl(recipient: Recipient): string;
/**
 * The pack-level digest: SHA-256 over `name:sha256` lines in the fixed
 * artifact order. Identical content lands on the identical digest, so the
 * pack's content address and the stored manifest row are stable.
 */
export declare function packManifestHash(files: readonly BuiltPackFile[]): string;
/**
 * The pack's content-addressed DATABASE reference (`packs/<hash>`) — the
 * logical id the handoff_packs row and the submission's pack_ref carry.
 * Not an object-store key: the object keys are the evidence store's own
 * (`artifactKey` in @patrol/evidence, `packs/sha256/<shards>/<hash>`), and
 * the two spellings are deliberately different things.
 */
export declare function packContentKey(packSha256: string): string;
/**
 * Builds the pack's files from the frozen notice. The artifact order is
 * fixed — notice.html, fields.json, the upload file where one applies,
 * handoff.md — because the manifest digest runs over it.
 */
export declare function buildPackFiles(input: HandoffPackInput): BuiltPackFile[];
