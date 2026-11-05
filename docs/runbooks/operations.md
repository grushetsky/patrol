# Runbook: operations

Day-to-day operational surfaces of a Patrol deployment: the security-event
log, alert handling, provider key rotation, retention-purge monitoring, the
staging posture, and what the separate infrastructure repository must
contain.

## The security-event log is write-only by design

`security_events` is an append-only log (Authentication "Audit") written
inside the same transactions as the acts it records: sign-in successes,
failures, lockouts, per-IP throttling, the invitation lifecycle, credential
changes, TOTP enrolment, session revocation, recovery-code use, and
`candidate_reopened` (an operator's overturn of a colleague's dismissal).
`detail` never carries a password, a TOTP secret, a session token, or a
recovery code.

The build deliberately ships **no HTTP read surface for it** (no route, no
screen): the log is evidence for an investigation, not a browsing surface,
and a paginated feed of "who failed to sign in, from where" is itself a
thing worth not exposing. The operational path is SQL against the
database, under the same access discipline as the database itself. If a
deployment later wants a screen, that is a contract decision (roles,
pagination, redaction), not a runbook note — nothing here anticipates it.

### The queries an investigation reaches for

All times UTC. The table carries `(operator_id, created_at DESC)` and
`(kind, created_at DESC)` indexes; both filters are index-led.

```sql
-- One operator's whole authentication history, newest first.
select created_at, kind, detail, coarse_ip, user_agent
  from security_events
 where operator_id = (select id from operators where email = 'ops@example.test')
 order by created_at desc;

-- Sign-in failures and lockouts by address over the last day — the
-- brute-force watch. A wall of ip_throttled after failures is the
-- throttle working; failures spread across many addresses naming one
-- account is password spraying.
select coarse_ip,
       count(*) filter (where kind = 'sign_in_failed')   as failures,
       count(*) filter (where kind = 'account_locked')   as lockouts,
       count(*) filter (where kind = 'ip_throttled')     as throttled,
       count(*) filter (where kind = 'sign_in_succeeded') as successes,
       max(created_at) as last_seen
  from security_events
 where created_at > now() - interval '1 day'
   and kind in ('sign_in_failed','account_locked','ip_throttled','sign_in_succeeded')
 group by coarse_ip
 having count(*) filter (where kind = 'sign_in_failed') > 0
 order by failures desc;

-- Every security-relevant act inside a window (an incident's timeline).
select created_at, kind,
       coalesce((select email from operators o where o.id = operator_id), 'anonymous') as actor,
       detail
  from security_events
 where created_at between '2026-11-01T00:00:00Z' and '2026-11-02T00:00:00Z'
 order by created_at;

-- The invitation lifecycle for one address (who invited, when it was
-- accepted, whether anything was revoked).
select created_at, kind, detail
  from security_events
 where kind in ('invitation_created','invitation_revoked','invitation_accepted')
   and detail ->> 'email' = 'new@example.test'
 order by created_at;
```

The domain audit trail is the domain tables themselves — every act an
operator takes leaves an actor-attributed, immutable row: `review_decisions`
(operator, action, evidence ids), `notices`/`submissions` (composed_by,
approved_by, operator_id, attested_at), `legal_holds` (created_by and the
release trio, frozen by trigger). The queries:

```sql
-- Who decided what, over a window, with the evidence they pinned.
select d.decided_at, o.email, d.action, d.evidence_ids
  from review_decisions d join operators o on o.id = d.operator_id
 where d.decided_at between '2026-11-01' and '2026-11-08'
 order by d.decided_at;

-- Every hold ever placed, who released what, and why.
select h.created_at, h.reason, bo.email as placed_by,
       h.released_at, ro.email as released_by, h.release_reason
  from legal_holds h
  join operators bo on bo.id = h.created_by
  left join operators ro on ro.id = h.released_by
 order by h.created_at desc;
```

## Alert handling

Alerts fire once per threshold per engine per month (`budget_alerts`) and
once per submission (`submission_alerts`); both land in the UI (the
dashboard's engine row and the submissions backlog filter) and, when
`PATROL_ALERT_EMAIL` (or `PATROL_CONTACT_EMAIL`) names a mailbox, in that
mailbox over SMTP (`PATROL_SMTP_*`). A budget alert email names the engine,
the bucket, the spend, and the groups without a completed scan this month.

- **A warning (75%)** is a planning signal: check cadence and group
  priorities before the month spends itself.
- **A bucket critical (90%) or exhaustion (100%)** is the degradation the
  design fixes: re-checks starve first, then low-priority groups stop
  scheduling. Nothing is truncated or silently skipped — queued work waits
  with `budget_exhausted`. The response is a cap raise, a cadence change,
  or accepting the queue; never a manual ledger edit.
- **A balance critical** means the provider's prepaid balance is below the
  critical threshold: top up the provider, or the route disables.
- **A submission reminder** names submissions pending past seven days.
  Every submission names an operator — the reminder is for them to file.

A failed email delivery is a log line (`could not deliver…`), never a
retry: the durable rows stand, the UI still surfaces them, and the alert
never re-fires. If the mailbox is silent but the dashboard shows alerts,
check the SMTP env and the worker log.

## Provider key rotation

DataForSEO (`DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD`) and Yandex
(`YANDEX_SEARCH_API_KEY`/`YANDEX_FOLDER_ID`) live in Secrets Manager and are
injected at task start; an operator never sees a key in the UI.

1. Create the new secret version (or a new secret) in Secrets Manager.
2. Roll the worker task (ADR 0028 order). The next worker boots with the
   new credentials; a route without credentials stays unconfigured and the
   scheduler skips it — rotation cannot half-apply.
3. Watch one `scan.run` and the daily `budget.balance` probe on each
   engine: a successful probe is the new key's attestation. A 401/403
   probe disables the route and the hourly `route.probe` re-enables it
   once the key works — a failed rotation heals itself on the next roll.
4. Revoke the old key at the provider only after both engines probed
   clean.

The Wikidata contact (`PATROL_CONTACT_EMAIL`), the recovery pepper
(`PATROL_RECOVERY_PEPPER`, rotating it invalidates every recovery code —
deliberate), and SMTP credentials rotate the same way: secret, roll,
verify. The pepper's rotation means operators re-enrol recovery codes; say
so in the change notice.

## Retention-purge monitoring

The daily `retention.purge` job (04:20 UTC) logs one summary:
`marked` rows whose bytes are on their way out, `versionsDeleted` the
object-version deletes that landed, `bytesCompleted` rows fully cleaned,
`rawSerpKeysDeleted` raw payload objects past ninety days. A repeated
`could not delete an object version` line names a store problem — the next
run retries the same hash; the failure mode is a slower cleanup, never a
wrong one. The backlog to watch:

```sql
-- Rows whose purge marker stands but whose bytes are not yet deleted:
-- the re-runnable backlog. Growing across days means the object store
-- is refusing deletes; steady-state is small and transient.
select count(*) as backlog,
       min(purged_at) as oldest_marker,
       max(purged_at) as newest_marker
  from evidence
 where purged_at is not null and bytes_purged_at is null;

-- Active holds — the rows that outrank every purge rule.
select created_at, reason, released_at
  from legal_holds
 where released_at is null
 order by created_at desc;
```

Legal holds are placed and released from Settings → Legal holds; only an
administrator releases, with a recorded reason. A released hold's next
purge run re-evaluates everything it covered.

## Staging: delivery disabled, $5 acquisition cap

Staging exists to rehearse deploys, not to send notices.

- **Delivery is disabled by posture, not by a flag**: no operator performs
  a submission on staging without explicitly meaning to, and the staging
  rights holder's contact details are dummy values. If a staging
  deployment is used to rehearse a real handoff, wipe the submissions
  afterwards.
- **The acquisition cap is $5** (`rights_holder.budget_google_monthly_cap_minor = 500`
  and the Yandex cap likewise): enough for smoke scans, too small to
  matter when a script loops. Apply it right after bootstrap:
  ```sql
  update rights_holder
     set budget_google_monthly_cap_minor = 500,
         budget_yandex_monthly_cap_minor = 500;
  ```
- Staging SMTP either points at a sink (a mailbox nobody reads) or stays
  unset, in which case mail prints to the console transport and nothing
  leaves the host.
- The staging database is scratch: rebuild it freely, never restore
  production PITR into staging without wiping afterwards (it would carry
  real operator accounts and real evidence pointers).

## What the infrastructure repository must contain

Patrol's product repository ends at the images; the deployment lives in a
separate infrastructure repository (deployment-topology.md "What this
implies for the model"). Its first commit belongs to the build effort.
Handoff checklist — the infra repo contains:

- [ ] **Task definitions** for the three services (API, worker, SSR web),
      each from the published images, with the migrate task (the API
      image's one-shot `db/migrate-cli`) ordered BEFORE them (ADR 0028).
- [ ] **The ALB** with the listener split: `/api` to the API task,
      everything else to the SSR task; health checks on `/api/health`.
- [ ] **RDS PostgreSQL** (Multi-AZ): automated backups with 14-day PITR,
      the nightly `pg_dump` job (35-day retention) writing to the
      versioned bucket, and the credentials in Secrets Manager.
- [ ] **S3 buckets**: the evidence bucket with versioning AND Object Lock
      (compliance mode, the retention window), the pack prefix on the
      same bucket, the replication rule to the second bucket, and the
      dumps bucket.
- [ ] **The NAT gateway with a static Elastic IP** — every egress path
      (providers, captures, SMTP, CloudWatch) shares it.
- [ ] **Secrets Manager entries**: RDS credentials, DataForSEO, Yandex,
      SMTP credentials, session/CSRF signing material (rotated on a
      schedule that invalidates sessions deliberately),
      `PATROL_RECOVERY_PEPPER`.
- [ ] **Environment wiring** per task: `DATABASE_URL`,
      `PATROL_OBJECT_STORE_*`, `PATROL_SMTP_*`, `PATROL_ALERT_EMAIL`,
      `PATROL_CONTACT_EMAIL`, `PATROL_PUBLIC_URL`, `PATROL_ENV=production`
      (the API refuses to boot in production without the pepper and the
      contact address — that refusal is the wiring's self-test).
- [ ] **CloudWatch**: log groups for the three tasks, alarms on the
      health checks, the worker's queue heartbeat, the nightly dump job,
      and the retention backlog metric from the query above.
- [ ] **The staging stack**, small but same-shaped, with the $5 caps and
      the delivery posture this runbook fixes.
- [ ] **The deploy pipeline**: build images from the product repo,
      push, run the migrate task, then roll worker → API → web with
      drain; the load script (`load/k6-design-point.js`) runs against
      staging on every deploy.
