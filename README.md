# Patrol

Ensuring your hard work stays where it belongs.

Patrol is an anti-piracy SERP monitoring tool: it watches search engines
for copies of a rights holder's catalogue, captures evidence for every
candidate, and drives the notice handoff to the recipients' forms. The
product is bilingual (English/Russian), operator-first, and evidence-led —
every violation cites captures, every capture is immutable, and every
submission names the operator who filed it.

| Where | What |
| --- | --- |
| `apps/api` | Fastify 5 API serving the contract (`contract/`, TypeSpec) |
| `apps/worker` | pg-boss worker: scans, captures, crons, the retention purge |
| `apps/web` | TanStack Start SSR app on the generated OpenAPI client |
| `packages/*` | The shared domain: budget, catalogue, evidence, i18n, mail, notices, scans |
| `docs/design` | The design documents the code cites in its comments |
| `docs/runbooks` | Backup/restore and operations runbooks |

## Bootstrap

Requirements: Node 26+, pnpm 10+, Docker (Compose v2) for the database
tests and the local topology.

```sh
pnpm install --frozen-lockfile   # workspace install
docker compose -f docker-compose.test.yml up --detach --wait   # test db + minio
pnpm test:db                     # api + worker database suites
docker compose -f docker-compose.test.yml down

docker compose up --build --wait # the full local topology on loopback:
                                 # db :5432, minio :9000, api :8080, web :3000
```

The compose stack runs its one-shot migrate task first (ADR 0028); the API
and worker start only after it completed. Then bootstrap the first
administrator:

```sh
pnpm -C apps/api run cli bootstrap --legal-name "Example Rights GmbH" --country DE
```

The command records the rights holder, invites the first administrator,
and prints the one-time setup token (run `pnpm -C apps/api run cli help`
for every flag). Open `http://localhost:3000`, follow the enrollment
(password + TOTP + recovery codes), and sign in.

## Environment

Copy `.env.example` to `.env` for host-run development; the compose files
hardcode the same values for the container topology. The variables a
deployment actually owns:

| Variable | Consumer | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | api, worker | PostgreSQL connection string |
| `PATROL_OBJECT_STORE_ENDPOINT` / `_ACCESS_KEY` / `_SECRET_KEY` / `_BUCKET` | api, worker | The S3-compatible evidence store (MinIO locally) |
| `PATROL_CONTACT_EMAIL` | api, worker | The contactable address for upstream User-Agents (Wikidata, DataForSEO). Required in production |
| `PATROL_ALERT_EMAIL` | worker | The operator mailbox budget-alert and submission-reminder emails land in; falls back to `PATROL_CONTACT_EMAIL`, and without either the alert rows still fire — only the email is skipped |
| `PATROL_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` / `_FROM` | api, worker | The SMTP relay for invitations, resets, and alerts. With a host set, both processes send through it (the from address is then required); without one, mail prints to the console |
| `PATROL_RECOVERY_PEPPER` | api | The server-side pepper for recovery-code hashes. Required in production; rotating it invalidates every recovery code (deliberate) |
| `PATROL_PUBLIC_URL` | api | The origin invitation and reset emails link back to |
| `PATROL_ENV` | api | `dev` (default) or `production` |
| `PATROL_RATE_LIMIT_WINDOW_SECONDS` / `_SESSION_MAX` / `_ANONYMOUS_MAX` | api | The general API rate limits (defaults 60s / 600 / 120); the health probe is exempt and the sign-in lockout throttle is separate |
| `DATAFORSEO_LOGIN` / `_PASSWORD`, `YANDEX_SEARCH_API_KEY` / `_FOLDER_ID` | worker | Provider credentials; unset (or `PATROL_FAKE_ADAPTER=1`) keeps the fixture-driven fake route |
| `TEST_DATABASE_URL` | tests | The throwaway database `pnpm test:db` runs against (port 5433) |

## Verification

```sh
pnpm check        # contract compile + schema checks
pnpm verify       # the contract's TanStack Start verification build
pnpm typecheck    # every workspace package
pnpm test:unit    # unit suites (no dependencies)
pnpm ci:local     # install + contract + freshness + typecheck + unit, exactly what CI runs
pnpm ci:local:db  # the db/minio test stack up, api+worker database suites, down
pnpm rehearse:restore   # the backup/restore rehearsal (docs/runbooks/backup-restore.md)
```

The contract is the source of truth: `contract/tsp` compiles to
`contract/generated`, the API validates request bodies against the
generated schemas, and the web client is generated from the same OpenAPI
document. A change that touches the contract regenerates all three —
`pnpm -C contract run check` and `node scripts/check-generated-fresh.mjs`
(called by `ci:local`) fail on stale artifacts.

## Load testing

`load/k6-design-point.js` exercises the three read surfaces an operator's
day hammers (dashboard summary, title chart, review queue) at the design
point — five operators, think time, no synthetic spike. Sign in once as an
operator and pass the session cookie:

```sh
k6 run -e BASE_URL=http://localhost:8080 \
       -e SESSION_COOKIE='patrol_session=…' \
       load/k6-design-point.js
```

The script's header comment carries the full local-run recipe; thresholds
assert p95 per endpoint and a sub-1% error rate.

## Deploying

The deployment topology (ALB, Fargate, RDS with PITR, the versioned
object store) lives in a separate infrastructure repository;
`docs/design/deployment-topology.md` is its blueprint and
`docs/runbooks/operations.md` carries the handoff checklist. The image
order on every deploy is fixed (ADR 0028): the migrate task runs first,
then the API, the worker, and the SSR app roll with drain. Backups,
restore drills, and the quarterly rehearsal are in
`docs/runbooks/backup-restore.md`.
