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
