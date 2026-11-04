# Patrol build handoff

This directory is the entry point for a build effort. It assembles what that effort needs and links every item to its canonical source; it does not restate the design. The design is complete enough to slice, the contract compiles and is verified, and the remaining open items are named rather than assumed.

## Scope

The handoff covers one single-tenant service: a rights holder's tracked titles, search-engine discovery, human review, immutable evidence, notices composed for Google, Bing, and Yandex, and operator-performed submission. No product code is written here. The slices in "_docs/plan/build-slices.md_" are ticket-ready; filing them as build tickets belongs to the build effort.

## Source map

| What a build effort needs | Canonical location |
| --- | --- |
| Domain language, lifecycles, and invariants | "_GLOSSARY.md_" |
| Architecture and hard-to-reverse decisions | "_docs/adr/_", audited below |
| Domain and HTTP contract | "_contract/tsp/_" |
| Contract conventions, operations, and emitter constraints | "_contract/HTTP.md_" |
| Generated OpenAPI, JSON Schema, and client types | "_contract/generated/_", "_contract/verify/src/generated/_" |
| Codegen configuration to copy | "_contract/package.json_", "_contract/tspconfig.yaml_", "_contract/verify/_" |
| Screens, review queue, chart definitions | "_docs/design/dashboard-ui.md_", prototype at <https://grushetsky.github.io/patrol/dashboard-spec/> |
| Scheduler, quota, matching, and submission rules | "_docs/design/_", compiled in "_docs/plan/implementation-rules.md_" |
| Build slices and dependencies | "_docs/plan/build-slices.md_" |
| Open risks and which slice de-risks each | "_docs/plan/risks.md_" |
| Vocabulary audit | "_docs/plan/glossary-audit.md_" |

The research branches referenced by the design documents (`research/search-engines`, `research/notice-submission`, and the rest) are evidence for decisions, not artifacts a build effort consumes; they stay unmerged.

## Contract handoff

The contract is a TypeSpec package with one service over two namespaces. It emits:

- "_contract/generated/openapi/Patrol.openapi.yaml_" — OpenAPI 3.1, 76 paths and 89 operations.
- "_contract/generated/json-schema/patrol_" — JSON Schema 2020-12, 327 definitions, each under an absolute `$id`.
- "_contract/verify/src/generated/openapi.d.ts_" — `openapi-typescript` types used by the client.

A build effort copies the package and its configuration, keeps the generated artifacts committed, and wires the server to Ajv 2020 over the same bundle. The verification workspace is a working reference: `openapi-fetch` client, TanStack Start route with `queryOptions`, a Node stub that validates requests and responses, and an end-to-end check.

The conventions that matter before the first route is written:

- The API is mounted at `/api`; the session is a `__Host-patrol_session` cookie; every mutation carries `X-Patrol-CSRF`.
- Errors share one body with a stable `ErrorCode`, field pointers, and conflict identifiers; `503 setup_required` applies to every domain operation until bootstrap completes.
- Paging is `page`/`pageSize` with concrete page models; no generic wrapper exists.
- Roles are declared per operation as `x-patrol-roles`; an administrator inherits every operator capability.
- The client must narrow union responses on the literal `state`, `metric`, or `recipient` property; the document carries no `discriminator` metadata.

"_contract/HTTP.md_" holds the full conventions and the operation inventory. The emitter constraints there are part of the handoff, not trivia: component names are prefixed, error bodies are named after their spread source, and boolean attestations emit as `enum: [true]`.

## ADR audit

Every decision that is hard to reverse has an ADR. Reversible UI and contract conventions stay in the design documents and "_contract/HTTP.md_", because an ADR that will simply be reversed carries no value.

| Decision area | ADRs | Verdict |
| --- | --- | --- |
| Violation identity, evidence cardinality, destination host | 0001, 0002, 0004 | Covered, including the rejected alternatives. |
| Split lifecycles | 0003 | Covered; the dashboard's derived status is a read model, not a sixth state. |
| Single PostgreSQL, jobs, migrations | 0005, 0028 | Covered. |
| Evidence storage, bundle, retention, fetch posture | 0006, 0016, 0017, 0018 | Covered, including the legal reasoning for retention and for fetching a reported page. |
| Contract pipeline and package boundary | 0007, 0029 | 0029 was added by this handoff to record why one service spans two namespaces. |
| Human review and matching boundaries | 0008, 0009, 0010 | Covered. |
| Acquisition routes, queries, re-checks, quota, cap | 0011, 0012, 0013, 0022, 0023, 0024 | Covered. |
| Catalogue authorship and deduplication | 0015 | Covered. |
| Notice grouping, frozen pack, attestation split | 0014, 0019, 0020, 0021 | Covered. |
| Credentials, sessions, roles, signatory | 0025, 0026 | Covered. |
| Deployment platform and topology | 0027, 0028 | Covered. |

No ADR is superseded. The only new decision this handoff adds is 0029; the host-objection record added by the HTTP contract is a model completion of ADR 0018's rule, not a new alternative.

## Glossary audit

The audit is in "_docs/plan/glossary-audit.md_". Its results:

- All 27 glossary terms map to a contract type and to the surfaces that use them; no term is defined twice or contradicted.
- One UI label drifted: the review queue's "Work" column used a word the glossary lists under `_Avoid_` for a tracked title. It is now "Tracked title" in "_docs/design/dashboard-ui.md_".
- Three concepts introduced after the vocabulary was frozen are documented in their own artifacts but not yet in the glossary: host objection, handoff pack, and derived notice status. The audit drafts entries for a future vocabulary ticket and does not change the canonical glossary here.

## Build slices

The sliced plan is in "_docs/plan/build-slices.md_". The order is driven by dependencies, not by screen:

| Slice | Goal | Depends on | De-risks |
| --- | --- | --- | --- |
| 0 | Workspace, contract pipeline, runtime skeleton | — | Contract drift, local stack, CI. |
| 1 | Identity, bootstrap, sessions, roles | 0 | Setup gating, CSRF, credential recovery. |
| 2 | Catalogue and settings | 1 | Deduplication, merge, allowlist scoping, Wikidata fallback. |
| 3 | Budget, scheduling, SERP acquisition | 2 | Provider contracts, quota concurrency, queue order. |
| 4 | Evidence capture | 3 | Playwright ceilings, Object Lock, capture outcomes. |
| 5 | Matching, review, violations | 3, 4 | Score calibration, queue performance, lifecycle guards. |
| 6 | Notices and handoff packs | 5, 2 | Recipient caps, approval freeze, pack fidelity. |
| 7 | Submissions and acknowledgements | 6 | Per-recipient fields, retry semantics, backlog. |
| 8 | Dashboard and reporting | 5, 6, 7 | Chart definitions and query cost. |
| 9 | Hardening, retention, launch | all | Retention correctness, restore drill, egress, alerts. |

## Open items

These are named so a build effort does not assume them silently:

- **Recipient statement texts.** The contract carries a statement version and resolves fields, but the exact current text per recipient and how versions are tracked is undecided; it blocks notice composition (slice 6), not the slices before it.
- **Optimistic concurrency.** No `If-Match` or idempotency key exists; state guards and unique constraints are the boundary. A build effort that needs more records a new decision.
- **Audit read surface.** Security events are written but no read endpoint is fixed; the session and operator lists cover the administrative views.
- **UI language and notice language.** Strings externalise, but no product language is chosen.
- **Provider prices and caps.** The Google per-file cap and per-day quotas are learned at runtime; list prices are re-quoted before build and reviewed quarterly.

## Verification before building

```bash
cd contract
npm install
npm run check     # 43 Ajv checks over domain and HTTP payloads
npm run verify    # client types, TanStack Start build, typecheck, stub end to end
```

A green run proves the contract, the generated client, and the validators still agree. A change to a TypeSpec model that breaks a consumer fails here before it reaches a route.
