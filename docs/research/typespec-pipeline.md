# TypeSpec emission pipeline into TanStack Start and Node

- **Date:** 2026-11-03
- **Ticket:** [#6](https://github.com/grushetsky/patrol/issues/6)
- **Status:** verified with a working reproduction at `docs/research/typespec-repro/`
- **Verdict:** the round trip works, but only with an explicit modelling discipline:
  a plain union of models that each declare their own literal discriminator, and a
  separate domain namespace for JSON Schema validation. The `@discriminated`
  decorator path does **not** round-trip through the JSON Schema emitter today.

## Question

What is the concrete TypeSpec pipeline that emits the domain and HTTP contracts
Patrol needs, and does it work end to end today? Sub-questions: current emitter
packages and their state; how TanStack Start consumes the OpenAPI document; how a
Node server validates against emitted schemas; known gaps (discriminated unions,
branded types, enums, defaults, recursion); the minimal setup to copy.

## Reproduction

Everything below was executed in `docs/research/typespec-repro/`. `npm install`
succeeded from the public registry; no network or install failure occurred.

Toolchain actually used:

| Component | Version |
| --- | --- |
| Node / npm | 26.12.1 / 11.20.0 |
| `@typespec/compiler`, `@typespec/http`, `@typespec/openapi`, `@typespec/openapi3`, `@typespec/json-schema` | 1.17.0 |
| `@kattebak/typespec-zod-emitter` | 2.4.3 |
| `typespec-zod` (separate probe under `/tmp/tsp-zod-alt`) | `0.0.0-68` |
| `openapi-typescript` / `openapi-fetch` | 7.13.0 / 0.17.0 |
| `orval` | 8.46.0 |
| `@tanstack/react-start` / `react-router` / `react-query` | 1.169.4 / 1.170.46 / 5.105.3 |
| `ajv` / `ajv-formats` | 8.20.0 / 3.0.1 |
| `zod` | 4.6.7 |
| `typescript` / `vite` / `react` | 5.9.3 / 8.3.5 / 19.3.1 |

Commands (all exit 0 in the committed tree):

```bash
npm run pipeline    # tsp compile (main + gap specs) -> openapi-typescript -> orval
npm run build       # vite build: client + SSR bundles, generates routeTree.gen.ts
npm run check       # tsc --noEmit + Ajv schema checks + recorded Zod defect probe
```

One check intentionally reports a known defect (the generated Zod module cannot
be imported); it is printed with a `KNOWN DEFECT:` prefix and does not fail the
command. The gap probes encode today's observed behaviour (defects included) and
will start failing if an emitter is fixed, which is the intended signal.

## Findings

### 1. TypeSpec packages and emitters

The official emitters exercised here are `@typespec/openapi3` and
`@typespec/json-schema`, both 1.17.0. TypeScript types and runtime validators
come either from community TypeSpec emitters (Zod, TS-type emitters) or from the
OpenAPI document as the hand-off artifact; no Microsoft-owned TypeScript or Zod
emitter was installed as part of this pipeline.

- **OpenAPI 3.1 is not the default.** `openapi-versions` defaults to
  `["3.0.0"]`; 3.1 must be opted into. In 1.17.0 the option must be an **array**
  even though the published option page prints a scalar union type; a scalar
  value fails with `invalid-schema: must be array (/openapi-versions)`.
  ([emitter options](https://typespec.io/docs/emitters/openapi3/reference/emitter/))
- **Service version** is no longer a `@service` option in 1.17.0
  (`ServiceOptions` only has `title`). `@info(#{ version: "0.1.0" })` from
  `@typespec/openapi` sets `info.version`; without it the emitter writes
  `0.0.0`.
- **JSON Schema** is emitted as draft 2020-12. `bundleId` produces one document
  with all definitions under `$defs`, each entry keeping an absolute `$id`
  derived from the namespace `@jsonSchema(<baseUri>)`. Observed layout:
  `generated/json-schema/patrol` — the bundle file has **no file extension**
  even with `file-type: json`. Consumers must read it as JSON explicitly.
  ([emitter options](https://typespec.io/docs/emitters/json-schema/reference/emitter/))
- **Zod emitters** are community packages:
  - `@kattebak/typespec-zod-emitter@2.4.3` (peer `@typespec/http ^1.4.0`,
    `zod ^3.23 || ^4`), the more recently maintained of the two.
  - `typespec-zod@0.0.0-68`, an explicitly prerelease build of the emitter
    framework-based package; peers pin `@typespec/emitter-framework` to the
    0.15 line and `@alloy-js/*` to 0.22.
  - Both emit Zod 4-compatible expressions, and **both break on recursive
    models** (see gaps).
- **TypeScript type generation** is consumer-side and well supported:
  `openapi-typescript` 7.13.0 emits a `paths`/`components` type surface;
  `orval` 8.46.0 can emit React Query clients, fetch clients, or Zod schemas
  from the same document. `@kattebak/typespec-openapi-types-emitter` and
  `@azure-tools/typespec-ts` exist as TypeSpec-side TS emitters, but were not
  needed and were not exercised here.

### 2. How TanStack Start consumes the generated OpenAPI

Two shapes were generated and both compile against TanStack Start 1.169.4:

**A. `openapi-typescript` + `openapi-fetch` + `queryOptions` (used by the stub).**

`openapi-typescript` produces types only; `openapi-fetch` supplies a typed
runtime client over `fetch`:

```ts
// src/api/client.ts
import createClient from "openapi-fetch";
import type { paths } from "../../generated/openapi";

export const api = createClient<paths>({ baseUrl: "/api" });
```

The query is declared once as `queryOptions`, which is TanStack Query's
recommended way to share `queryKey` + `queryFn` with full inference
([Query docs](https://tanstack.com/query/latest/docs/framework/react/guides/query-options)):

```ts
export const violationsQuery = queryOptions({
  queryKey: ["violations", { page: 1, pageSize: 20 }],
  queryFn: async () => {
    const { data, error, response } = await api.GET("/violations", {
      params: { query: { page: 1, pageSize: 20 } },
    });
    if (error) throw new Error(`GET /violations failed: ${response.status}`);
    return data;
  },
});
```

The router loader only decides *when* to await the cache:

```ts
export const Route = createFileRoute("/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(violationsQuery),
  component: ViolationsPage,
});
```

Path params, query params, and request bodies are all typed from the generated
`paths` type (the write body type in `src/api/queries.ts` is derived from
`paths["/violations/{id}/notices"]["post"]["requestBody"]`). `vite build` emitted
both client and SSR bundles, and `tsc --noEmit` passes over the app, the
generated types, and the orval outputs.

**B. `orval` React Query client.**

`orval --client react-query` emits `useQuery`/`useMutation` hooks plus
`getViolationsListQueryOptions`, i.e. options objects that plug directly into
TanStack Query and into a router loader
([orval React Query guide](https://orval.dev/docs/guides/react-query/)):

```ts
export const getViolationsListQueryOptions = <TData = ...>(
  params: ViolationsListParams,
  options?: { query?: Partial<UseQueryOptions<...>>, fetch?: RequestInit },
) => { ... }
```

The generated client uses plain `fetch`, imports `@tanstack/react-query`
directly, and typechecks. It also injects the discriminator enum property
(`channel: "google"`) into union members from the OpenAPI `discriminator`
mapping. Choice: use `openapi-fetch` if the app wants to own query keys and
loaders; use orval if generated hooks are preferred. Do not generate both into
the same surface.

Caution: TypeSpec defaults make OpenAPI parameters `required: true`, so
`page` and `pageSize` are required arguments in the generated client even
though the schema carries `default`. Callers must pass them, or the contract
must be modelled with optional parameters plus server-side defaults.

### 3. How a Node server validates against the emitted schema

Tested with Ajv's 2020-12 class and `ajv-formats`
([Ajv JSON Schema](https://ajv.js.org/json-schema.html)). The emitted bundle
keeps absolute `$id`s across `$defs`; registering each definition under its own
`$id` is the smallest working setup:

```ts
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const schema of Object.values(bundle.$defs)) ajv.addSchema(schema);
const validate = ajv.getSchema("https://patrol.example/schemas/CreateNoticeRequest.json");
```

Observed results for the shipped contract (`npm run check:server`):

| Case | Schema | Result | Expected |
| --- | --- | --- | --- |
| Violation with nested recursive evidence | `Violation` | valid | valid |
| Violation missing defaulted `status` | `Violation` | invalid | invalid |
| Violation with unknown enum value | `Violation` | invalid | invalid |
| Notice with `channel: "google"` | `Notice` | valid | valid |
| Notice without `channel` | `Notice` | invalid | invalid |
| Create notice request | `CreateNoticeRequest` | valid | valid |

Defaults matter for server validation: JSON Schema `default` is an annotation,
and defaulted properties remain in `required`. Ajv's `useDefaults: true`
assigns defaults into the validated object (verified: `{}` becomes
`{ level: "Low" }`), so a server that wants defaults applied must opt in and
accept that validation mutates input
([Ajv defaults](https://ajv.js.org/guide/modifying-data.html#assigning-defaults)).

**Alternative: validators generated from OpenAPI.** `orval --client zod`
produced `ViolationsCreateNoticeBody` / `ViolationsCreateNoticeResponse` that
accept a valid discriminated notice, reject a notice without `channel`, apply
defaults, and strip unknown body fields (Zod's default object behaviour). Its recursion handling is lossy:
`derivedFrom` became `zod.unknown().optional()`, so nested evidence is accepted
without validation. That is acceptable only if recursion is flattened out of
the wire contract.

**TypeSpec-emitted Zod is not usable as emitted.** The generated
`generated/zod/schemas.ts` fails at import with
`ReferenceError: Cannot access 'EvidenceSchema' before initialization`
(`scripts/check-zod.ts`). The same failure occurs with the `typespec-zod`
probe. This is not fixable by configuration in either package.

### 4. Known gaps

| Area | Emitter / consumer | Observed behaviour | Impact / workaround |
| --- | --- | --- | --- |
| Discriminated unions | `@typespec/openapi3` | `@discriminated(#{ envelope: "none" })` emits `oneOf` + `discriminator.mapping` but does **not** inject the discriminator into member schemas. With the default envelope it does emit wrapper models (`kind` + `value`). | Add an explicit literal discriminator property to every member and use a plain union; works, but emits `anyOf` with no discriminator metadata. |
| Discriminated unions | `@typespec/json-schema` | Ignores `@discriminated` entirely: default envelope, inline envelope, and plain union all emit the same `anyOf` of member refs. `polymorphic-models-strategy` applies only to `@discriminator` on models. | Do not rely on this emitter for union tags. Probe: valid inline dog payload is rejected; envelope payload is rejected; flat payload is accepted. |
| Discriminated unions | `@kattebak/typespec-zod-emitter` | Union declarations are not emitted at all (no `NoticeSchema`; no `Page`). Member models are emitted. | Cannot validate a union response with this emitter. |
| Discriminated unions | `typespec-zod` | Emits `z.union([dmcaNotice, infringementNotice])`; README claims `z.discriminatedUnion` for `@discriminated`, but no runtime verification was possible because recursion breaks the module. | Community/preview only. |
| Discriminated unions | `openapi-typescript`, `orval` | Both synthesize the discriminator property into member types from `discriminator.mapping`; the TS union is discriminable. Ajv does not use `discriminator` by default. | TS clients are fine; JSON Schema validation is not, unless members declare the literal themselves. |
| Model inheritance polymorphism | JSON Schema emitter | `@discriminator` + `polymorphic-models-strategy: oneOf` emits a `oneOf` of derived schemas **plus an open fallback branch** that accepts any other discriminator value. Observed: unknown `channel` validates. | The advertised "closed union" is not closed today; enforce the tag in code or with an added `enum`. |
| Branded types | all | `scalar ViolationId extends string` + `@format("uuid")` survives as `format: uuid` in OpenAPI/JSON Schema, but TypeScript types are plain `string`, and Zod emits `z.uuid()` (a runtime check, not a nominal type). | Keep scalars for documentation/validation; add explicit TS brands in the app if nominality is required. |
| Enums (string) | all | Explicit string values (`Open: "open"`) are stable across OpenAPI, JSON Schema, `openapi-typescript`, orval, and both Zod emitters. | Use explicit string values everywhere. |
| Enums (numeric) | `@kattebak/typespec-zod-emitter` | Emits `z.enum([1, 2])`, which fails to parse numbers in Zod 4 (`Invalid option`). OpenAPI/JSON Schema emit `type: number, enum: [1, 2]` (number, not integer). | Avoid numeric enums; if needed, model as an int with explicit validation. |
| Enums (unvalued) | OpenAPI, JSON Schema, Zod | `enum Level { Low, Medium, High }` serializes with the member **names** (`"Low"`, …). TypeSpec documents enum representation as context-dependent. | Never rely on implicit values; always pin values. |
| Defaults | JSON Schema / Ajv | `default` is emitted and the property remains `required`; Ajv applies it only with `useDefaults: true`, and mutates input. | Decide defaults in the domain layer; if Ajv's mutation is acceptable, enable it deliberately. |
| Defaults | `@kattebak` Zod | Defaults are dropped (`retryCount: z.number()`, `status` has no `.default`). | Do not use as the validation source if defaults are contractual. |
| Defaults | `typespec-zod` | Emits `retryCount: z.number()...default(0n)` — a BigInt default for an `int32`, which is the wrong primitive type. | Do not use as-is. |
| Defaults | `orval` Zod | Emits `.default(...)`, making input fields optional and filling values. | Good fit for request validation if generated-Zod semantics are acceptable. |
| Recursion | `@typespec/openapi3`, `@typespec/json-schema`, `openapi-typescript`, Ajv | `$ref` cycles work: OpenAPI `$ref`, JSON Schema `$ref`, TS recursive interface, Ajv validates nested objects. | Safe for these artifacts. |
| Recursion | both Zod emitters | Emits a direct self-reference without `z.lazy` → `ReferenceError` on module import. | Flatten recursion in wire DTOs (e.g. `derivedFromId`) or hand-write `z.lazy`. |
| Recursion | `orval` Zod | Silently degrades recursive ref to `z.unknown()`. | Unvalidated subtrees. |
| Generics | JSON Schema, `@kattebak` Zod | `Page<T>` template is not emitted; `Page<Violation>` is inlined in OpenAPI and absent from JSON Schema/Zod output. | Define concrete response models (`ViolationPage`) if validators are needed. |
| HTTP metadata in domain schemas | JSON Schema, Zod | Reusing an HTTP model with `@statusCode` emits the status code as a required property (`NotFound._: 404`). | Split domain models from HTTP DTOs into separate namespaces; emit JSON Schema from the domain namespace only. |
| Nullable | all | `string \| null` emits `anyOf [string, null]`; Zod emits `z.union([z.string(), z.null()])`. | No gap. |
| Query params with defaults | OpenAPI → clients | Emitted as `required: true`; `openapi-typescript`/`openapi-fetch` require callers to pass them. | Model optional query params without `=` defaults, or pass defaults from the client. |
| Date/time | Zod emitters | `utcDateTime` is a wire string in OpenAPI; `@kattebak` emits `z.string().datetime()`, `typespec-zod` emits `z.coerce.date()` (output type `Date`), orval emits `z.iso.datetime({offset:true})`. | Pick one validator and keep the wire type a string end to end. |
| Formats | Zod consumers | `@format("uri")` becomes `z.url()` in orval and `z.string().url()` in `@kattebak`; `typespec-zod` uses `.uri()`. | Prefer `typespec-zod`'s `.uri()` if URNs are possible; otherwise acceptable. |

### 5. Minimal setup to copy

```
docs/research/typespec-repro/
├── package.json
├── package-lock.json           # exact versions, committed
├── tspconfig.yaml
├── tsp/main.tsp                # HTTP surface + domain models
├── tsp-gaps/main.tsp           # union/discriminator gap probes
├── scripts/
│   ├── validate-node.ts        # Ajv against emitted JSON Schema
│   ├── validate-gaps.ts        # records emitter defects
│   └── check-zod.ts            # records the Zod import failure
├── src/
│   ├── router.tsx              # router + QueryClient context
│   ├── routes/__root.tsx
│   ├── routes/index.tsx        # loader + createServerFn
│   ├── api/client.ts           # openapi-fetch client
│   ├── api/queries.ts          # queryOptions
│   ├── server/notice-validation.ts
│   └── routeTree.gen.ts        # generated by `vite build`
├── generated/                  # committed evidence, regenerable
│   ├── openapi/Patrol.openapi.yaml
│   ├── openapi.d.ts            # openapi-typescript
│   ├── gaps/                   # union/discriminator probe outputs
│   ├── json-schema/patrol      # JSON Schema 2020-12 bundle (no extension)
│   ├── zod/schemas.ts          # @kattebak (known broken)
│   └── orval/{patrol,zod}.ts   # react-query client + zod validators
└── .gitignore                  # node_modules, dist, .tanstack
```

`tspconfig.yaml` (the exact working file):

```yaml
emit:
  - "@typespec/openapi3"
  - "@typespec/json-schema"
  - "@kattebak/typespec-zod-emitter"
options:
  "@typespec/openapi3":
    emitter-output-dir: "{project-root}/generated/openapi"
    file-type: yaml
    output-file: "{service-name}.openapi.yaml"
    openapi-versions:
      - 3.1.0
  "@typespec/json-schema":
    emitter-output-dir: "{project-root}/generated/json-schema"
    file-type: json
    bundleId: patrol
    emitAllModels: true
    seal-object-schemas: true
    polymorphic-models-strategy: oneOf
  "@kattebak/typespec-zod-emitter":
    emitter-output-dir: "{project-root}/generated/zod"
    output-file: schemas.ts
```

Scripts that matter:

```json
{
  "tsp:compile": "tsp compile tsp/main.tsp",
  "tsp:compile:gaps": "tsp compile tsp-gaps/main.tsp --config tsp-gaps/tspconfig.yaml",
  "types:openapi": "openapi-typescript generated/openapi/Patrol.openapi.yaml -o generated/openapi.d.ts",
  "client:orval": "orval --config orval.config.ts",
  "pipeline": "npm run tsp:compile && npm run tsp:compile:gaps && npm run types:openapi && npm run types:openapi:gaps && npm run client:orval",
  "build": "vite build",
  "typecheck": "tsc --noEmit",
  "check": "npm run typecheck && npm run check:server && npm run check:gaps && npm run check:zod"
}
```

Ordering constraints:

1. `tsp compile` must run before `openapi-typescript` and `orval`.
2. `vite build` (or `vite dev`) generates `src/routeTree.gen.ts`; typecheck
   before a build fails on the missing route tree. Commit the generated tree or
   run the build first in CI.
3. The Ajv scripts read the JSON Schema bundle at import time; run them after
   compilation.
4. `@kattebak`'s middleware imports `./schemas.js` while emitting `schemas.ts`,
   so it is not usable as generated; do not depend on it.

### Round-trip acceptance result

- TypeSpec → OpenAPI 3.1: **works** (`openapi: 3.1.0`, `info.version: 0.1.0`).
- TypeSpec → JSON Schema 2020-12 bundle: **works**; Ajv validates the six
  contract cases correctly with the explicit-literal union modelling.
- OpenAPI → TypeScript client → TanStack Start stub: **works**; `tsc` and
  `vite build` (client + SSR) pass with `openapi-fetch` + `queryOptions` and
  with orval's React Query output.
- Node request validation: **works via Ajv**; works via orval-generated Zod
  except recursive subtrees; **fails via TypeSpec-generated Zod**.
- The decorator-based discriminated union (`@discriminated`) round trip:
  **fails** in the JSON Schema path and is inconsistent in OpenAPI unless the
  discriminator property is declared on each member.

## Open risks

- All emitters are pinned to exact versions; TypeSpec 1.17.0 is young and the
  option schema already disagrees with its published docs (`openapi-versions`
  array vs scalar). Pin and review upgrades.
- The Zod emitters are community/prerelease. Their recursion failure and union
  omission are silent at compile time (only the generated module fails), so any
  adoption needs a runtime import smoke test in CI.
- orval/openapi-typescript **synthesize** discriminator properties that the
  OpenAPI document does not contain. That hides the emitter defect for
  TypeScript consumers but not for Ajv, Postel-compatible validators, or other
  generators.
- JSON Schema `seal-object-schemas` plus OpenAPI `seal-object-schemas` change
  unknown-property handling; leaving one sealed and the other not creates
  client/server acceptance drift. Set both deliberately.
- The TanStack Start integration was verified by typecheck and production
  build, not by an actual HTTP request against a running server.
- `@typespec/versioning` was not exercised; API versioning strategy for
  `info.version`/multiple emitted documents remains open.

## What this means for the design

1. **Split the namespaces.** Put domain types (violations, evidence, notices) in
   a namespace without `@typespec/http` decorators and emit JSON Schema from
   it. Put request/response DTOs in the HTTP namespace and emit OpenAPI from it.
   This avoids `@statusCode` leaking into validators and keeps HTTP concerns out
   of the domain contract.
2. **Model unions explicitly.** Use a plain union of models that each declare a
   literal discriminator property (`channel: "google"`). Do not depend on
   `@discriminated` or model `@discriminator` for schema emission in 1.17.0;
   they produce incomplete or open schemas. This single decision makes Ajv,
   openapi-typescript, and orval agree.
3. **Prefer Ajv + JSON Schema for server-side request validation.** It is the
   only path that preserved recursion, defaults, enums, and union semantics in
   the probe. Use `useDefaults: true` only if mutating input is acceptable;
   otherwise apply defaults explicitly in the domain layer.
4. **Use OpenAPI as the client contract.** `openapi-typescript` +
   `openapi-fetch` with `queryOptions` fits TanStack Start loaders and Query
   with the least generated surface. Add orval only if generated hooks are
   worth the extra dependency; its Zod output is a viable fallback validator
   provided recursive DTOs are flattened.
5. **Avoid recursion in wire DTOs.** Model evidence chains with a parent
   identifier (`derivedFromId: string`) instead of nested `derivedFrom:
   Evidence`. JSON Schema/OpenAPI/Ajv handle recursion, but every Zod path
   either crashes or degrades to `unknown`.
6. **Pin enum values, not member names.** Explicit string enums are the only
   shape that stayed stable across all emitters and generators.
7. **Keep branded IDs as format annotations.** Validate `uuid`/`uri` with
   `ajv-formats`; add TypeScript brands by hand where nominality matters,
   because the generated TS is plain `string`.
8. **Emit OpenAPI 3.1 explicitly** with `openapi-versions: ["3.1.0"]`, set
   `info.version` via `@info`, and decide `seal-object-schemas` consistently on
   both emitters.

## Citations

- TypeSpec OpenAPI 3 emitter options (`openapi-versions` default `["3.0.0"]`,
  `seal-object-schemas`): https://typespec.io/docs/emitters/openapi3/reference/emitter/
- TypeSpec JSON Schema emitter options (`bundleId`, `polymorphic-models-strategy`,
  `seal-object-schemas`): https://typespec.io/docs/emitters/json-schema/reference/emitter/
- TypeSpec built-in decorators (`@discriminated` targets `Union`, `@discriminator`
  targets `Model`, default envelope shape):
  https://typespec.io/docs/standard-library/built-in-decorators/
- TypeSpec discriminated types, including `envelope: "none"` serialization:
  https://typespec.io/docs/standard-library/discriminated-types/
- TypeSpec enums (values are optional and representation is context-dependent):
  https://typespec.io/docs/language-basics/enums/
- TypeSpec models, optional properties and defaults:
  https://typespec.io/docs/language-basics/models/
- TypeSpec configuration and `{project-root}` output directories:
  https://typespec.io/docs/handbook/configuration/configuration/
- openapi-typescript repository: https://github.com/openapi-ts/openapi-typescript
- openapi-fetch documentation: https://openapi-ts.dev/openapi-fetch/
- orval React Query guide: https://orval.dev/docs/guides/react-query/
- orval output configuration (`client`, including `zod`):
  https://orval.dev/docs/reference/configuration/output
- TanStack Start getting started (Vite plugin, router factory):
  https://tanstack.com/start/latest/docs/framework/react/getting-started
- TanStack Query `queryOptions`:
  https://tanstack.com/query/latest/docs/framework/react/guides/query-options
- Ajv JSON Schema draft 2020-12 support:
  https://ajv.js.org/json-schema.html
- Ajv `useDefaults` semantics:
  https://ajv.js.org/guide/modifying-data.html#assigning-defaults
- Zod 4 string formats (`z.uuid`, `z.url`, `z.iso.datetime`):
  https://zod.dev/api
- Package versions as installed: npm registry pages for
  [`@typespec/compiler@1.17.0`](https://www.npmjs.com/package/@typespec/compiler/v/1.17.0),
  [`@typespec/openapi3@1.17.0`](https://www.npmjs.com/package/@typespec/openapi3/v/1.17.0),
  [`@typespec/json-schema@1.17.0`](https://www.npmjs.com/package/@typespec/json-schema/v/1.17.0),
  [`@kattebak/typespec-zod-emitter@2.4.3`](https://www.npmjs.com/package/@kattebak/typespec-zod-emitter/v/2.4.3),
  [`typespec-zod@0.0.0-68`](https://www.npmjs.com/package/typespec-zod/v/0.0.0-68),
  [`openapi-typescript@7.13.0`](https://www.npmjs.com/package/openapi-typescript/v/7.13.0),
  [`orval@8.46.0`](https://www.npmjs.com/package/orval/v/8.46.0).
- Emitter behaviour, generated files, and validator results in this document
  are observations from the committed reproduction, not claims from secondary
  write-ups.
