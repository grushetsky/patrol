# Operators sign in with local credentials, a mandatory TOTP, and server-side sessions

Patrol has no public signup, a handful of operators, and one tenant, so accounts live in its own PostgreSQL: email and Argon2id password, mandatory TOTP enrolled before the first session, ten single-use recovery codes, and sessions stored as rows keyed by the SHA-256 of a random token. The cookie is `__Host`-prefixed, `HttpOnly`, `Secure`, and `SameSite=Lax`, with an eight-hour idle timeout, a seven-day absolute lifetime, and revocation on every credential, role, or email change.

## Considered options

- **External identity provider.** Offloads password storage and offers SSO, and it adds a vendor, an integration, and a lifecycle the rights holder may not control, for an account set that fits in one table.
- **Passkeys only.** Best phishing resistance, and no recovery path on a fresh device without a second factor, which is why recovery codes and a password still exist.
- **Magic links only.** No shared secret, but one factor — email — guarding the account that files sworn notices.
- **Self-contained signed cookies.** No session table, but revocation becomes "wait for expiry" or a denylist that is a session table with extra steps.
- **Longer sessions.** Fewer sign-ins, and a stolen cookie on a tool that publishes notices under a perjury statement outlives the incident.

## Consequences

- Disabling an operator, changing a password, re-enrolling TOTP, or changing a role ends the affected sessions immediately, which is the operation incident response actually needs.
- The session table and the login throttles add two writes to the authentication path; both are trivial at a few operators.
- There is no default account and no seeded password: the first administrator is created by `patrol bootstrap` on the host, and every later account by a single-use invitation.
- Losing both the authenticator and the recovery codes requires another administrator or the host-level recovery command, which is the same access that could edit the database directly.
- Passkeys can be added later as a second credential type on the same account, so this decision does not preclude the better factor.
