# Migrations are forward-only and every deployment snapshots before it migrates

A deployment takes an RDS snapshot, runs one `migrate` task built from the same image, then rolls the API, the worker, and the SSR service in that order, draining the worker rather than killing a scan. Migrations are numbered Drizzle SQL files with no down path; a destructive change is split across two releases, and the API and worker refuse to start when the database schema and the image disagree.

## Considered options

- **Reversible migrations.** A comfort that is rarely exercised and often wrong when it matters, because a dropped column's data is not in the migration and a down path can be more dangerous than the change.
- **Migrate on application start.** No separate task, and every replica races the same migration, a failed roll leaves the schema ahead of the code, and a long migration blocks the health check.
- **Migrate by hand.** No pipeline to build, and the first forgotten migration on a Friday evening is an outage with no recorded cause.
- **A blue-green database cutover.** Removes the migration window, and it doubles the database cost and the complexity for a service whose write volume is a few scans an hour.

## Consequences

- Every deployment has a snapshot identifier in its log, so a bad migration has a concrete restore point rather than a timestamp to guess at.
- Expand-then-contract keeps each release compatible with the previous schema, which is what allows the services to roll one at a time without downtime.
- A schema mismatch fails startup loudly; the old version keeps serving until the new one is healthy, and a roll back means redeploying the previous image, not undoing a migration.
- The worker drain is part of the deploy, so an in-flight scan or capture either finishes or is retried under its own idempotency key instead of disappearing.
- The restore path is split: point-in-time recovery for the database, versioned content-addressed objects for evidence, and infrastructure recreated from code. A quarterly drill is the only proof any of it works.
