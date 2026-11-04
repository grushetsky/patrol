# Patrol HTTP contract

The HTTP surface is TypeSpec source in "_contract/tsp/http/_", compiled into the same OpenAPI 3.1 document and JSON Schema 2020-12 bundle as the domain. The domain lives in "_contract/tsp/_" and stays free of `@statusCode`, so a route model never leaks into a domain validator. This document records the conventions the contract fixes, the operations it exposes, and the emitter constraints a build effort must respect.

## Artifacts

| Artifact | Path | Contents |
| --- | --- | --- |
| OpenAPI 3.1 | "_contract/generated/openapi/Patrol.openapi.yaml_" | One service, 78 paths, 91 operations, domain and HTTP components under `Domain.*` and `Http.*`. |
| JSON Schema 2020-12 | "_contract/generated/json-schema/patrol_" | One bundle with every model, each definition under an absolute `$id` of `https://patrol.example/schemas/<Name>.json`. |
| Generated client types | "_contract/verify/src/generated/openapi.d.ts_" | `openapi-typescript` output over the OpenAPI document. |
| Verification workspace | "_contract/verify/_" | A TanStack Start stub, the generated client, the Node-side validator, and the end-to-end check. |

The API is mounted at `/api` behind the load balancer, so the browser client uses `baseUrl: "/api"` while the contract's paths are relative to that base.

## Conventions

### Authentication

One security scheme exists: `ApiKeyAuth`, a cookie named `__Host-patrol_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`. The session token is never a contract value; the API sets the cookie and validates the session row on every request. Authentication answers `401` for a missing, expired, or revoked session.

The sign-in flow is two-step: a correct password answers `202` with a `challengeId`, and the second factor answers `200` with the session cookie and the operator. A locked account answers `429` with code `account_locked`.

The bootstrap administrator consumes the token printed by `patrol bootstrap` at `POST /auth/setup`; an invited operator consumes the emailed token at `POST /invitations/{token}/acceptance`. Both answer `201` with an `enrollmentToken`, and the TOTP ceremony completes through `POST /auth/enrollment` and `POST /auth/enrollment/confirmation`. No operation returns a password hash, a TOTP secret, a session token, or a recovery-code hash; recovery codes are returned once, at enrolment.

### Language

The interface ships in English and Russian (`InterfaceLanguage`). An operator's choice is stored on the account (`Operator.preferredLanguage`) and set through `PATCH /auth/preferences`; before a choice exists, the request's `Accept-Language` decides and English is the fallback. The API localizes operator-facing `message` and `fieldErrors[].message` in the same order, while `code` stays stable, and tests fix English.

Recipient-facing content never translates. A notice's statements and resolved fields reproduce the recipient's form language, catalogue values keep their native strings, and the printable notice and upload file are in the recipient's language. The operator-facing checklist in a frozen pack is generated in the approving operator's language at approval and recorded on the submission as `packLanguage`; a later language change never rewrites the pack.

Emails use the recipient operator's stored preference; an invitation or setup email, sent before a preference exists, is English.

### CSRF

Every state-changing request carries an `X-Patrol-CSRF` header, and every such operation declares it as a required parameter. The token is issued by `GET /auth/csrf` (which also sets the paired cookie) and returned in the session payload. A browser client cannot call a mutation without it, including the anonymous sign-in and setup requests.

### Roles

Each operation carries an `x-patrol-roles` extension listing the roles allowed:

- `anonymous` — no session is required; the operation is part of setup, sign-in, health, or version reporting.
- `operator` — any signed-in operator.
- `administrator` — an administrator only; the role inherits every operator capability, so `administrator` alone is listed and never paired with `operator`.

The domain's capability table is the source: operators review candidates, manage the catalogue and allowlists, request scans, and compose, approve, and file notices; administrators additionally manage operators, invitations, the rights holder, signatory, recipient profiles, the budget, and legal-hold release.

### Errors

Every failure returns a JSON body with a stable `code`, a human `message`, and, when fields failed validation, `fieldErrors` with a JSON pointer per field. A rate-limited response also carries `retryAfterSeconds`. The status taxonomy is fixed:

| Status | Meaning | Body |
| --- | --- | --- |
| `400` | Malformed or schema-invalid request. | `ErrorBody` |
| `401` | Missing session, wrong credentials, wrong second factor, or an invalid setup token. | `ErrorBody` |
| `403` | The session's role does not grant the operation. | `ErrorBody` |
| `404` | The record does not exist. | `ErrorBody` |
| `409` | The request conflicts with the record's state or an existing record; the body adds the conflicting identifier or `currentState`. | `ConflictBody` |
| `410` | The artifact's bytes were purged; its record survives. | `ErrorBody` |
| `422` | The request is well formed but breaks a domain rule: an exhausted quota, a paused profile, an ineligible recipient, an over-cap batch, an allowlist hit, a missing note, or a wrong-work decision without its title. | `ErrorBody` |
| `429` | A locked account or a throttled address. | `ErrorBody` |
| `503` | The deployment is not bootstrapped, or the running image and the database schema disagree. | `ErrorBody` |

The codes are the enum `ErrorCode`; the UI branches on the code, never on the message. `503 setup_required` is declared on every domain operation because the API refuses to serve one until a rights holder and an administrator exist; `GET /system/setup` answers the state without a session.

The emitter names the body model after the spread source (`Http.ErrorBody`, `Http.ConflictBody`), not after the status wrapper. The status lives in the response, not in the body, and the generated client's error type is the body model.

### Paging

List operations take optional `page` and `pageSize` query parameters, default to the first page of fifty items, and cap the page size at two hundred. Every page response is a concrete model with `items`, `total`, `page`, and `pageSize`; no generic `Page<T>` is used, because a template does not reach the JSON Schema emitter and cannot be validated. The review queue's order is fixed by the design: score descending, then result rank ascending, then observation time descending.

### Idempotency and conflict handling

- A scan is unique on title group, engine, and due date. `POST /scans` returns the existing scan for the day rather than creating a second one, and answers `202` either way.
- A submission is unique per notice. `POST /submissions/{id}/retry` reuses the same row and raises `attemptCount`; no operation creates a second delivery.
- A manual candidate pair is unique on normalized URL and tracked title. `POST /candidates` returns the existing candidate (`200`) instead of creating a duplicate (`201`).
- A notice reserves its cited violations at draft creation. A second draft citing them answers `409 violation_reserved` with `conflictingViolationIds` and `existingNoticeId`.
- Lifecycle operations guard on the current state and answer `409 state_conflict` with `currentState` when the transition is illegal.
- The contract declares no `If-Match` or idempotency-key header: the design fixes no optimistic-concurrency mechanism, and the state guards above are the concurrency boundary. A build effort that needs one adds it as a new decision, not as an undocumented header.

### Read models

The contract returns domain records where the domain record is the answer, and adds HTTP read models where a screen needs a join:

- `CandidateReviewRow` joins a candidate with its title, matched variant, first observation, newest capture, allowlist hit, reputation, and prior decision, so the review queue is one request.
- `ViolationRow` and `ViolationDetail` join a violation with its title, newest capture, decision, and notice attachment.
- `NoticeCard`, `NoticeDetail`, and `SubmissionDetail` join a notice with its submission, pack availability, and derived `NoticeStatus`, because the UI renders one status while the model carries two lifecycles.
- `DashboardSummary` and the `TitleChartResponse` union are read models only.

These read models live in `Patrol.Http`, so the domain namespace remains validator-only.

### Notice lifecycle

A notice's `NoticeStatus` is derived: `draft`, `approved`, then the submission's `delivered`, `acknowledged`, `rejected`, or `failed`; `withdrawn` and `superseded` are terminal. Approval requires the three literal confirmations in `ApprovalAttestation` and freezes the content; no operation mutates an approved notice. The notice detail also exposes the statement template summary — identifier, source URLs, last verification, and a stale flag — and approval is refused when the template is older than ninety days, a newer revision exists, or no verified template exists for the recipient and language; the `currentStatements` attestation is the operator's re-read confirmation. Withdrawal is allowed for a draft, or for an approved notice whose submission is still pending. A supersession creates the replacement draft and cancels the pending submission in one operation.

### Evidence

A capture is fetched asynchronously. `POST /candidates/{id}/captures` and `POST /violations/{id}/captures` answer `202` with the queued reason; the evidence row appears in the candidate or violation detail once the worker has fetched the URL. `GET /evidence/{id}` returns the metadata and artifact manifest, and `GET /evidence/{id}/artifacts/{sha256}/download` returns a signed, content-pinned URL. Purged bytes answer `410 bytes_purged` while the record survives. No operation mutates a capture.

A host that objects to Patrol's capture — a cease-and-desist, a block notice, or an abuse complaint naming Patrol — is recorded as a `HostObjection`. Every capture of that host then answers `409 host_objection` with the objection's identifier until an operator clears it at `POST /host-objections/{id}/clearance`. The candidates affected at the time are listed with `GET /candidates?hostObjectionId=<id>`, and the objection is never deleted.

### Decisions this ticket fixed

The design documents left these shapes open; the contract settles them for the build effort:

- Paging is `page`/`pageSize` with concrete page models, not cursors.
- Errors carry a stable code enum and field pointers, not RFC 9457 problem details.
- Sign-in answers `202` with a challenge, then `200` with the session; enrolment is a two-step ceremony with a short-lived `enrollmentToken`.
- Approval attestations are literal `true` fields, so a client cannot submit a refusal that the server then has to interpret.
- The UI's notice status is a derived field on the read models, not a sixth lifecycle state.
- An allowlist entry is created in effect by the operator who adds it, with `confirmedBy`/`confirmedAt`; a decision's `proposedAllowlistEntryId` names the entry the decision creates, so there is no separate confirmation queue.
- Chart day boundaries are UTC, matching the ledger's months; the response reports `requestedGrouping`, `appliedGrouping`, and `groupingFallback` so the UI can show the fallback hint rather than an empty chart.
- The design's host objection had no domain record, so this ticket adds `HostObjection` to the domain and its read and clearance operations to HTTP; without it the "only an operator reopens a host" rule had nowhere to live.
- External identifiers can be added and removed on an existing title, because the design calls them facts that are corrected without re-keying.

## Operation inventory

The tables below are generated from the emitted document. `Role` lists the contract's `x-patrol-roles` values, and `Success` lists the 2xx statuses each operation declares.

### Authentication

| Method | Path | Operation | Role | Success |
| --- | --- | --- | --- | --- |
| GET | `/auth/csrf` | `Authentication_csrf` | anonymous | 200 |
| POST | `/auth/email` | `Sessions_changeEmail` | operator, administrator | 204 |
| POST | `/auth/enrollment` | `Authentication_beginEnrollment` | anonymous | 200 |
| POST | `/auth/enrollment/confirmation` | `Authentication_confirmEnrollment` | anonymous | 201 |
| POST | `/auth/password` | `Sessions_changePassword` | operator, administrator | 204 |
| PATCH | `/auth/preferences` | `Sessions_updatePreferences` | operator, administrator | 200 |
| POST | `/auth/second-factor` | `Authentication_secondFactor` | anonymous | 200 |
| DELETE | `/auth/session` | `Sessions_signOut` | operator, administrator | 204 |
| GET | `/auth/session` | `Sessions_read` | operator, administrator | 200 |
| GET | `/auth/sessions` | `Sessions_listSessions` | operator, administrator | 200 |
| DELETE | `/auth/sessions/{sessionId}` | `Sessions_revokeSession` | operator, administrator | 204 |
| POST | `/auth/setup` | `Authentication_setup` | anonymous | 201 |
| POST | `/auth/sign-in` | `Authentication_signIn` | anonymous | 202 |
| POST | `/auth/totp` | `Sessions_beginReenrollment` | operator, administrator | 200 |
| POST | `/auth/totp/confirmation` | `Sessions_confirmReenrollment` | operator, administrator | 200 |
| POST | `/invitations/{token}/acceptance` | `InvitationAcceptance_accept` | anonymous | 201 |

### Catalogue

| Method | Path | Operation | Role | Success |
| --- | --- | --- | --- | --- |
| GET | `/catalogue/suggestions` | `CatalogueSearch_search` | operator, administrator | 200 |
| GET | `/catalogue/wikidata-entities/{qid}` | `CatalogueSearch_readWikidataEntity` | operator, administrator | 200 |
| GET | `/catalogue/wikidata-suggestions` | `CatalogueSearch_searchWikidata` | operator, administrator | 200 |
| GET | `/title-groups` | `TitleGroups_list` | operator, administrator | 200 |
| POST | `/title-groups` | `TitleGroups_create` | operator, administrator | 201 |
| GET | `/title-groups/{titleGroupId}` | `TitleGroups_read` | operator, administrator | 200 |
| PATCH | `/title-groups/{titleGroupId}` | `TitleGroups_update` | operator, administrator | 200 |
| GET | `/titles` | `Titles_list` | operator, administrator | 200 |
| POST | `/titles` | `Titles_create` | operator, administrator | 201 |
| GET | `/titles/{trackedTitleId}` | `Titles_read` | operator, administrator | 200 |
| PATCH | `/titles/{trackedTitleId}` | `Titles_update` | operator, administrator | 200 |
| POST | `/titles/{trackedTitleId}/external-identifiers` | `Titles_addExternalIdentifier` | operator, administrator | 201 |
| DELETE | `/titles/{trackedTitleId}/external-identifiers/{externalIdentifierId}` | `Titles_removeExternalIdentifier` | operator, administrator | 204 |
| POST | `/titles/{trackedTitleId}/merge` | `Titles_merge` | operator, administrator | 200 |
| POST | `/titles/{trackedTitleId}/variants` | `Titles_addVariant` | operator, administrator | 201 |

### Dashboard

| Method | Path | Operation | Role | Success |
| --- | --- | --- | --- | --- |
| GET | `/dashboard/summary` | `Dashboard_summary` | operator, administrator | 200 |
| GET | `/dashboard/title-chart` | `Dashboard_titleChart` | operator, administrator | 200 |

### Evidence

| Method | Path | Operation | Role | Success |
| --- | --- | --- | --- | --- |
| GET | `/evidence/{evidenceId}` | `EvidenceAccess_read` | operator, administrator | 200 |
| GET | `/evidence/{evidenceId}/artifacts/{sha256}/download` | `EvidenceAccess_download` | operator, administrator | 200 |
| GET | `/host-objections` | `HostObjections_list` | operator, administrator | 200 |
| POST | `/host-objections/{hostObjectionId}/clearance` | `HostObjections_clear` | operator, administrator | 200 |
| GET | `/legal-holds` | `LegalHolds_list` | operator, administrator | 200 |
| POST | `/legal-holds` | `LegalHolds_create` | operator, administrator | 201 |
| POST | `/legal-holds/{legalHoldId}/release` | `LegalHolds_release` | administrator | 200 |

### Notices

| Method | Path | Operation | Role | Success |
| --- | --- | --- | --- | --- |
| GET | `/notices` | `Notices_list` | operator, administrator | 200 |
| POST | `/notices` | `Notices_create` | operator, administrator | 201 |
| GET | `/notices/{noticeId}` | `Notices_read` | operator, administrator | 200 |
| POST | `/notices/{noticeId}/approval` | `Notices_approve` | operator, administrator | 200 |
| GET | `/notices/{noticeId}/pack` | `Notices_pack` | operator, administrator | 200 |
| POST | `/notices/{noticeId}/supersession` | `Notices_supersede` | operator, administrator | 200 |
| POST | `/notices/{noticeId}/withdrawal` | `Notices_withdraw` | operator, administrator | 200 |
| GET | `/submissions` | `Submissions_list` | operator, administrator | 200 |
| GET | `/submissions/{submissionId}` | `Submissions_read` | operator, administrator | 200 |
| POST | `/submissions/{submissionId}/acknowledgement` | `Submissions_acknowledge` | operator, administrator | 200 |
| POST | `/submissions/{submissionId}/delivery` | `Submissions_deliver` | operator, administrator | 200 |
| POST | `/submissions/{submissionId}/failure` | `Submissions_fail` | operator, administrator | 200 |
| POST | `/submissions/{submissionId}/retry` | `Submissions_retry` | operator, administrator | 200 |

### Operators

| Method | Path | Operation | Role | Success |
| --- | --- | --- | --- | --- |
| GET | `/invitations` | `Invitations_list` | administrator | 200 |
| POST | `/invitations` | `Invitations_create` | administrator | 201 |
| DELETE | `/invitations/{invitationId}` | `Invitations_revoke` | administrator | 204 |
| GET | `/operators` | `Operators_list` | administrator | 200 |
| PATCH | `/operators/{operatorId}` | `Operators_update` | administrator | 200 |
| POST | `/operators/{operatorId}/credential-reset` | `Operators_resetCredentials` | administrator | 202 |
| GET | `/operators/{operatorId}/sessions` | `Operators_listSessions` | administrator | 200 |
| DELETE | `/operators/{operatorId}/sessions/{sessionId}` | `Operators_revokeSession` | administrator | 204 |
| GET | `/security-events` | `SecurityEvents_list` | administrator | 200 |

### Review

| Method | Path | Operation | Role | Success |
| --- | --- | --- | --- | --- |
| GET | `/candidates` | `Candidates_list` | operator, administrator | 200 |
| POST | `/candidates` | `Candidates_create` | operator, administrator | 200, 201 |
| GET | `/candidates/{candidateId}` | `Candidates_read` | operator, administrator | 200 |
| POST | `/candidates/{candidateId}/captures` | `Candidates_capture` | operator, administrator | 202 |
| POST | `/candidates/{candidateId}/reopen` | `Candidates_reopen` | operator, administrator | 200 |
| POST | `/candidates/{candidateId}/review-decisions` | `Candidates_decide` | operator, administrator | 201 |

### Scans

| Method | Path | Operation | Role | Success |
| --- | --- | --- | --- | --- |
| GET | `/rechecks` | `Rechecks_list` | operator, administrator | 200 |
| GET | `/scans` | `Scans_list` | operator, administrator | 200 |
| POST | `/scans` | `Scans_request` | operator, administrator | 202 |
| GET | `/scans/{scanId}` | `Scans_read` | operator, administrator | 200 |
| GET | `/scans/{scanId}/results` | `Scans_results` | operator, administrator | 200 |

### Settings

| Method | Path | Operation | Role | Success |
| --- | --- | --- | --- | --- |
| GET | `/settings/allowlist` | `AllowlistEntries_list` | operator, administrator | 200 |
| POST | `/settings/allowlist` | `AllowlistEntries_create` | operator, administrator | 201 |
| DELETE | `/settings/allowlist/{allowlistEntryId}` | `AllowlistEntries_remove` | operator, administrator | 204 |
| GET | `/settings/budget` | `Settings_readBudget` | operator, administrator | 200 |
| PUT | `/settings/budget` | `SettingsAdministration_updateBudget` | administrator | 200 |
| GET | `/settings/budget/capacity` | `Settings_readCapacity` | operator, administrator | 200 |
| GET | `/settings/recipient-profiles` | `Settings_listRecipientProfiles` | operator, administrator | 200 |
| PATCH | `/settings/recipient-profiles/{recipientProfileId}` | `SettingsAdministration_updateRecipientProfile` | administrator | 200 |
| POST | `/settings/recipient-profiles/{recipientProfileId}/clearance` | `SettingsAdministration_clearProfilePause` | administrator | 200 |
| GET | `/settings/rights-holder` | `Settings_readRightsHolder` | operator, administrator | 200 |
| PATCH | `/settings/rights-holder` | `SettingsAdministration_updateRightsHolder` | administrator | 200 |

### System

| Method | Path | Operation | Role | Success |
| --- | --- | --- | --- | --- |
| GET | `/health` | `Health_read` | anonymous | 200 |
| GET | `/system/setup` | `System_setup` | anonymous | 200 |
| GET | `/system/version` | `System_version` | anonymous | 200 |

### Violations

| Method | Path | Operation | Role | Success |
| --- | --- | --- | --- | --- |
| GET | `/violations` | `Violations_list` | operator, administrator | 200 |
| GET | `/violations/{violationId}` | `Violations_read` | operator, administrator | 200 |
| POST | `/violations/{violationId}/captures` | `Violations_capture` | operator, administrator | 202 |
| POST | `/violations/{violationId}/closure` | `Violations_close` | operator, administrator | 200 |

## Emitter constraints

Observed on TypeSpec 1.17.0; a build effort that upgrades emitters must re-run the verification before relying on these.

- A single service may hold several namespaces. The service and its `@info` and `@jsonSchema` live on `Patrol`, with models in `Patrol.Domain` and routes in `Patrol.Http`; the emitter then writes one document named from `{service-name}`. Two `@service` namespaces would write two documents and fully qualify cross-service references.
- Component names are prefixed (`Domain.TrackedTitle`, `Http.ReviewDecisionRequest`); a client generator that assumes bare names breaks.
- Plain unions of models each carrying a literal discriminator emit as `anyOf` with no OpenAPI `discriminator` metadata. Clients must narrow on the literal property; `@discriminated` is not used, because the JSON Schema emitter ignores it.
- A union alias of error models flattens into one response per status, which is how `ReadErrors`, `MutationErrors`, and `ResourceErrors` keep the operation signatures short.
- Spreading a model into operation parameters emits a reusable OpenAPI parameter component; this is how the CSRF header and paging parameters stay identical across operations.
- A response model with `@statusCode` and `@body` emits the status and body; a `@header("Set-Cookie")` property emits a response header and stays out of the body.
- Boolean literals (`true`) emit as `type: boolean, enum: [true]`; Ajv rejects `false`, and the generated TypeScript type is `true`.
- Numeric enums emit as integer enums; `ChartWindow` types as `7 | 14 | 30`.
- The JSON Schema emitter emits parameter models (`CsrfToken`, `PageRequest`) alongside bodies. They are harmless to a validator, which looks definitions up by `$id`.
- `plainDate` and `plainTime` emit as strings with `format: date` and `format: time`.
- No generic wrappers reach the JSON Schema emitter, so every page and wrapper is a concrete model.
- No property defaults are declared; the server owns every default, and Ajv never mutates input.

## Verification

"_contract/verify/_" proves both directions of the contract:

```bash
cd contract
npm run check          # compile, then 46 schema checks over domain and HTTP payloads
npm run verify         # generate client types, build the TanStack Start stub, typecheck, then run the stub end to end
```

The workspace contains:

- "_verify/src/api/client.ts_" — `openapi-fetch` over the generated `paths` type.
- "_verify/src/api/queries.ts_" — `queryOptions` for the review queue and the typed decision mutation, including the required CSRF header.
- "_verify/src/routes/index.tsx_" — a TanStack Start route whose loader awaits the query cache.
- "_verify/src/server/validators.ts_" — Ajv 2020 plus `ajv-formats`, registering every `$defs` entry under its own `$id`.
- "_verify/src/server/stub.ts_" — a Node HTTP stub of `POST /candidates/{candidateId}/review-decisions` that validates the request before use and validates the response before sending.
- "_verify/scripts/e2e.ts_" — sends a valid request and an invalid one through the generated client, and checks that the Node-side validator rejects a malformed response.

The recorded results are: the generated client compiles under TanStack Start 1.169.4 and `tsc --noEmit` passes; the stub answers `201` for a valid decision and `400 validation_failed` for an invalid one; the validator rejects the malformed response the check feeds it. Vite builds both the client and the SSR bundle.

## Open constraints for the build effort

- Optimistic concurrency is not specified; the state guards and the unique constraints are the only boundary. Adding `If-Match` is a new decision.
- The security-event read surface is the administrator-only `GET /security-events`, filtered by event kind and operator.
- The staging environment's disabled delivery is deployment configuration, not a contract field; delivery is an operator action in every environment.
- Provider prices, the Google per-file cap discovered at runtime, and the per-day quota remain settings the profile records; none is hard-coded in the contract.
