import type { Locale } from "@patrol/i18n";

/**
 * The outbound mail port. Slice 1 ships an in-memory recorder for tests and
 * a console transport for development and compose; slice 9 replaces the
 * console implementation with the deployment's SMTP relay behind this same
 * interface (Authentication "Credentials": email is a delivery channel, not
 * an authentication factor).
 */
export interface MailMessage {
  to: string;
  subject: string;
  body: string;
  /** The catalogue the message rendered in, for tests. */
  locale: Locale;
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

/** Records every message in memory; the test seam inspects the array. */
export class MemoryMailTransport implements MailTransport {
  readonly messages: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.messages.push({ ...message });
  }

  sentTo(to: string): MailMessage[] {
    return this.messages.filter((message) => message.to === to);
  }

  clear(): void {
    this.messages.length = 0;
  }
}

/** Prints messages to the log; what compose and staging run until SMTP lands. */
export class ConsoleMailTransport implements MailTransport {
  async send(message: MailMessage): Promise<void> {
    process.stdout.write(
      `[mail] to=${message.to} locale=${message.locale} subject=${message.subject}\n${message.body}\n`,
    );
  }
}
