import { describe, expect, it } from "vitest";
import {
  ConsoleMailTransport,
  MemoryMailTransport,
  SmtpMailTransport,
  mailTransportFromEnv,
  smtpConfigFromEnv,
  type SentMessage,
  type SmtpTransporter,
} from "../src/transport.js";

/**
 * The transport implementations (docs/design/operator-authentication.md
 * "Credentials": email is a delivery channel, not an authentication
 * factor): the memory recorder tests ride on, the console transport
 * development runs on, and the SMTP relay production sends through. The
 * SMTP path is tested against an injected transporter so no test ever
 * touches a network; the factory reads the environment the deployment
 * sets (PATROL_SMTP_HOST/PORT/USER/PASS/FROM).
 */

/** A transporter that records what nodemailer would send. */
class RecordingTransporter implements SmtpTransporter {
  readonly sent: SentMessage[] = [];

  async sendMail(message: SentMessage): Promise<unknown> {
    this.sent.push(message);
    return { messageId: "recorded" };
  }
}

describe("the memory transport", () => {
  it("records messages and filters them by recipient", () => {
    const mail = new MemoryMailTransport();
    void mail.send({
      to: "a@example.test",
      subject: "s",
      body: "b",
      locale: "en",
    });
    void mail.send({
      to: "b@example.test",
      subject: "s2",
      body: "b2",
      locale: "ru",
    });
    expect(mail.messages).toHaveLength(2);
    expect(mail.sentTo("b@example.test")).toHaveLength(1);
    mail.clear();
    expect(mail.messages).toHaveLength(0);
  });
});

describe("the SMTP transport", () => {
  it("sends through the injected transporter with the configured from", async () => {
    const transporter = new RecordingTransporter();
    const transport = new SmtpMailTransport(
      { host: "smtp.example.test", port: 587, from: "patrol@example.test" },
      transporter,
    );
    await transport.send({
      to: "ops@example.test",
      subject: "subject line",
      body: "body text",
      locale: "en",
    });
    expect(transporter.sent).toEqual([
      {
        from: "patrol@example.test",
        to: "ops@example.test",
        subject: "subject line",
        text: "body text",
      },
    ]);
  });
});

describe("the environment factory", () => {
  it("requires the from address when a host is configured", () => {
    expect(() =>
      smtpConfigFromEnv({ PATROL_SMTP_HOST: "smtp.example.test", PATROL_SMTP_PORT: "587" }),
    ).toThrow(/PATROL_SMTP_FROM/i);
  });

  it("reads host, port, credentials, and TLS from the environment", () => {
    expect(
      smtpConfigFromEnv({
        PATROL_SMTP_HOST: "smtp.example.test",
        PATROL_SMTP_PORT: "465",
        PATROL_SMTP_USER: "patrol",
        PATROL_SMTP_PASS: "secret",
        PATROL_SMTP_FROM: "patrol@example.test",
      }),
    ).toEqual({
      host: "smtp.example.test",
      port: 465,
      user: "patrol",
      pass: "secret",
      from: "patrol@example.test",
      secure: true,
    });
  });

  it("returns null without a host: no SMTP is configured", () => {
    expect(smtpConfigFromEnv({ PATROL_SMTP_FROM: "patrol@example.test" })).toBeNull();
  });

  it("falls back to the console transport outside a configured relay", () => {
    expect(mailTransportFromEnv({})).toBeInstanceOf(ConsoleMailTransport);
    const built = mailTransportFromEnv({
      PATROL_SMTP_HOST: "smtp.example.test",
      PATROL_SMTP_FROM: "patrol@example.test",
    });
    expect(built).toBeInstanceOf(SmtpMailTransport);
  });
});
