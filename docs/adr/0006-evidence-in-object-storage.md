# Evidence blobs live in S3-compatible object storage

Evidence is large, immutable, and shared across violations, so Patrol stores the bytes in an S3-compatible bucket and keeps only metadata in PostgreSQL. Objects are keyed by the sha256 of their content, which deduplicates repeat captures; production buckets enable versioning and Object Lock where the provider supports it, and development uses MinIO.

## Considered options

- Local filesystem: simplest, but ties evidence to one node and offers no WORM guarantee.
- PostgreSQL large objects: transactional with metadata, but bloats backups and streams bytes through the app.
- Unlocked bucket with a deny-delete policy: works on cheaper providers, but immutability becomes policy rather than storage-enforced.

## Consequences

Backups split between the database and the bucket, and both are required for restore. A later capture never overwrites an object; it adds a new hash. Deleting a violation never deletes a blob another violation still cites.
