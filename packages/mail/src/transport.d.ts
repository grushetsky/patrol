import type { Locale } from "@patrol/i18n";
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
export declare class MemoryMailTransport implements MailTransport {
    readonly messages: MailMessage[];
    send(message: MailMessage): Promise<void>;
    sentTo(to: string): MailMessage[];
    clear(): void;
}
/** Prints messages to the log; what dev and compose run without SMTP. */
export declare class ConsoleMailTransport implements MailTransport {
    send(message: MailMessage): Promise<void>;
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
export declare class SmtpMailTransport implements MailTransport {
    private readonly config;
    private readonly transporter;
    constructor(config: SmtpConfig, transporter?: SmtpTransporter);
    send(message: MailMessage): Promise<void>;
}
/**
 * Reads the SMTP configuration from the environment. A host selects the
 * relay; everything else is optional with the port defaulting to 587 and
 * implicit TLS on 465, except the from address, which a configured relay
 * must carry — an email without a deployment sender is a configuration
 * error, not a guess. Returns null when no host is set: the deployment
 * runs without SMTP and the console transport stands in.
 */
export declare function smtpConfigFromEnv(env: NodeJS.ProcessEnv): SmtpConfig | null;
/**
 * The transport the environment selects: SMTP when a relay is configured,
 * the console transport otherwise (development and compose). Tests inject
 * the memory recorder directly and never read the environment.
 */
export declare function mailTransportFromEnv(env: NodeJS.ProcessEnv): MailTransport;
