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

/** Google Search, English, first revision: the published help statements. */
const GOOGLE_EN_V1: VerifiedStatementSet = {
  recipient: "google",
  language: "en",
  major: 1,
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
  fields: [
    {
      name: "signature",
      label:
        "Complete complaints require the physical or electronic signature of the copyright owner or a representative authorized to act on their behalf. To satisfy this requirement, you may type your full legal name to act as your signature at the bottom of your complaint.",
      required: true,
    },
  ],
  sourceUrls: [
    "https://support.google.com/legal/answer/3463239?hl=en",
    "https://reportcontent.google.com/forms/dmca_search",
  ],
  accessedAt: "2026-11-04",
};

/** Bing content removal, English, first revision: the form's own checkboxes. */
const BING_EN_V1: VerifiedStatementSet = {
  recipient: "bing",
  language: "en",
  major: 1,
  statements: [
    {
      key: "good_faith_belief",
      text: "By typing in my name (electronic signature), I state that I have a good faith belief that the use of the material is not authorized by the intellectual property owner, its agent, or the law (e.g., it is not fair use).",
    },
    {
      key: "authority_to_act",
      text: "I represent that the information in the notification is accurate and, under penalty of perjury, that I am authorized to act on behalf of the owner of an exclusive right that is allegedly infringed.",
    },
    {
      key: "512f_acknowledgement",
      text: "As applicable under 17 U.S.C. 512(f), I acknowledge that I may be subject to liability for damages if I knowingly materially misrepresent that material or activity is infringing.",
    },
    {
      key: "third_party_sharing",
      text: "I understand that the information submitted in this form may be shared with third parties or the public, including the alleged infringer about whom I am filing this complaint.",
    },
  ],
  fields: [{ name: "signature", label: "Signature", required: true }],
  sourceUrls: [
    "https://www.bing.com/webmaster/contentremovalform/showcontentremovalform",
    "https://www.microsoft.com/en-us/legal/intellectualproperty/infringement",
  ],
  accessedAt: "2026-11-04",
};

/** Yandex copyright form, English, first revision: the survey's own text. */
const YANDEX_EN_V1: VerifiedStatementSet = {
  recipient: "yandex",
  language: "en",
  major: 1,
  statements: [
    {
      key: "good_faith_belief",
      text: "By submitting this notice and signing with your digital signature below, you confirm that you have a good faith belief that the use of the material in the manner complained of is not authorized by the copyright owner, its agent, or the law.",
    },
    {
      key: "accuracy_perjury_authority",
      text: "You further confirm that the information in this notification is accurate and, under penalty of perjury, that you are authorized to act on behalf of the owner of an exclusive right that is allegedly infringed.",
    },
    {
      key: "data_processing_consent",
      text: "I hereby consent to the processing of the personal data provided above for the purpose of reviewing the application and getting feedback. I am aware of my right to withdraw the consent via address mentioned above.",
    },
  ],
  fields: [
    { name: "signature", label: "Signature (please provide your full name)", required: true },
    { name: "date", label: "Date (Format:DD.MM.YYYY)", required: true },
  ],
  sourceUrls: [
    "https://forms.yandex.com/surveys/1773/?lang=en&iframe=1",
    "https://yandex.ru/legal/copyright/en/",
    "https://yandex.ru/support/copyright-complaint/en/",
  ],
  accessedAt: "2026-11-04",
};

/** Every verified set, in recipient order. */
export const STATEMENT_SETS: readonly VerifiedStatementSet[] = [
  GOOGLE_EN_V1,
  BING_EN_V1,
  YANDEX_EN_V1,
];

/**
 * The verified set for one recipient and language. A recipient/language
 * pair with no verified set has NO template — composition is refused
 * rather than falling back to another language (the research's rule: no
 * locale is created until a human has read it).
 */
export function statementSetFor(
  recipient: Recipient,
  language: TemplateLanguage = "en",
): VerifiedStatementSet {
  const set = STATEMENT_SETS.find(
    (candidate) => candidate.recipient === recipient && candidate.language === language,
  );
  if (set === undefined) {
    throw new Error(`no verified statement template for ${recipient}.${language}`);
  }
  return set;
}
