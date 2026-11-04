# Patrol

Ensuring your hard work stays where it belongs.

Patrol tracks a rights holder's titles across search-engine results, records unauthorized copies as violations with immutable evidence, and produces notices for Google, Bing, and Yandex that an operator files.

## Repository

- "_contract/_" is the TypeSpec source of truth and its generated OpenAPI, JSON Schema, and client types.
- "_apps/api/_" is the Fastify API; "_apps/worker/_" the background worker; "_apps/web/_" the TanStack Start interface.
- "_docs/_" holds the design documents, ADRs, research, and the build plan in "_docs/plan/_".

## Local development

Prerequisites: Docker with Compose, Node 26, and pnpm 10.

```bash
cp .env.example .env
docker compose up --build
```

- API health: <http://localhost:3000/health>
- Interface: <http://localhost:8080>
- MinIO console: <http://localhost:9001>

The API, worker, SSR app, PostgreSQL 18, MinIO, and the migration task run under Compose. The web container proxies browser API calls through its server.

Host-side checks:

```bash
pnpm install
pnpm contract:types   # regenerate the client types from the committed OpenAPI document
pnpm typecheck
pnpm test
pnpm build
```

Contract checks keep their own npm toolchains:

```bash
npm ci --prefix contract && npm run check --prefix contract
npm ci --prefix contract/verify && npm run check --prefix contract/verify
```

The API refuses to start when the database schema and the image disagree; run the migration task before the API, as Compose does.

### Bootstrap

The first administrator and the rights holder are created by the host-side CLI, which prints a one-time setup token:

```bash
docker compose run --rm api node apps/api/dist/cli/patrol.js bootstrap \
  --legal-name "Example Rights Holder" --country US \
  --address "1 Example Street" --role-mailbox legal@example.test \
  --admin-email admin@example.test
```

Open the setup flow with that token, set the password, and enroll TOTP. `patrol admin recover --email <address>` mints a recovery token for an administrator who lost both factors.

### Evidence storage

Captures run in the worker through Playwright and Chromium. Artifacts are content-addressed in the S3-compatible bucket named by `S3_BUCKET`, with `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` for local MinIO. Compose creates the bucket with versioning and Object Lock; the API answers artifact downloads with short-lived, version-pinned signed URLs.

### Acquisition providers

The worker runs the scan schedule and the per-engine queues from PostgreSQL through pg-boss. Set `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` for the Google route, and `YANDEX_API_KEY` plus `YANDEX_FOLDER_ID` for the Yandex route. An engine without credentials keeps its scans in the queue, and a rejected key or an empty provider balance disables the route until the hourly probe recovers it.
