# Patrol runs on AWS Fargate, RDS for PostgreSQL, and S3 with Object Lock

Patrol's three deployables — the Fastify API, the worker, and the TanStack Start SSR app — run as ECS Fargate services in `eu-central-1` behind one Application Load Balancer, with RDS for PostgreSQL 18, S3 with versioning and Object Lock in compliance mode for evidence, Secrets Manager for credentials, ECR for images, and CloudWatch for logs and alarms.

## Considered options

- **A PaaS (Fly.io, Render, Railway) with a managed Postgres and R2 or B2.** Cheaper and faster to stand up, and it splits three concerns across three vendors; R2 and B2 offer weaker or later Object Lock semantics than S3, and the evidence design needs storage-enforced immutability rather than a policy.
- **Google Cloud Run with Cloud SQL and GCS bucket lock.** Comparable cost and scale-to-zero, and it moves every existing S3-shaped decision in the design onto a second vendor's object-lock model, with no benefit for a service that is never idle.
- **EC2 with Docker Compose.** Cheapest raw compute, and it hands the rights holder a patching, failover, and backup job the design would have to document.
- **Kubernetes.** The right answer at a scale this service will not reach, and an operational surface with no matching benefit.

## Consequences

- One account, one IAM boundary, and one bill; the task role scopes each service to the secrets and bucket prefixes it needs.
- The evidence bucket gets S3's compliance-mode Object Lock, which cannot be shortened after the fact and is therefore the strongest form of the immutability the design promises.
- RDS provides point-in-time recovery and Multi-AZ failover without a database operator, and its PostgreSQL 18 line is the same version the design targets locally.
- There are three services to deploy, one migration task, and an ALB, which is more moving parts than a single container host; the deployment order in "_docs/design/deployment-topology.md_" makes that routine.
- The infrastructure is code in a separate repository, so the first commit of that repository belongs to the build effort rather than this map.
- The monthly infrastructure estimate of $150 to $200 is dominated by Fargate tasks, the Multi-AZ database, and the NAT gateway; a scale-to-zero PaaS would be cheaper and would not carry the same storage guarantees.
