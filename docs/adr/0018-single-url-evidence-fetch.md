# Evidence capture is a single-URL evidentiary fetch that ignores robots.txt

Discovery surfaces a URL; Patrol fetches that one landing page to see what it serves. The fetch presents an identifiable user agent naming Patrol and the rights holder's contact URL, follows no links, enumerates no site, authenticates nowhere, circumvents no paywall, challenge, or DRM, retrieves no torrent or magnet payload, and consults no `robots.txt`. Allowlisted URLs are checked before the fetch and are never fetched at all.

## Considered options

- **Honour `robots.txt`**: disallow rules are ubiquitous on the hosts that matter, so discovery would surface copies that Patrol then refuses to document — a monitor that cannot evidence what it found.
- **Honour `robots.txt` during traversal only**: a compromise that requires a traversal path no feature needs; the ticket that settles this design found no crawler in the product.
- **Rotate proxies or user agents past a block**: effective against hostile hosts, and an evasion posture that would undermine the enforcement case the evidence is meant to support. A block is recorded as `blocked` and retried unchanged.
- **Capture with a generic browser user agent**: blends in, but hides Patrol's identity from the host it is reporting, which is exactly the conduct a challenge to the evidence would seize on.
- **Keep capturing after an individualized objection**: one more capture would often succeed, and continued access after a personal cease-and-desist is precisely the conduct that turns permitted access into access without authorization.

## Consequences

- A `robots.txt` disallow is not treated as a prohibition on a single evidentiary fetch, and the reasoning is recorded here so a later reader does not mistake the omission for an oversight.
- Blocked and failing captures are retried three times with backoff and never with a different posture; the attempt rows show refusals rather than one unexplained absence.
- Because the fetch is unambiguous about who it is and what it does, its legality rests on the enforcement purpose rather than on disguising the access.
- A host's individualized objection — a cease-and-desist, a block notice, or an abuse complaint naming Patrol — suspends capture for that host, is recorded with the objection, and surfaces the affected candidates to an operator; only an operator's explicit decision reopens it.
- Allowlist checks precede capture, so official domains and licensed destinations are never fetched; the review queue must render allowlist rows without thumbnails.
- None of the three recipients requires the capture, so the posture is chosen for lawful documentation rather than for a submission requirement.
