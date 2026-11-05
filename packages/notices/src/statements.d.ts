import type { StatementSeed, TemplateFieldLabel } from "./registry.js";
/**
 * The verified statement sets (docs/research/recipient-statements.md, every
 * source read 2026-11-04): each recipient's OWN form text, reproduced
 * verbatim — Patrol never translates, paraphrases, or invents. The keys are
 * Patrol's stable keys without a recipient prefix; the recipient lives in
 * the set, so the same concept key holds each recipient's own wording and
 * the cross-recipient matrix stays legible.
 *
 * Google combines accuracy, penalty of perjury, and authority in ONE
 * statement; Bing splits authority into its own statement and adds a
 * separate 512(f) acknowledgement plus the displayed sharing disclosure;
 * Yandex combines accuracy, perjury, and authority and adds the required
 * data-processing consent. The signature is a FIELD for every recipient and
 * the date a FIELD for Yandex alone — labels the template row versions but
 * the hash excludes.
 */
/** The recipients a statement template exists for. */
export type Recipient = "google" | "bing" | "yandex";
/** The template languages the verified sets exist in. */
export type TemplateLanguage = "en";
/** One verified statement set: identity, ordered statements, labels, sources. */
export interface VerifiedStatementSet {
    recipient: Recipient;
    language: TemplateLanguage;
    major: number;
    /** The statements in form order; the exact text the recipient publishes. */
    statements: StatementSeed[];
    /** Field labels the same template row versions (hash-excluded). */
    fields: TemplateFieldLabel[];
    /** The sources an approving operator re-reads, in the order they are checked. */
    sourceUrls: string[];
    /** When the sources were read (the research's access date). */
    accessedAt: string;
}
/** Every verified set, in recipient order. */
export declare const STATEMENT_SETS: readonly VerifiedStatementSet[];
/**
 * The verified set for one recipient and language. A recipient/language
 * pair with no verified set has NO template — composition is refused
 * rather than falling back to another language (the research's rule: no
 * locale is created until a human has read it).
 */
export declare function statementSetFor(recipient: Recipient, language?: TemplateLanguage): VerifiedStatementSet;
