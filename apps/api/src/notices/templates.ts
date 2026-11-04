import { createHash } from "node:crypto";
import type { Queryable } from "../db/migrations.js";

export const SYSTEM_OPERATOR_ID = "00000000-0000-7000-8000-000000000000";

export interface Statement {
  key: string;
  text: string;
}

export interface StatementTemplate {
  recipient: "google-search" | "bing" | "yandex";
  language: string;
  major: number;
  statements: Statement[];
  sourceUrls: string[];
  formUrl: string;
  accessedAt: string;
}

export const STATEMENT_TEMPLATES: StatementTemplate[] = [
  {
    recipient: "google-search",
    language: "en",
    major: 1,
    statements: [
      {
        key: "google.good_faith_belief",
        text: "I have a good faith belief that use of the copyrighted materials described above as allegedly infringing is not authorized by the copyright owner, its agent, or the law.",
      },
      {
        key: "google.accuracy_perjury_authority",
        text: "The information in this notification is accurate and I swear, under penalty of perjury, that I am the copyright owner or am authorized to act on behalf of the owner of an exclusive right that is allegedly infringed.",
      },
    ],
    sourceUrls: [
      "https://support.google.com/legal/answer/3463239?hl=en",
      "https://support.google.com/transparencyreport/answer/7347743?hl=en",
    ],
    formUrl: "https://reportcontent.google.com/forms/dmca_search",
    accessedAt: "2026-11-04T00:00:00.000Z",
  },
  {
    recipient: "bing",
    language: "en",
    major: 1,
    statements: [
      {
        key: "bing.good_faith_belief",
        text: "By typing in my name (electronic signature), I state that I have a good faith belief that the use of the material is not authorized by the intellectual property owner, its agent, or the law (e.g., it is not fair use).",
      },
      {
        key: "bing.authority_to_act",
        text: "I represent that the information in the notification is accurate and, under penalty of perjury, that I am authorized to act on behalf of the owner of an exclusive right that is allegedly infringed.",
      },
      {
        key: "bing.512f_acknowledgement",
        text: "As applicable under 17 U.S.C. 512(f), I acknowledge that I may be subject to liability for damages if I knowingly materially misrepresent that material or activity is infringing.",
      },
      {
        key: "bing.third_party_sharing",
        text: "I understand that the information submitted in this form may be shared with third parties or the public, including the alleged infringer about whom I am filing this complaint.",
      },
    ],
    sourceUrls: [
      "https://www.microsoft.com/en-us/legal/intellectualproperty/infringement",
      "https://www.bing.com/webmaster/contentremovalform/showcontentremovalform",
    ],
    formUrl:
      "https://www.bing.com/webmaster/contentremovalform/showcontentremovalform",
    accessedAt: "2026-11-04T00:00:00.000Z",
  },
  {
    recipient: "yandex",
    language: "en",
    major: 1,
    statements: [
      {
        key: "yandex.good_faith_belief",
        text: "By submitting this notice and signing with your digital signature below, you confirm that you have a good faith belief that the use of the material in the manner complained of is not authorized by the copyright owner, its agent, or the law.",
      },
      {
        key: "yandex.accuracy_perjury_authority",
        text: "You further confirm that the information in this notification is accurate and, under penalty of perjury, that you are authorized to act on behalf of the owner of an exclusive right that is allegedly infringed.",
      },
      {
        key: "yandex.data_processing_consent",
        text: "I hereby consent to the processing of the personal data provided above for the purpose of reviewing the application and getting feedback. I am aware of my right to withdraw the consent via address mentioned above.",
      },
    ],
    sourceUrls: [
      "https://yandex.ru/legal/copyright/en/",
      "https://yandex.ru/support/copyright-complaint/en/",
      "https://forms.yandex.com/surveys/1773/?lang=en&iframe=1",
    ],
    formUrl: "https://forms.yandex.com/surveys/1773/?lang=en&iframe=1",
    accessedAt: "2026-11-04T00:00:00.000Z",
  },
];

/** The canonical form of one statement text: NFC, trimmed, whitespace collapsed. */
export function canonicalText(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/g, " ");
}

/** The SHA-256 prefix over the ordered statement set. */
export function statementHash(statements: Statement[]): string {
  const canonical = JSON.stringify(
    statements.map((statement) => ({
      key: statement.key,
      text: canonicalText(statement.text),
    })),
  );
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 12);
}

export function templateVersion(template: StatementTemplate): string {
  return `${template.recipient}.${template.language}.v${template.major}@${statementHash(template.statements)}`;
}

/** Insert the checked-in revisions once; a later revision is a separate row. */
export async function ensureTemplates(
  db: Queryable,
  now: () => Date = () => new Date(),
): Promise<void> {
  for (const template of STATEMENT_TEMPLATES) {
    const id = templateVersion(template);
    const existing = (
      await db.query("SELECT id FROM notice_template WHERE id = $1", [id])
    ).rows[0];
    if (existing) {
      continue;
    }
    try {
      await db.query(
        `INSERT INTO notice_template
          (id, recipient, language, major, hash, statements, source_urls,
           accessed_at, verified_by, verified_at, supersedes, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8, NULL, $10)`,
        [
          id,
          template.recipient,
          template.language,
          template.major,
          statementHash(template.statements),
          JSON.stringify(template.statements),
          JSON.stringify(template.sourceUrls),
          new Date(template.accessedAt),
          SYSTEM_OPERATOR_ID,
          now(),
        ],
      );
    } catch (error) {
      if (!/duplicate key|notice_template_revision_key/i.test(String(error))) {
        throw error;
      }
    }
  }
}

export async function findTemplate(
  db: Queryable,
  recipient: string,
  language: string,
): Promise<Record<string, unknown> | undefined> {
  return (
    await db.query(
      `SELECT * FROM notice_template
        WHERE recipient = $1 AND language = $2
        ORDER BY major DESC LIMIT 1`,
      [recipient, language],
    )
  ).rows[0];
}
