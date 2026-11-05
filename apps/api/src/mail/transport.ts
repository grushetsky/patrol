/**
 * The outbound mail port moved to `@patrol/mail` in slice 9 so the worker
 * sends the operator-mailbox alert emails through the same interface the
 * API sends invitations and resets through. This module re-exports it:
 * the API's own imports (and the tests' recorder) keep their paths, and
 * the two processes cannot drift onto different ports. Slice 1 shipped an
 * in-memory recorder for tests and a console transport for development;
 * slice 9 added the SMTP relay behind the same interface
 * (PATROL_SMTP_HOST/PORT/USER/PASS/FROM; Authentication "Credentials":
 * email is a delivery channel, not an authentication factor).
 */
export type { MailMessage, MailTransport } from "@patrol/mail";
export { ConsoleMailTransport, MemoryMailTransport } from "@patrol/mail";
