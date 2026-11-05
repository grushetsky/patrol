import { describe, expect, it } from "vitest";
import { STATEMENT_SETS, statementSetFor } from "../src/statements.js";
import { templateIdentifier } from "../src/registry.js";

/**
 * Seam 2 (per-recipient wording): each recipient's statement set is the
 * recipient's OWN text, reproduced verbatim from the verified research
 * (docs/research/recipient-statements.md, read 2026-11-04) — Google
 * combines accuracy, perjury, and authority in one statement; Bing splits
 * authority and adds a separate 512(f) acknowledgement; Yandex adds the
 * data-processing consent. Patrol never invents a statement for a
 * recipient that does not require one.
 */

/** Google's published statements, copied verbatim from the research. */
const GOOGLE_TEXTS = [
  "I have a good faith belief that use of the copyrighted materials described above as allegedly infringing is not authorized by the copyright owner, its agent, or the law.",
  "The information in this notification is accurate and I swear, under penalty of perjury, that I am the copyright owner or am authorized to act on behalf of the owner of an exclusive right that is allegedly infringed.",
];

const BING_TEXTS = [
  "By typing in my name (electronic signature), I state that I have a good faith belief that the use of the material is not authorized by the intellectual property owner, its agent, or the law (e.g., it is not fair use).",
  "I represent that the information in the notification is accurate and, under penalty of perjury, that I am authorized to act on behalf of the owner of an exclusive right that is allegedly infringed.",
  "As applicable under 17 U.S.C. 512(f), I acknowledge that I may be subject to liability for damages if I knowingly materially misrepresent that material or activity is infringing.",
  "I understand that the information submitted in this form may be shared with third parties or the public, including the alleged infringer about whom I am filing this complaint.",
];

const YANDEX_TEXTS = [
  "By submitting this notice and signing with your digital signature below, you confirm that you have a good faith belief that the use of the material in the manner complained of is not authorized by the copyright owner, its agent, or the law.",
  "You further confirm that the information in this notification is accurate and, under penalty of perjury, that you are authorized to act on behalf of the owner of an exclusive right that is allegedly infringed.",
  "I hereby consent to the processing of the personal data provided above for the purpose of reviewing the application and getting feedback. I am aware of my right to withdraw the consent via address mentioned above.",
];

describe("the verified statement sets", () => {
  it("reproduces Google's two published statements verbatim, in form order", () => {
    const google = statementSetFor("google");
    expect(google.statements.map((statement) => statement.text)).toEqual(GOOGLE_TEXTS);
    expect(google.statements.map((statement) => statement.key)).toEqual([
      "good_faith_belief",
      "accuracy_perjury_authority",
    ]);
  });

  it("reproduces Bing's four form statements verbatim: authority split, separate 512(f)", () => {
    const bing = statementSetFor("bing");
    expect(bing.statements.map((statement) => statement.text)).toEqual(BING_TEXTS);
    expect(bing.statements.map((statement) => statement.key)).toEqual([
      "good_faith_belief",
      "authority_to_act",
      "512f_acknowledgement",
      "third_party_sharing",
    ]);
  });

  it("reproduces Yandex's three survey statements verbatim, with the consent", () => {
    const yandex = statementSetFor("yandex");
    expect(yandex.statements.map((statement) => statement.text)).toEqual(YANDEX_TEXTS);
    expect(yandex.statements.map((statement) => statement.key)).toEqual([
      "good_faith_belief",
      "accuracy_perjury_authority",
      "data_processing_consent",
    ]);
  });

  it("carries the identifiers the research verified", () => {
    expect(STATEMENT_SETS.map(templateIdentifier)).toEqual([
      "google-search.en.v1@ed9f34155836",
      "bing.en.v1@e36eaf64fd3c",
      "yandex.en.v1@209722198e33",
    ]);
  });

  it("carries the sources an approving operator re-reads, with the access date", () => {
    const google = statementSetFor("google");
    expect(google.sourceUrls).toContain("https://support.google.com/legal/answer/3463239?hl=en");
    expect(google.accessedAt).toBe("2026-11-04");
    const bing = statementSetFor("bing");
    expect(bing.sourceUrls).toContain(
      "https://www.bing.com/webmaster/contentremovalform/showcontentremovalform",
    );
    const yandex = statementSetFor("yandex");
    expect(yandex.sourceUrls).toContain("https://yandex.ru/legal/copyright/en/");
  });
});

describe("no cross-recipient invention", () => {
  it("Google has no separate 512(f) acknowledgement and no data-processing consent", () => {
    const keys = statementSetFor("google").statements.map((statement) => statement.key);
    expect(keys).not.toContain("512f_acknowledgement");
    expect(keys).not.toContain("data_processing_consent");
    expect(keys).not.toContain("authority_to_act");
  });

  it("Bing has no data-processing consent", () => {
    const keys = statementSetFor("bing").statements.map((statement) => statement.key);
    expect(keys).not.toContain("data_processing_consent");
  });

  it("Yandex has no 512(f) acknowledgement and no third-party sharing consent", () => {
    const keys = statementSetFor("yandex").statements.map((statement) => statement.key);
    expect(keys).not.toContain("512f_acknowledgement");
    expect(keys).not.toContain("third_party_sharing");
    expect(keys).not.toContain("authority_to_act");
  });

  it("Bing and Yandex ship English only: no other language is seeded", () => {
    const languages = STATEMENT_SETS.map((set) => `${set.recipient}:${set.language}`);
    expect(languages).toEqual(["google:en", "bing:en", "yandex:en"]);
  });
});

describe("the field labels the template versions but the hash excludes", () => {
  it("carries each recipient's signature field, and Yandex's date, as labels", () => {
    const google = statementSetFor("google").fields;
    expect(google.map((field) => field.name)).toEqual(["signature"]);

    const bing = statementSetFor("bing").fields;
    expect(bing.map((field) => field.name)).toEqual(["signature"]);

    const yandex = statementSetFor("yandex").fields;
    expect(yandex.map((field) => field.name)).toEqual(["signature", "date"]);
    expect(yandex.every((field) => field.required)).toBe(true);
  });

  it("carries the label text verbatim from the research (2026-11-04)", () => {
    // Yandex's own field labels, read from the rendered survey.
    const yandex = statementSetFor("yandex").fields;
    expect(yandex.find((field) => field.name === "signature")?.label).toBe(
      "Signature (please provide your full name)",
    );
    expect(yandex.find((field) => field.name === "date")?.label).toBe(
      "Date (Format:DD.MM.YYYY)",
    );

    // Bing's observable form label.
    expect(statementSetFor("bing").fields[0].label).toBe("Signature");

    // Google's form sits behind a sign-in wall, so its label is the
    // published instruction the help article gives for the signature.
    const google = statementSetFor("google").fields[0].label;
    expect(google).toContain("physical or electronic signature");
    expect(google).toContain("type your full legal name");
  });
});
