import type { Locale } from "@patrol/i18n";
import nodemailer from "nodemailer";

/**
 * The outbound mail port, shared by the API (invitations, resets) and the
 * worker (the operator-mailbox alerts). Email is a delivery channel, not an
 * authentication factor (docs/design/operator-authentication.md
 * "Credentials"): nothing security-relevant is decided by what lands in a
 * mailbox. Three implementations stand behind the one interface — the
 * memory recorder tests inspect, the console transport development and
 * compose run on, and the SMTP relay a deployment configures
 * (PATROL_SMTP_HOST/PORT/USER/PASS/FROM).
 */

/** One outbound message: envelope, subject, body, and the rendered locale. */
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

/** Prints messages to the log; what dev and compose run without SMTP. */
export class ConsoleMailTransport implements MailTransport {
  async send(message: MailMessage): Promise<void> {
    process.stdout.write(
      `[mail] to=${message.to} locale=${message.locale} subject=${message.subject}\n${message.body}\n`,
    );
  }
}

/** What nodemailer sends for one message; injectable so tests never touch a network. */
export interface SentMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

/** The slice of nodemailer's transporter the SMTP implementation calls. */
export interface SmtpTransporter {
  sendMail(message: SentMessage): Promise<unknown>;
}

/** A deployment's SMTP relay, as the environment configures it. */
export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  /** The envelope sender every message carries. */
  from: string;
  /** Implicit TLS (port 465); the default is the STARTTLS upgrade on 587. */
  secure?: boolean;
}

/**
 * Sends through the deployment's SMTP relay. The transporter is created
 * lazily from the config on first send (and may be injected, which is how
 * the tests observe it); a send failure propagates to the caller, whose
 * own policy decides what a failed delivery means — the alert emails log
 * and move on, because their durable half is the database row.
 */
export class SmtpMailTransport implements MailTransport {
  private readonly config: SmtpConfig;
  private readonly transporter: SmtpTransporter;

  constructor(config: SmtpConfig, transporter?: SmtpTransporter) {
    this.config = config;
    this.transporter = transporter ?? createNodemailerTransporter(config);
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.config.from,
      to: message.to,
      subject: message.subject,
      text: message.body,
    });
  }
}

/** Builds the real nodemailer transporter; called lazily on the first send. */
function createNodemailerTransporter(config: SmtpConfig): SmtpTransporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure ?? false,
    ...(config.user === undefined
      ? {}
      : { auth: { user: config.user, pass: config.pass ?? "" } }),
  });
}

/**
 * Reads the SMTP configuration from the environment. A host selects the
 * relay; everything else is optional with the port defaulting to 587 and
 * implicit TLS on 465, except the from address, which a configured relay
 * must carry — an email without a deployment sender is a configuration
 * error, not a guess. Returns null when no host is set: the deployment
 * runs without SMTP and the console transport stands in.
 */
export function smtpConfigFromEnv(env: NodeJS.ProcessEnv): SmtpConfig | null {
  const host = env.PATROL_SMTP_HOST;
  if (host === undefined || host === "") {
    return null;
  }
  const from = env.PATROL_SMTP_FROM;
  if (from === undefined || from === "") {
    throw new Error(
      "PATROL_SMTP_FROM is required when PATROL_SMTP_HOST is set: every outbound message needs the deployment's sender address",
    );
  }
  const port = env.PATROL_SMTP_PORT === undefined ? 587 : Number.parseInt(env.PATROL_SMTP_PORT, 10);
  if (!Number.isInteger(port) || port < 1) {
    throw new Error(`PATROL_SMTP_PORT must be a positive integer, got ${env.PATROL_SMTP_PORT}`);
  }
  return {
    host,
    port,
    ...(env.PATROL_SMTP_USER === undefined || env.PATROL_SMTP_USER === ""
      ? {}
      : {
          user: env.PATROL_SMTP_USER,
          ...(env.PATROL_SMTP_PASS === undefined || env.PATROL_SMTP_PASS === ""
            ? {}
            : { pass: env.PATROL_SMTP_PASS }),
        }),
    from,
    secure: env.PATROL_SMTP_SECURE === "1" || port === 465,
  };
}

/**
 * The transport the environment selects: SMTP when a relay is configured,
 * the console transport otherwise (development and compose). Tests inject
 * the memory recorder directly and never read the environment.
 */
export function mailTransportFromEnv(env: NodeJS.ProcessEnv): MailTransport {
  const smtp = smtpConfigFromEnv(env);
  return smtp === null ? new ConsoleMailTransport() : new SmtpMailTransport(smtp);
}
