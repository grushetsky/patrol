# One PostgreSQL holds both domain data and the job queue

Patrol's scans and submissions must survive restarts and coordinate with domain writes. The design therefore uses PostgreSQL 18 as the single datastore: Drizzle for typed queries, drizzle-kit SQL migrations, and pg-boss for queues and cron schedules, with a separate worker process. Keeping the queue in the same database makes enqueue transactional with the domain change that caused it and removes Redis from the deployment.

## Considered options

- BullMQ on Redis: better throughput and dashboards, but a second datastore and a second backup path for a few hundred titles.
- Temporal: durable workflows, but a service to operate that the scale does not justify.
- In-process cron: no retry or durability across restarts.

## Consequences

Queue load shares the database, and workers scale by connection count. Browser automation runs in worker containers, with per-engine queues holding concurrency at one so quotas are respected.
