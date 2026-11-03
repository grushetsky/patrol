# Operator authentication and roles

Patrol has a handful of operators, one rights holder, and no public signup, so authentication is local to the deployment: an email address and password hashed with Argon2id, a mandatory TOTP second factor, and server-side sessions held in PostgreSQL. Two roles exist — `Administrator` and `Operator` — and the signatory is a profile the rights holder configures, not an account. The first administrator and the rights holder are created by a one-time CLI bootstrap on the host, and every later account arrives through an administrator's single-use invitation. This document fixes the identity source, the session mechanism, the credential and recovery policy, the role set, and the bootstrap path; the terms are those of "_GLOSSARY.md_", the mechanism is "_docs/adr/0025-local-credentials-with-totp.md_", the role set is "_docs/adr/0026-two-roles-and-signatory-is-a-profile.md_", and the model follows "_docs/adr/0005-single-postgres-for-jobs.md_" and "_docs/adr/0007-separate-api-and-contract-package.md_".

## Identity source

Local credentials, because the alternative is a second party that can lock the rights holder out of its own enforcement tool:

| Choice | Why not |
| --- | --- |
| External identity provider (Google Workspace, Entra, Auth0) | Adds a vendor, an integration, and an account lifecycle for a handful of people, and couples access to a directory the rights holder may not own |
| Passkeys only | Strongest phishing resistance, but no portable recovery path on a fresh device without a second factor of its own, and it excludes the one-person deployments where the signatory is not technical |
| Magic links only | No shared secret to steal, but email is the only factor, and the account that files sworn notices deserves a second |
| Local credentials with a mandatory TOTP | Two independent factors, no vendor, and everything lives in the deployment's own database |

Passkeys are a compatible later addition — a second credential type on the same account — and are not built in v1.

## Credentials

| Control | Rule |
| --- | --- |
| Password | At least 12 characters, checked against a bundled breached-password list, no composition rules, no forced rotation |
| Hashing | Argon2id, 64 MiB memory, three iterations, one lane, per-user salt, rehashed on login when parameters change |
| Second factor | TOTP, SHA-1 at six digits with a 30-second step and one step of drift, enrolled before the first session is usable |
| Recovery codes | Ten single-use codes issued at enrollment, stored only as hashes, each shown once |
| Login rate | Ten failures per account trigger a 15-minute lock; per-IP attempts are throttled separately, and both are audited |
| Email | A deployment-configured SMTP relay sends invitations, resets, and operator alerts; it is not the authentication factor |

The account's email address is its identifier and is unique. Changing it requires the current password and a fresh TOTP code, and revokes every other session.

## Sessions

Sessions are rows in PostgreSQL, not self-contained tokens, because revocation is the operation Patrol actually needs: disabling an operator, changing a password, or re-enrolling a second factor must end access immediately.

| Property | Value |
| --- | --- |
| Token | 256 random bits, stored only as a SHA-256 hash |
| Cookie | `__Host-patrol_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/` |
| Idle timeout | 8 hours |
| Absolute lifetime | 7 days |
| Rotation | A new token is issued at login and on re-authentication; the old row is deleted |
| Revocation | Logout, password change, TOTP re-enrollment, email change, role change, and an administrator's disable all delete the affected rows |
| CSRF | `SameSite=Lax` plus a double-submit token on every state-changing request |
| Visibility | An operator lists and revokes their own sessions; an administrator lists any operator's |

The API validates the cookie on every request against the session table, so a cookie stolen from a backup or a log is useless without the row. The session row carries the operator id, the creation and last-seen times, the user agent, and a coarse IP, which is what the operator sees in the session list.

## Roles

Two roles, with the administrator inheriting everything an operator can do:

| Capability | Operator | Administrator |
| --- | --- | --- |
| Review candidates and record review decisions | Yes | Yes |
| Create, approve, withdraw, and supersede notices; record submissions | Yes | Yes |
| Edit the catalogue, title groups, locales, and allowlists | Yes | Yes |
| Create manual scans and re-checks | Yes | Yes |
| Manage operators, invitations, and roles | No | Yes |
| Edit the rights holder, signatory, and recipient profiles | No | Yes |
| Set the acquisition budget and per-engine allowances | No | Yes |
| Release a legal hold | No | Yes |
| Clear a recipient profile paused by the rejection threshold | No | Yes |

The set is deliberately small. There is no separate reviewer or submitter role, because every operator can review and every notice approval is already recorded against a named operator, and there is no rights-holder account, because the rights holder is a legal person rather than a login. Approving a notice needs no elevated role; the first five notices a recipient profile produces are approved by a second operator where two exist, which is an operational control rather than a permission.

The **signatory** is a profile: a natural person's full legal name and authority basis, stored in the rights holder's settings and snapshotted into each notice at approval. It holds no credentials and cannot log in. Making it an actor would either duplicate the operator set or force the one signatory to be online for every notice, and "_docs/adr/0021-signatory-attests-and-operator-files.md_" already separates attestation from filing.

## Bootstrap and invitation

There is no public signup, no seeded password, and no default administrator:

1. **First boot.** The API refuses to serve domain endpoints until the deployment has a rights holder and at least one administrator, and answers with the setup state instead.
2. **CLI bootstrap.** An operator with host access runs `patrol bootstrap` in the API container. It reads the rights holder's legal name and country and the first administrator's email from arguments or environment, prints a one-time setup token to the container's logs, and writes the rights-holder row and an invited administrator. The command is idempotent and refuses once a rights holder exists.
3. **First login.** The invited administrator opens the printed link, sets a password, enrolls TOTP, stores the recovery codes, and completes the signatory and contact profile.
4. **Later operators.** An administrator invites by email; the invitation is a single-use token, valid 24 hours, stored only as a hash, and consumed by password and TOTP enrollment. An invitation can be revoked before it is used.
5. **Recovery.** An administrator resets a locked-out operator's password and second factor, which forces re-enrollment and revokes sessions. If the last administrator is locked out, `patrol admin recover` on the host mints a one-time reset token; it requires container shell access, which is the same authority that could edit the database directly.

Bootstrap is a host operation rather than a web page because the first account cannot be authorized by an account that does not exist. The token in the logs is the only secret it emits, and it single-uses.

## Audit

Authentication is audited as security events, separate from the domain audit trail:

- Sign-in success and failure, with the account, the coarse IP, and the user agent.
- Invitation creation, revocation, and acceptance.
- Password, TOTP, email, and role changes.
- Session revocation, including an administrator disabling an operator.
- Lockout and recovery-code use.

Events are append-only and retained with the deployment's log retention; they never include a password, a TOTP secret, a session token, or a recovery code. The same events feed the operator's own session list and the administrator's operator list.

## What this implies for the model

The model carries an `Operator` with its email, role, credential, TOTP enrollment, and invitation state; a `Session` row with its hash, timestamps, and revocation; and the `Signatory` as a value on the rights holder rather than an actor. The HTTP contract exposes sign-in, TOTP verification, enrollment, invitation, reset, session listing and revocation, and operator administration; it exposes no endpoint that returns a credential, a TOTP secret, or another operator's session token. The TypeSpec model that follows from this lives in the ticket "TypeSpec domain model".

## Open risks

- A TOTP-only second factor is phishable in real time; passkeys are the eventual answer, and the account model already admits a second credential type.
- The bootstrap token appears in container logs, which the hosting platform retains; it is single-use but should be treated as a secret until consumed.
- Email is required for invitations, resets, and alerts, so the deployment depends on an SMTP relay it does not otherwise need.
- An administrator can disable the only other administrator and lock the deployment into a CLI recovery, which is deliberate but easy to do by accident.
- Recovery codes are shown once; an operator who loses both the authenticator and the codes depends on another administrator or the host-level recovery path.

## Sources

- "_GLOSSARY.md_" for `Operator`, `Signatory`, and `RightsHolder`.
- "_docs/adr/0021-signatory-attests-and-operator-files.md_" for the attestation and filing split.
- "_docs/design/notice-composition.md_" for the first-five second-operator check and the profile pause an administrator clears.
- "_docs/adr/0005-single-postgres-for-jobs.md_" and "_docs/adr/0007-separate-api-and-contract-package.md_" for the Fastify API, PostgreSQL, and the shared contract package.
