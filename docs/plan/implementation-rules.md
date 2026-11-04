# Implementation rules

Every threshold and rule a build effort must implement, compiled from the design documents. A rule lives canonically in its document; this file makes it testable and names where it is enforced. A row without an enforcement column entry is a product rule the build tests directly.

## Source legend

| Short name | Canonical document |
| --- | --- |
| Matching | "_docs/design/matching-and-classification-rules.md_" |
| Query strategy | "_docs/design/query-strategy.md_" |
| Acquisition routes | "_docs/design/serp-acquisition-route.md_" |
| Budget | "_docs/design/budget-envelope.md_" |
| Scheduling | "_docs/design/scan-scheduling.md_" |
| Evidence | "_docs/design/evidence-capture.md_" |
| Catalogue | "_docs/design/catalogue-entry.md_" |
| Notices | "_docs/design/notice-composition.md_" |
| Submissions | "_docs/design/submission-model.md_" |
| Authentication | "_docs/design/operator-authentication.md_" |
| Dashboard | "_docs/design/dashboard-ui.md_" |
| Deployment | "_docs/design/deployment-topology.md_" |
| Invariants | "_contract/INVARIANTS.md_" |

## Identity and access

| Rule | Testable statement | Enforcement | Source |
| --- | --- | --- | --- |
| Password policy | At least 12 characters, checked against a bundled breached-password list; no composition rules; no forced rotation. | Application guard; breach list at boot. | Authentication |
| Password hashing | Argon2id, 64 MiB memory, three iterations, one lane, per-user salt; rehash on sign-in when parameters change. | Application; migration on successful login. | Authentication |
| Second factor | TOTP, SHA-1, six digits, 30-second step, one step of drift; enrolled before the first session is usable. | Application; session refused until enrolment. | Authentication |
| Recovery codes | Ten single-use codes, stored only as hashes, shown once; a used code is deleted. | Database unique on the hash; single-use update. | Authentication |
| Sign-in rate | Ten failures per account trigger a 15-minute lock; per-IP attempts are throttled separately; both audited. | Application counter; `429 account_locked`. | Authentication |
| Session token | 256 random bits; only the SHA-256 is stored. | Database; token never logged. | Authentication |
| Cookie | `__Host-patrol_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`. | Response header. | Authentication |
| Session lifetime | Eight hours idle; seven days absolute. | Session row check on every request. | Authentication |
| Session rotation | A new token at sign-in and re-authentication; the old row is deleted. | Application transaction. | Authentication |
| Revocation triggers | Logout, password change, TOTP re-enrolment, email change, role change, and administrator disable all delete affected sessions. | Application; one transaction with the credential change. | Authentication |
| CSRF | Double-submit token on every state-changing request. | `X-Patrol-CSRF` parameter on every mutation; contract. | Authentication |
| Invitations | Single-use, valid 24 hours, stored only as a hash, revocable before use. | Database; `401 invitation_invalid`. | Authentication |
| Bootstrap | `patrol bootstrap` creates the rights holder and an invited administrator, prints a one-time token, is idempotent, and refuses once a rights holder exists. | CLI; database check. | Authentication |
| Setup gating | Domain endpoints answer `503 setup_required` until a rights holder and at least one administrator exist. | API middleware; contract. | Authentication |
| Roles | `Operator` reviews, edits the catalogue and allowlists, runs scans, and composes, approves, and files notices; `Administrator` additionally manages operators, invitations, the rights holder, signatory, recipient profiles, the budget, legal holds, and profile pauses. | `x-patrol-roles` per operation. | Authentication |

## Language

| Rule | Testable statement | Enforcement | Source |
| --- | --- | --- | --- |
| Interface languages | English and Russian, selected in the top bar. | `InterfaceLanguage`; UI catalogues. | Dashboard |
| Language resolution | A signed-in operator's stored preference wins; otherwise the request's `Accept-Language`; otherwise English. | API and SSR middleware. | Dashboard |
| Preference storage | The choice is stored on the operator account and applies across devices and to emails addressed to the operator. | `Operator.preferredLanguage`; `PATCH /auth/preferences`. | Dashboard |
| Translation scope | Every operator-facing string exists in both languages: screens, validation and error messages, alerts, invitation and reset emails, and the handoff checklist. | Key-parity test; `code` stays untranslated. | Dashboard |
| Never translated | Recipient-facing statements and resolved fields reproduce the recipient's form language; catalogue values keep their native strings; URLs and evidence are unchanged. | Pack builder; catalogue model. | Notices |
| Pack checklist | The operator-facing checklist is generated in the approving operator's language at approval and frozen on the submission as `packLanguage`; a later language change never rewrites the pack. | `Submission.packLanguage`; pack builder. | Notices |
| Pre-preference email | An invitation or setup email, sent before the account has a preference, is English. | Mailer. | Authentication |
| Tests | Automated tests and screenshot baselines fix English. | Test harness. | Dashboard |

## Catalogue and scope

| Rule | Testable statement | Enforcement | Source |
| --- | --- | --- | --- |
| Display title | The original-title variant's text is the display title; no second canonical string is stored. | Model; `originalVariantId` required. | Catalogue |
| Variant uniqueness | A variant's text is unique within its title after normalization. | `UNIQUE (tracked_title_id, normalized_text)`. | Invariants |
| Identifier uniqueness | An external identifier value is unique within its scheme. | `UNIQUE (scheme, value)`. | Invariants |
| Identifier shapes | Wikidata `Q` plus digits; IMDb `tt` plus at least seven digits; KinoPoisk digits. | Application validation on create. | Catalogue |
| Duplicate check order | External identifier equality first; then normalized original title, release year, and title type. Either blocks creation. | Application; `409 duplicate_title` with `existingTitleId`. | Catalogue |
| Merge guard | A duplicate may merge only while it has no candidate and no violation. | Application guard; `409`. | Catalogue |
| Merge effect | Variants and identifiers move to the survivor; the duplicate is archived with `mergedIntoTitleId`. | Application transaction. | Catalogue |
| Provenance | Title, variant, and identifier rows each record their source, actor, and time. | Model; columns. | Catalogue |
| Wikidata lookup | After three characters and a 300 ms pause, serial, contactable `User-Agent`, limit ten; no record is written until the operator saves. | Client and server; `503 upstream_unavailable` degrades to local. | Catalogue |
| KinoPoisk | Never read from its pages; a KinoPoisk identifier arrives as a fact from Wikidata or operator knowledge. | Application; no adapter exists. | Catalogue |
| Allowlist validity | `licensed_destination` requires a territory; `title_group` requires a title group and no title; `tracked_title` requires a title and no group. | Application; database checks. | Invariants |
| Allowlist precedence | Rights holder official domains, then global neutral sources, then learned entries, then reputation blocklists. | Matching order; blocklists never veto a per-URL match. | Matching |
| Allowlist before capture | An allowlisted URL becomes a candidate with the hit recorded and is never fetched. | Scheduler guard; no evidence row. | Evidence |

## Query plan and acquisition

| Rule | Testable statement | Enforcement | Source |
| --- | --- | --- | --- |
| Variants per locale | At most three, ordered original, localized, transliterated; a variant is eligible when its language matches the locale, except the original, which is always eligible. | Plan builder. | Query strategy |
| Intent phrases | Two per locale, each the display title plus a versioned intent phrase; phrases are editable configuration. | Plan builder; `IntentPhrase.version`. | Query strategy |
| Query deduplication | Queries deduplicate by normalized text within one plan; the same text is never issued twice. | Plan builder. | Query strategy |
| No operators | No query carries quotation marks or a search operator. | Plan builder; test rejects `site:`, `-`, quotes. | Query strategy |
| Length caps | Google 2,048 characters, Yandex 400; drop the intent phrase first, then truncate the variant at a word boundary. | Plan builder. | Query strategy |
| Google request | `depth` 20, two billable units per query; no second page. | Adapter; ledger. | Query strategy |
| Yandex request | `groupsOnPage` 30, `docsInGroup` 1, `groupMode` `FLAT`, one billable unit; no second page. | Adapter; ledger. | Query strategy |
| Locale mapping | `ru` defaults to Russia, `SEARCH_TYPE_RU`, region 225; `en` to the United States, `SEARCH_TYPE_COM`, no region; desktop; no freshness filter. | Adapter. | Query strategy |
| URL normalization | Drop the scheme; lowercase the host and drop a leading `www.` for the key; trim the trailing slash; remove `utm_*`, `fbclid`, `gclid`, `yclid`; sort the rest; drop the fragment. | Shared normalizer; unit tests. | Query strategy |
| Allowlist timing | Allowlisting applies after matching, never inside the query. | Plan builder. | Query strategy |

## Budget and quota

| Rule | Testable statement | Enforcement | Source |
| --- | --- | --- | --- |
| Acquisition cap | $60 a month: Google $48 (80,000 units at $0.60 per 1,000), Yandex $12 (48,000 at $0.25 per 1,000), Bing $0 until added. | Settings; ledger. | Budget |
| Billable units | Google depth-20 query = two units; Yandex request = one unit. | Ledger. | Query strategy |
| Bucket split | 70% of an engine allowance funds scans, 30% re-checks; the re-check share is not borrowable. | Ledger buckets. | Query strategy |
| Preflight | A scan prices its plan before starting; a plan that does not fit stays queued with `budget_exhausted` and is never truncated. | Scheduler transaction. | Scheduling |
| Reservation | Units are reserved in one transaction so concurrent scans cannot both spend the last of a bucket; an unstarted reservation expires after one hour. | `BudgetReservation`; expiry job. | Scheduling |
| Commit | A completed scan commits the units it issued; a partial scan commits what it issued and releases the rest; a failed or expired reservation releases everything. | Transaction on scan finish. | Scheduling |
| Alerts | 75% of the monthly allowance is a warning; 90% of a bucket is critical; 100% of a bucket queues new work; provider balance below 10% of the engine cap, or below one day's average burn where larger, is critical. Fire once per threshold per engine per month. | Alert job; dashboard. | Scheduling |
| Degradation order | Re-checks starve first; at 90% of the scan share low-priority groups stop; at 100% scheduled scans queue; manual scans still preflight, still use the same pool, and queue rather than skip. | Scheduler. | Budget |
| Ledger immutability | No endpoint deletes a ledger row; lowering a cap never un-spends committed units. | HTTP contract; database role. | Scheduling |

## Scheduling and re-checks

| Rule | Testable statement | Enforcement | Source |
| --- | --- | --- | --- |
| Engine queues | One pg-boss queue per engine, concurrency one. | Worker configuration. | Scheduling |
| Queue order | Manual scans first in request order; scheduled scans by priority high, normal, low; within a priority, least recently scanned; re-checks after manual work and before scheduled work. | Scheduler query. | Scheduling |
| Scan window | `scan_time` spreads inside 02:00–05:59 UTC by default, derived from the group's identity and editable. | `TitleGroup.scanTime`; scheduler. | Scheduling |
| Scan idempotency | A scan is unique on title group, engine, and due date; a manual scan marks the group scanned for that day. | `UNIQUE (title_group_id, engine, due_date)`. | Invariants |
| Job cadence | `scan.schedule` and `recheck.schedule` every 15 minutes; `submission.draft` daily at the profile window (default 07:00 UTC); `submission.remind` daily; `budget.rollover` on the first at 00:00 UTC; `budget.balance` daily; `route.probe` hourly while an engine is disabled; `retention.purge` daily. | pg-boss cron. | Scheduling |
| Query retries | Provider 5xx, timeout, or 429: three attempts at 1, 5, and 15 minutes with the sequence recorded. | Adapter; job retry. | Scheduling |
| Route disable | An authentication failure, revoked key, or empty provider balance disables the engine; an hourly probe checks recovery. | Adapter; `route.probe`. | Scheduling |
| Re-check ladder | 3, 7, and 14 days after the scan that started it, then every 14 days while any violation from the pair is open; stop when none is open. | `RecheckSchedule`. | Scheduling |
| Manual reset | A manual scan or re-check resets the ladder to rung one, due three days after the manual run. | Scheduler. | Scheduling |
| Submission retries | No scheduler retries a submission; the operator re-files the same row, and the attempt count rises. | HTTP contract. | Scheduling |

## Evidence capture and retention

| Rule | Testable statement | Enforcement | Source |
| --- | --- | --- | --- |
| Capture bundle | Redirect chain, final URL and host, headers without `Set-Cookie`, `Cookie`, or `Authorization`, raw body, rendered DOM, full-page screenshot, viewport thumbnail, extraction sidecar, capture profile, and per-artifact SHA-256. | Worker. | Evidence |
| Ceilings | 25-second navigation budget, `load` plus a two-second settle, 45-second total, 10 MB DOM, 16,000-pixel screenshot height; exceeding a ceiling sets `truncated`, never a silent partial. | Worker. | Evidence |
| Blocked resources | Media, websocket, service-worker, advertising, and third-party analytics requests are blocked; fonts and stylesheets are allowed. | Worker. | Evidence |
| Capture points | `detection` always; `review` when the newest live capture is over 24 hours old; `pre_handoff` when the newest live capture is over 7 days old. | Scheduler. | Evidence |
| Outcomes | `captured`, `dead`, `blocked`, `error`; `dead` and `blocked` still record metadata, with no blobs unless a body was returned. | Model. | Evidence |
| Retries | `dead` and `captured` never retry; `blocked` and `error` retry up to three attempts with backoff inside 24 hours. | Worker. | Evidence |
| One fetch per point | One capture per URL per capture point; bytes deduplicate by content hash. | Unique key; object keys. | Evidence |
| Politeness | At most one capture per host at a time, short same-host spacing, a handful of concurrent captures overall. | Worker limiter. | Evidence |
| Host objection | An objection suspends every capture of the host until an operator clears it; the objection is never deleted. | `HostObjection`; `UNIQUE (host) WHERE cleared_at IS NULL`. | Evidence |
| Immutability | Append-only evidence rows, content-addressed blobs, version-pinned reads and deletes, pinned citations, hashes in PostgreSQL and object metadata. | Database roles; Object Lock. | Evidence |
| Retention | Evidence cited by an open violation or a live notice: indefinitely. Closed citations: five years after the later of closure and the last citing submission. Never cited: twelve months after the last review decision or capture. Raw SERP payloads Patrol owns: 90 days. | Retention job. | Evidence |
| Legal hold | A hold suspends every purge path until released; the release is recorded with its operator and reason. | Retention job; `LegalHold`. | Evidence |
| No probes outside the bundle | No SERP page fetched or stored; no page media downloaded; no login, paywall, challenge, or DRM circumvented. | Worker. | Evidence |

## Matching, scoring, and review

| Rule | Testable statement | Enforcement | Source |
| --- | --- | --- | --- |
| Normalization | NFKC, full case fold, diacritic folding that keeps the native string, punctuation and whitespace collapse, a per-language article-less key, and a declared transliteration scheme. | Shared normalizer. | Matching |
| Title match | Exact variant 0.70; partial or slug 0.60; none 0.00. An exact match equals or contains the variant as a complete token sequence in the page title, `h1`, or structured-data name. | Scorer. | Matching |
| Signals | `player`, `duration` (±10% of runtime), `download`, `release`, `episodes`, as defined in the matching document; a signal that cannot be evaluated contributes nothing. | Scorer. | Matching |
| Signal weight | First strong signal +0.25; each additional +0.05; total capped at 0.30. | Scorer. | Matching |
| Reputation | At the registrable domain over 12 months: 1–2 violations +0.02, 3–9 +0.05, 10 or more +0.10; a blocklist hit +0.02; total capped at 0.10 and applied only alongside at least one strong signal. | Scorer. | Matching |
| Score | `min(1, title + signals + reputation)`. | Scorer. | Matching |
| Bands | A at 0.95 or above (one-click approval), B at 0.70–0.949 (review), C below 0.70 (suppressed and logged); boundaries configurable per engine. | Scorer; configuration. | Matching |
| No auto-confirmation | No score confirms a violation; every violation comes from a review decision. | Application guard. | Matching |
| Allowlist suppression | An allowlist hit prevents confirmation regardless of score and routes the row to allowlist review. | Transition guard; `409`/`422`. | Matching |
| Queue order | Score descending, then SERP rank ascending, then observation time descending. | Query; contract. | Dashboard |
| Dismissal scope | A dismissal suppresses one URL and tracked-title pair only. | Unique dismissal record. | Matching |
| Reopening | Operator reopen, or material change: a new strong signal, an expanded episode range, or a different landing registrable domain; a `page_dead` pair reopens when a capture returns content. | Worker and operator action. | Matching |

## Violations

| Rule | Testable statement | Enforcement | Source |
| --- | --- | --- | --- |
| Identity | Keyed by URL and tracked title; a page hosting several titles yields one violation per title, sharing evidence. | `UNIQUE (normalized_url, tracked_title_id) WHERE state = 'open'`. | Invariants |
| Host | The landing page's final host; fall back to the submitted host with `hostSource` recorded. | Model. | Invariants |
| Removal | Recorded when a capture shows the URL gone; the newest capture and the closure reason are retained. | Worker/app. | Evidence |
| Closure | An operator closes after a re-check, with a note; `removed` and `closed` are terminal. | State guard; `409`. | Invariants |
| Reappearance | A URL that reappears starts a new violation with `predecessorViolationId`; the closed record is never reopened. | Unique partial index; state guard. | Invariants |
| Evidence citation | Every violation cites at least one capture; citations are pinned; a dead newest capture flags rather than drops. | Application; handoff pack. | Invariants |

## Notices and submissions

| Rule | Testable statement | Enforcement | Source |
| --- | --- | --- | --- |
| Grouping | Google: many works, at most 500 URLs by default, lowered to the server-discovered `max_urls_per_file`. Bing: one tracked title, at most 1,000 URLs. Yandex: one violation, one URL. | Draft composer. | Notices |
| Reservation | A draft reserves its cited violations immediately; a second draft citing them is refused. | Application; `409 violation_reserved`. | Notices |
| Deduplication | `(recipient profile, normalized URL, tracked title)` is unique among notices that are not withdrawn, superseded, rejected, or failed. | Database unique index. | Invariants |
| Composition triggers | Scheduled: a per-profile daily window, default 07:00 UTC, composing drafts for violations confirmed since the previous window; on demand: an operator selects violations and composes immediately. A window is a cut-off, not a rolling queue. | Job; HTTP. | Notices |
| Approval | Freezes content, snapshots the rights holder, signatory, and recipient profile, queues `pre_handoff` captures for URLs whose newest live capture is over seven days old, and creates one pending submission when the captures settle. | Transaction; `ApprovalAttestation`. | Notices |
| Withdrawal | Allowed for a draft, or an approved notice whose submission is pending; not after delivery or acknowledgement. | State guard. | Notices |
| Supersession | An approved notice becomes superseded, its pending submission is cancelled, and a replacement draft carries the corrected set. No approved notice is edited. | State guard; transaction. | Notices |
| Pack | `notice.html`, `fields.json`, the upload file where one applies, `handoff.md`, and capture flags; content-addressed and never regenerated with different content. | Pack builder; object store. | ADR 0020 |
| Second-operator check | The first five notices a profile produces are approved by a second operator where two exist. | Operational control; recorded. | Notices |
| Rejection note | A rejected submission requires a note naming the cause, and the offending violation needs a review decision before it is cited again. | HTTP `422`; application. | Notices |
| Profile pause | A profile whose rejected plus failed share exceeds 10% over its last twenty submissions pauses scheduled drafting; on-demand drafting stays available; an administrator clears the pause. | Application; `POST /settings/recipient-profiles/{id}/clearance`. | Notices |
| Submission uniqueness | One submission per notice; a retry reuses the row and raises `attemptCount`. | `UNIQUE (notice_id)`. | Invariants |
| Submission transitions | Pending → delivered with an attestation; pending → acknowledged with the recipient's identifier; pending → rejected or failed with a reason and note. | State guard. | Invariants |
| Acknowledgement shapes | Google: reference number of 4–40 characters plus the Removals Dashboard URL. Bing: `TicketId` plus the ticket-details URL. Yandex: reply `Message-ID` plus date. | HTTP union per recipient. | Notices |
| Contact rule | No scheduled process contacts a recipient; every submission names an operator. | No adapter exists; contract. | ADR 0014 |

## Notice templates

| Rule | Testable statement | Enforcement | Source |
| --- | --- | --- | --- |
| Identifier | `<recipient>.<language>.v<major>@<hash12>`, with the recipient slug, form language, major revision, and the first twelve hex characters of the canonical set hash. | Registry; contract `templateVersion`. | Notices |
| Hash canonicalisation | SHA-256 over a UTF-8 JSON array of ordered `{key, text}` objects; each text NFC, trimmed, whitespace runs collapsed; keys are Patrol's, not display labels; interpolated values excluded. | Registry; fixture test. | Notices |
| Set version | `NoticeContent.templateVersion` and every `NoticeStatement.templateVersion` carry the same set identifier; per-statement versions are refused. | Application; contract. | Notices |
| Approval gate | Approval is refused when the template is older than ninety days, a newer revision exists, or no verified template exists for the recipient and language. | Approval guard; `409`. | Notices |
| Verification | The approving operator opens every source URL in a browser and confirms the text through the `currentStatements` attestation; approval stamps the verifier and time. | `NoticeTemplateSummary`; approval. | Notices |
| Freeze | An approved notice keeps its identifier and statements; a later revision never rewrites it, and a draft under an older template is re-composed. | Immutable notice content. | Notices |
| Re-read cadence | Every source is re-read before a release that changes notice rendering and at least quarterly; the access date is recorded. | Release checklist; registry. | Notices |
| Fixture drift | A checked-in fixture per identifier holds the ordered statements and expected hash; a unit test recomputes it. | CI. | Notices |
| Recipient wording | Google combines accuracy, perjury, and authority in one statement; Bing splits authority and adds a separate 512(f) acknowledgement; Yandex adds a required data-processing consent and a date. Patrol reproduces each recipient's own split and never invents a statement for another. | Registry content. | Notices |
| Form language | Google follows the published localized text; Bing and Yandex are English only in the observed channel; Yandex eligibility is limited to US, EU, or Swiss rights holders. | Registry; profile eligibility. | Notices |

## Dashboard

| Rule | Testable statement | Enforcement | Source |
| --- | --- | --- | --- |
| Counters | Open violations, candidates to review, notices on file, acknowledged submissions; draft notices for the section badge. | Read model. | Dashboard |
| Engine row | Google, Bing, Yandex with a quota badge on an exhausted bucket; one exhausted engine never blocks another. | Read model. | Dashboard |
| Activity feed | Five most recent scans, review decisions, approvals, and acknowledgements with relative time and a notice link. | Read model. | Dashboard |
| Tracked titles metric | Every tracked title not paused on that day; a step count; groupings none or title group. | Chart query. | Dashboard |
| Titles with violations metric | Each tracked title once per day when it has at least one open violation that day, where open means detected on or before the day and not resolved on or before it; engine grouping counts once per engine; groupings none, group, engine. | Chart query. | Dashboard |
| Resolved violations metric | Violations that left the open state on that day; groupings none, group, engine, recipient. | Chart query. | Dashboard |
| Window and basis | 7, 14, or 30 days ending today, default 14; resolved basis removed plus closed by default, or closed only. | Chart query; contract. | Dashboard |
| Fallback | An inapplicable grouping falls back to the total and reports `requestedGrouping`, `appliedGrouping`, and `groupingFallback`. | Contract; UI hint. | Dashboard |
| Tiles | Tracked titles: current, paused, group count. Titles with violations: today, groups affected, peak. Resolved: total, removed, closed. | Read model. | Dashboard |
| Day boundary | UTC, matching the ledger's months. | Chart query. | Dashboard |

## Platform

| Rule | Testable statement | Enforcement | Source |
| --- | --- | --- | --- |
| Topology | ECS Fargate API, worker, and SSR in `eu-central-1` behind one ALB; `/api/*` to the API, everything else to the SSR app; `/health` per service and a queue heartbeat for the worker. | Infrastructure. | Deployment |
| Environments | Local Compose, staging with forward-only migrations and a low cap, production. | Infrastructure. | Deployment |
| Migrations | Forward-only numbered Drizzle SQL; a destructive change spans two releases; the API and worker refuse to start when the schema and image disagree. | Startup check. | ADR 0028 |
| Deploy order | Snapshot, run the `migrate` task from the same image, roll API, worker, then SSR; drain the worker rather than killing a scan. | Pipeline. | ADR 0028 |
| Backups | Point-in-time recovery for 14 days, nightly logical dump retained 35 days, both in-region. | RDS configuration. | Deployment |
| Recovery | Five-minute RPO, four-hour RTO; a quarterly restore drill into a scratch stack, including one evidence fetch. | Runbook. | Deployment |
| Secrets and egress | Secrets Manager for credentials; one static datacenter egress with no residential proxies. | Infrastructure. | Deployment |
| Cost | About $150–200 a month of infrastructure, separate from the $60 acquisition cap. | Billing review. | Deployment |
| Contract verification | `npm run check` and `npm run verify` pass before a deployment that changes the contract. | CI. | "_contract/HTTP.md_" |
