# Patrol contract

TypeSpec is the single source for Patrol's domain and HTTP contracts. This package holds the domain model: entities, value types, enums, and the four lifecycle state machines. The HTTP namespace and its operations arrive in the next ticket, in the same package, as a separate namespace.

## Layout

- "_contract/tsp/main.tsp_" is the entry point and the only file that carries the service, version, and JSON Schema base URI.
- "_contract/tsp/ids.tsp_" holds the branded identifier scalars, all UUIDv7.
- "_contract/tsp/enums.tsp_" holds every enum, with explicit string values.
- "_contract/tsp/value-types.tsp_" holds shared scalars and value models: URLs, hosts, digests, country codes, locales, the capture profile, and redirect hops.
- "_contract/tsp/catalogue.tsp_" holds the rights holder, its signatory profile, title groups, tracked titles, variants, external identifiers, allowlists, and the acquisition budget.
- "_contract/tsp/discovery.tsp_" holds scans, query plans, search queries, search results, candidates, score components, and review decisions.
- "_contract/tsp/violations.tsp_" holds violations, the violation-evidence citations, evidence records, artifacts, and legal holds.
- "_contract/tsp/notices.tsp_" holds recipient profiles, notices, snapshots, submissions, acknowledgements, and failures.
- "_contract/tsp/operators.tsp_" holds operators, invitations, and sessions.
- "_contract/tsp/budget.tsp_" holds the quota ledger, budget reservations, and re-check ladders.
- "_contract/INVARIANTS.md_" maps every glossary invariant to what enforces it.

## Commands

```bash
npm install
npm run compile   # emits OpenAPI 3.1 and JSON Schema 2020-12
npm run check     # compiles, then validates fixtures against the emitted bundle
```

The generated artifacts are committed:

- "_contract/generated/openapi/Patrol.Domain.openapi.yaml_" is the OpenAPI 3.1 document. Its `paths` is empty until the HTTP contract adds operations.
- "_contract/generated/json-schema/patrol-domain_" is the JSON Schema 2020-12 bundle. It has no file extension, which is what the emitter produces; read it as JSON explicitly.

The check script compiles every emitted definition with Ajv and asserts that valid states validate while impossible states — an approved notice without its approver, a closed violation without its closer, a confirmed candidate without its violation, a failed scan without its reason — are rejected.

## Pipeline constraints

The pipeline is verified by the research ticket, and the model follows its discipline:

- No `@discriminated`. Every union member declares its own literal `state` property, and the union is plain.
- Implicit enums never ship: every enum value is explicit, because member names would otherwise become the wire format.
- The domain namespace stays separate from the HTTP namespace, so `@statusCode` never leaks into JSON Schema validators.
- No property defaults. The emitters keep a defaulted property required, and Ajv applies defaults only with `useDefaults`, which mutates input.
- No generic wrappers in the domain. A concrete model is emitted; a template is not.
- No recursion. Every union member is a flat model, so the Zod emitters' recursion defect cannot bite if a later consumer tries them.

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

The domain model is the whole of this ticket. The HTTP surface, generated clients, and wire validators are the ticket "TypeSpec HTTP contract and codegen verification"; no route, request DTO, or response envelope belongs here. No product code is written under this effort.
