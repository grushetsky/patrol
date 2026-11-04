import { t, type Locale } from "@patrol/i18n";
import type { AppConfig } from "../config.js";
import type { MailTransport } from "./transport.js";

/**
 * The operator-facing emails slice 1 sends: invitations, the bootstrap setup
 * link, and credential resets (implementation-rules "Pre-preference email"):
 * an email addressed before the account holds a preference renders in
 * English; once a preference exists it wins.
 */

const EN: Locale = "en";

/** Where a single-use token lands: the web's acceptance route. */
export function inviteLink(config: AppConfig, token: string): string {
  return `${config.publicUrl.replace(/\/$/, "")}/auth/enrollment?token=${encodeURIComponent(token)}`;
}

/** Fills a `{placeholder}` catalogue template. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? values[key] : match,
  );
}

export interface InvitationEmailInput {
  to: string;
  /** The operator's stored preference, when the account already has one. */
  locale?: Locale | null;
  /** Where the single-use token lands. */
  link: string;
  /** The rights holder's legal name, when the deployment has recorded it. */
  rightsHolderName?: string | null;
}

/** Sends the invitation email (also the bootstrap setup email). */
export async function sendInvitationEmail(
  transport: MailTransport,
  input: InvitationEmailInput,
): Promise<void> {
  const locale = input.locale ?? EN;
  await transport.send({
    to: input.to,
    locale,
    subject: t(locale, "mail.invitation.subject"),
    body: fill(t(locale, "mail.invitation.body"), {
      rightsHolder: input.rightsHolderName ?? "the rights holder",
      link: input.link,
    }),
  });
}

export interface ResetEmailInput {
  to: string;
  locale?: Locale | null;
  link: string;
  rightsHolderName?: string | null;
}

/** Sends the credential-reset email an administrator's reset triggers. */
export async function sendResetEmail(
  transport: MailTransport,
  input: ResetEmailInput,
): Promise<void> {
  const locale = input.locale ?? EN;
  await transport.send({
    to: input.to,
    locale,
    subject: t(locale, "mail.reset.subject"),
    body: fill(t(locale, "mail.reset.body"), {
      rightsHolder: input.rightsHolderName ?? "the rights holder",
      link: input.link,
    }),
  });
}
