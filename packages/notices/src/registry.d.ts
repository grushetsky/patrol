import type { Recipient } from "./statements.js";
/**
 * The statement-template registry's canonicalisation (implementation rules
 * "Notice templates / Hash canonicalisation"): the hash is SHA-256 over a
 * UTF-8 JSON array of ordered `{key, text}` objects, with each text NFC,
 * trimmed, and every whitespace run collapsed to one space; the keys are
 * Patrol's stable keys, never the recipient's display labels, and
 * interpolated values never enter the input. `hash12` is the first twelve
 * hex characters; the identifier is
 * `<recipient>.<language>.v<major>@<hash12>` with the recipient slug
 * (`google-search`, `bing`, `yandex`) the design fixes.
 */
/** One statement of a set: Patrol's key plus the recipient's exact text. */
export interface StatementSeed {
    key: string;
    text: string;
    /** Present only on callers carrying display data; never hashed. */
    label?: string;
    [extra: string]: unknown;
}
/**
 * A field label the template versions but the hash excludes: the label
 * text the recipient's form shows, carried verbatim from the research so
 * a label-only change has a basis — a new revision row with the SAME
 * hash12, because the digest runs over `{key, text}` pairs alone.
 */
export interface TemplateFieldLabel {
    /** The field's Patrol-stable name (`signature`, `date`). */
    name: string;
    /** The label text the recipient's form shows, verbatim from the research. */
    label: string;
    required: boolean;
}
/** The identity half of a template set, before the statements attach. */
export interface TemplateSetIdentity {
    recipient: Recipient;
    language: string;
    major: number;
}
/** The identifier's recipient slug (`google-search`, not `google`). */
export declare function recipientSlug(recipient: Recipient): string;
/** NFC, trimmed, every whitespace run collapsed to one space. */
export declare function canonicalStatementText(text: string): string;
/**
 * The canonical JSON the hash is taken over: a UTF-8 array of ordered
 * `{key, text}` objects in form order, no insignificant whitespace. Only
 * the two hash-bearing properties of each statement participate; labels
 * and interpolated values are dropped here, so no caller can smuggle them
 * into the digest.
 */
export declare function canonicalSetJson(statements: readonly StatementSeed[]): string;
/** The first twelve hex characters of SHA-256 over the canonical set. */
export declare function templateHash12(statements: readonly StatementSeed[]): string;
/** `<recipient>.<language>.v<major>@<hash12>`. */
export declare function templateIdentifier(set: TemplateSetIdentity & {
    statements: readonly StatementSeed[];
}): string;
/** One checked-in fixture: the ordered statements and the expected hash. */
export interface StatementFixture {
    identifier: string;
    recipient: Recipient;
    language: string;
    major: number;
    statements: StatementSeed[];
    /** The labeled fields the same set versions (hash-excluded). */
    fields: TemplateFieldLabel[];
    expectedHash12: string;
}
/** Loads the checked-in fixtures; throws when the file is missing or malformed. */
export declare function loadStatementFixtures(path?: string | URL): StatementFixture[];
/**
 * Recomputes one fixture: the ordered statements must hash to the expected
 * twelve characters and the identifier must carry them. A drifted text, an
 * edited expected hash, or a reordered set fails here — which is exactly
 * what the CI test wants.
 */
export declare function verifyStatementFixture(fixture: StatementFixture): {
    ok: true;
    hash12: string;
} | {
    ok: false;
    reason: string;
};
