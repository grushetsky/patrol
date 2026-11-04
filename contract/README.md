# Patrol contract

TypeSpec is the single source for Patrol's domain and HTTP contracts. One service spans two namespaces: `Patrol.Domain` holds the entities, value types, enums, and the five lifecycle state machines that JSON Schema validates; `Patrol.Http` holds the routes, request and response models, and the read models a screen needs. The split keeps `@statusCode` out of the domain validators while one OpenAPI document describes the whole API.

## Layout

- "_contract/tsp/main.tsp_" is the entry point and the only file that carries the service, version, and JSON Schema base URI.
- "_contract/tsp/ids.tsp_" holds the branded identifier scalars, all UUIDv7.
- "_contract/tsp/enums.tsp_" holds every domain enum, with explicit string values.
- "_contract/tsp/value-types.tsp_" holds shared scalars and value models: URLs, hosts, digests, country codes, locales, the capture profile, and redirect hops.
- "_contract/tsp/catalogue.tsp_" holds the rights holder, its signatory profile, title groups, tracked titles, variants, external identifiers, allowlists, and the acquisition budget.
- "_contract/tsp/discovery.tsp_" holds scans, query plans, search queries, search results, candidates, score components, and review decisions.
- "_contract/tsp/violations.tsp_" holds violations, the violation-evidence citations, evidence records, artifacts, host objections, and legal holds.
- "_contract/tsp/notices.tsp_" holds recipient profiles, notices, snapshots, submissions, acknowledgements, and failures.
- "_contract/tsp/operators.tsp_" holds operators, invitations, and sessions.
- "_contract/tsp/budget.tsp_" holds the quota ledger, budget reservations, and re-check ladders.
- "_contract/tsp/http/models.tsp_" holds the shared HTTP vocabulary: the session scheme, the CSRF header, paging, the error taxonomy, and the read-model fragments several resources reuse.
- "_contract/tsp/http/system.tsp_" holds health, version, and setup state.
- "_contract/tsp/http/auth.tsp_" holds sign-in, sessions, the enrolment ceremony, and invitation acceptance.
- "_contract/tsp/http/operators.tsp_" holds operator administration, invitations, and the security-event audit.
- "_contract/tsp/http/catalogue.tsp_" holds title groups, tracked titles, their variants and identifiers, and the two catalogue search indexes.
- "_contract/tsp/http/scans.tsp_" holds manual scans, scan history, scan results, and re-check ladders.
- "_contract/tsp/http/review.tsp_" holds the review queue, the five dispositions, reopening, and capture on demand.
- "_contract/tsp/http/violations.tsp_" holds the violation list and detail, closure, evidence retrieval, host objections, and legal holds.
- "_contract/tsp/http/notices.tsp_" holds notice drafting, approval, withdrawal, supersession, the handoff pack, and submission records.
- "_contract/tsp/http/dashboard.tsp_" holds the dashboard summary and the title chart.
- "_contract/tsp/http/settings.tsp_" holds the rights holder, budget, recipient profiles, and allowlist.
- "_contract/INVARIANTS.md_" maps every glossary invariant to what enforces it.
- "_contract/HTTP.md_" records the HTTP conventions, the operation inventory, and the emitter constraints.

## Commands

```bash
npm install
npm run compile   # emits OpenAPI 3.1 and JSON Schema 2020-12
npm run check     # compiles, then validates domain and HTTP fixtures against the bundle
npm run verify    # generates client types, builds and typechecks the TanStack Start stub, then runs it end to end
```

The verification workspace under "_contract/verify/_" has its own dependencies; `npm install` runs there once before `npm run verify`.

## Generated artifacts

The generated artifacts are committed:

- "_contract/generated/openapi/Patrol.openapi.yaml_" is the OpenAPI 3.1 document for the single service: 78 paths, 91 operations, and every domain and HTTP component.
- "_contract/generated/json-schema/patrol_" is the JSON Schema 2020-12 bundle. It has no file extension, which is what the emitter produces; read it as JSON explicitly. Every definition keeps an absolute `$id` of `https://patrol.example/schemas/<Name>.json`.

The check script compiles every emitted definition with Ajv and asserts that valid states and payloads validate while impossible ones — an approved notice without its approver, a closed violation without its closer, a failed scan without its reason, a review decision with an unknown action, an approval attestation with a refusal, a chart under the wrong metric — are rejected. It now covers request bodies, attestations, acknowledgements, chart envelopes, and error bodies alongside the domain lifecycles.

## Pipeline constraints

The pipeline is verified by the research ticket and by this contract's verification workspace. Both follow its discipline:

- No `@discriminated`. Every union member declares its own literal discriminator property, and the union is plain, because the JSON Schema emitter ignores `@discriminated` and the OpenAPI emitter emits no `discriminator` metadata even when it accepts the decorator.
- Implicit enums never ship: every enum value is explicit, because member names would otherwise become the wire format.
- The domain namespace stays separate from the HTTP namespace, so `@statusCode` never leaks into JSON Schema validators.
- No property defaults. The emitters keep a defaulted property required, and Ajv applies defaults only with `useDefaults`, which mutates input. The server owns every default.
- No generic wrappers. A concrete model is emitted; a template is not, so every page and wrapper is declared per resource.
- No recursion in the domain. Every union member is a flat model, so the Zod emitters' recursion defect cannot bite if a later consumer tries them.
- One `@service` namespace spans both namespaces, so the emitter writes one document whose name comes from `{service-name}`. Two services would write two documents and fully qualify every cross-service reference.
- Component names are prefixed with their namespace (`Domain.TrackedTitle`, `Http.ReviewDecisionRequest`); a client generator must not assume bare names.
- A union alias of error models flattens into one response per status, and a spread model becomes a reusable OpenAPI parameter component; the contract uses both to keep signatures short without hiding a status.
- Boolean literals emit as `type: boolean, enum: [true]`, which is how the approval and submission attestations force a confirmation rather than interpret a refusal. Numeric enums emit as integer enums; `ChartWindow` types as `7 | 14 | 30`.
- The JSON Schema emitter also emits parameter models (`CsrfToken`, `PageRequest`). A validator looks definitions up by `$id`, so they are harmless.

## HTTP contract

"_contract/HTTP.md_" is the build-facing reference: authentication, CSRF, roles, errors, paging, idempotency, the derived notice status, evidence retrieval, the operation inventory, and the emitter constraints. In summary:

- The API is mounted at `/api`; the session is a `__Host-patrol_session` cookie and every mutation carries `X-Patrol-CSRF`.
- Roles are declared per operation in the `x-patrol-roles` OpenAPI extension: `anonymous`, `operator`, or `administrator`, where an administrator inherits every operator capability.
- Failures share one error body with a stable `ErrorCode`; state conflicts add the conflicting identifiers, and a purged artifact answers `410`.
- Lists use `page`/`pageSize` and a concrete page model; no generic wrapper exists.
- The contract fixes the shapes the design documents left open: the sign-in challenge, the enrolment ceremony, the approval attestations, the derived notice status, and the allowlist entry's confirmation.
- The design's hard rules are guards, not prose: no confirmation while an allowlist hits, no notice mutation after approval, no second submission per notice, no scan twice on the same day, and no merge for a duplicate that has candidates or violations.

## Verification

"_contract/verify/_" is the proof the contract is consumable:

- `openapi-typescript` turns the emitted document into a `paths` type, and `openapi-fetch` supplies the typed runtime client.
- A TanStack Start 1.169.4 route uses `queryOptions` and a loader, and the decision mutation is typed from the generated request body with the CSRF header required by the contract.
- A Node stub of `POST /candidates/{candidateId}/review-decisions` validates the request against `ReviewDecisionRequest` before use, validates its own response against `ReviewDecisionResult` before sending, and answers `400 validation_failed` with field pointers for an invalid body.
- The end-to-end check exercises a valid request, an invalid request, and a malformed response, and exits non-zero on any disagreement.

Observed results at this commit: `tsc --noEmit` passes over the app, the generated types, and the stub; `vite build` emits client and SSR bundles; the stub answers `201` and `400` as expected; and the validator rejects the malformed response.

## Glossary coverage

Every glossary term appears here with the agreed meaning.

| Term | Type | Note |
| --- | --- | --- |
| Rights holder | `RightsHolder` | Exactly one per deployment. |
| Operator | `Operator` | Authenticated human; no rights-holder login. |
| Signatory | `Signatory` | A profile on the rights holder, snapshotted into a notice; no credentials. |
| Tracked title | `TrackedTitle` | Keyed by Patrol's UUIDv7, never by an external identifier. |
| Title variant | `TitleVariant` | Exactly one original variant, which is the display title. |
| Title type | `TitleType` | Film, series, miniseries, or other. |
| Title group | `TitleGroup` | Carries scan locales, scan time, and priority. |
| Allowlist entry | `AllowlistEntry` | Kind, match kind, scope, and territory. |
| Locale | `Locale` | BCP 47 language tag. |
| Territory | `Territory` | ISO 3166-1 alpha-2. |
| Engine | `Engine` | Google, Bing, or Yandex. |
| Scan | `Scan` | One title group, one engine, one due date. |
| Search query | `SearchQuery` | One query inside a plan. |
| Query plan | `QueryPlan` | Derived when the scan starts; never outlives it. |
| Search result | `SearchResult` | Provenance only; never edited. |
| Candidate | `Candidate` | A URL paired with one tracked title. |
| Review decision | `ReviewDecision` | Five dispositions, each pinned to the evidence it relied on. |
| Violation | `Violation` | Keyed by URL and tracked title; host from the destination. |
| Host | `Host` | Full hostname, distinct from the registrable domain. |
| Registrable domain | `RegistrableDomain` | eTLD+1, the reputation and reporting unit. |
| Capture | `Evidence` | The record of one capture, carrying its reason, outcome, attempt, profile, and observation time; the act itself is the fetch. |
| Evidence | `Evidence` | Immutable, content-addressed, shared per URL. |
| Legal hold | `LegalHold` | Suspends purging until released. |
| Recipient | `Recipient` | Google, Bing, or Yandex, distinct from the engine enum. |
| Recipient profile | `RecipientProfile` | Channel, account, limits, eligibility, and composition trigger. |
| Notice | `Notice` | One recipient, one rights holder, one or more violations. |
| Submission | `Submission` | One delivery attempt, performed by an operator. |

## Scope

The contract is the whole of the "TypeSpec HTTP contract and codegen verification" ticket: the domain, the HTTP surface, the generated artifacts, and the verification workspace. No route handler, database schema, or product code is written under this effort; the build slices follow in the handoff ticket.
