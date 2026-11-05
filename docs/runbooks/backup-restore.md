# Runbook: backup and restore

The recovery targets (docs/design/deployment-topology.md "Backups"): a
**five-minute RPO** for the database and a **four-hour RTO** for the whole
stack. A backup that has not been restored is not a backup — the quarterly
drill below is part of the backup itself, and `scripts/rehearse-restore.mjs`
(`pnpm run rehearse:restore`) automates it end to end against the compose
test topology.

## What is backed up and what is not

| Asset | Backup | Retention | Restore path |
| --- | --- | --- | --- |
| PostgreSQL data | RDS automated backups with point-in-time recovery to the second | 14 days | Restore to a new instance (PITR target or latest snapshot), then repoint the services |
| PostgreSQL logical dump | Nightly `pg_dump` to a versioned bucket in the same region | 35 days | `pg_restore`/`psql` into a fresh instance for a partial recovery |
| Evidence and derived objects | S3 versioning with Object Lock (compliance mode) on the evidence bucket | Per the evidence retention windows | A restore is a copy, never an overwrite; the objects never left |
| Configuration | The infrastructure repo (code) and the last database restore | Repository history | Rebuild the stack from code and the restored database |

The object store needs no backup of its own: compliance-mode Object Lock
prevents deletion before the retention date, versioning prevents an
overwrite from losing a version, and a bucket-level replication rule to a
second bucket in the same region (added in production) covers accidental
policy deletion. The database is the only asset whose loss loses data.

## Restore: snapshot → migrate → roll, with drain

The four-hour RTO is dominated by restoring the database into a new
instance and rolling the services. In order:

1. **Restore the database.** Pick the PITR target (any second inside the
   14-day window) or the latest snapshot; restore it into a NEW RDS
   instance, never over the live one. For a partial recovery (one bad
   write, not an outage), restore the nightly dump into a scratch instance
   instead and read what is needed out of it.
2. **Point the services at the restored instance.** The connection string
   is the only database coupling: update it in Secrets Manager / the task
   definitions.
3. **Run the migrate task first** (ADR 0028: the one-shot migration runner
   from the API image applies every pending forward-only migration and
   exits). The restored database's schema stamp may be behind the image;
   the API and worker REFUSE to start against a stamp that disagrees
   (`schema_mismatch`), by design — the migrate task reconciles it. A
   stamp AHEAD of the image means the image is older than the database:
   roll the image forward, never the database back.
4. **Roll the API, then the worker, then the SSR app**, in that order
   (ADR 0028's deploy order), each behind the ALB. A drain is not a stop:
   the worker's `SIGTERM` path finishes the scan or capture in flight
   inside its one-minute drain timeout, and the API closes only after its
   in-flight requests answer. The ALB health check gates each replacement.
5. **Fetch one evidence object** through the running stack (the drill's
   step 5 below) — this proves the presigned path, not just the boot.

A drill that skips step 5 has proved the database boots, not that evidence
is recoverable.

## The quarterly drill

Every quarter, into a scratch stack (never production):

1. **Restore** the latest snapshot AND the latest nightly dump (two
   recoveries, because they fail differently).
2. **Migrate** the restored database to the current image's stamp.
3. **Boot the API** against it and confirm `/api/health` and
   `/api/system/version` (the schema check runs at boot).
4. **Time the whole path** against the four-hour RTO; record the number.
5. **Fetch one evidence object** through a signed URL minted against the
   restored stack, and confirm its bytes and SHA-256 against the record.
6. **Record the drill** (date, timings, surprises) next to this runbook.

Locally, `pnpm run rehearse:restore` performs the same sequence against
the compose test topology (`docker-compose.test.yml`): it seeds minimal
data plus one evidence object, takes a `pg_dump` and an object copy,
drops the schema, empties the bucket, restores both, boots the API for
the schema check, and fetches the evidence through a signed URL — timing
every phase. Use it to rehearse between the quarterly drills and to
validate any change that touches the migration chain or the store layout.

## Monitoring the backups themselves

- The nightly dump job alarms on failure (CloudWatch on the batch job's
  exit code) — a silent dump is a missing backup.
- The PITR window is 14 days by configuration; confirm the
  `earliest_restorable_time` after any RDS maintenance.
- The dump bucket's object count grows monotonically: 35 days of dailies
  is ~35 objects per database; a flat line means the job stopped.
