# A violation's host is the destination host, not the submitted host

Search results often point at shorteners and redirect chains, while the copy is served at the final landing page. Patrol derives a violation's host from the landing page's final URL, keeps the submitted URL and the full redirect chain, and falls back to the submitted URL's host with a recorded source when the landing page cannot be reached. A host is the full hostname; its registrable domain (eTLD+1) aggregates reputation across subdomains without merging unrelated sites on shared platforms.

## Considered options

- The submitted URL's host: consistent with what the recipient removes, but attributes shortener transport as infringement and hides the real host.
- Recording both hosts: more faithful, but creates two owners for one invariant and an ambiguous unit of reputation.
- The registrable domain only: simpler aggregation, but `blogspot.com` or `wordpress.com` would become one host for unrelated pages.

## Consequences

Shorteners are not penalised as copy hosts, and subdomain rotation still aggregates at the registrable domain. Unreachable landing pages are visible through the recorded host source.
