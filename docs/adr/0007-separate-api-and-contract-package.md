# A separate Fastify API consumes a shared TypeSpec contract package

The HTTP contract is generated from TypeSpec, so the server and the TanStack Start UI must consume the same artifacts. Patrol runs a Fastify 5 API as its own service, and a pnpm workspace package compiles TypeSpec into a checked-in OpenAPI 3.1 document, a JSON Schema 2020-12 bundle, and openapi-typescript types; the server validates requests with Ajv against the bundle, and the UI calls the API with openapi-fetch.

## Considered options

- Hosting the API inside TanStack Start: one process, but the contract becomes a second surface inside the UI framework and cannot deploy independently.
- Hono: smaller and Web-standard, but Ajv validation and plugins must be assembled by hand.
- Generating into each app: no shared package, but two generation paths drift.
- TypeSpec TypeScript emitter: not exercised in the pipeline research, and OpenAPI is still needed for clients.

## Consequences

There are two deployables and a contract package, and CI checks the generated artifacts for drift. Domain and HTTP namespaces stay split, as the pipeline research requires, and generated files are reviewed in diffs.
