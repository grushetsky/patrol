# Notice submission: fields, limits, and acknowledgement signals

**Date:** 2026-11-03
**Ticket:** grushetsky/patrol#3
**Scope:** Google Search (DMCA legal removals), Microsoft Bing (content removal), Yandex (copyright infringement form).

## Question

What must a notice contain, how is it submitted, and how is its outcome observed for each
recipient? Specifically: intake channel and bulk path; required and optional fields; per-submission
and per-day limits and duplicate handling; acknowledgement/outcome signals and turnaround; whether
headless-browser automation is permitted and what anti-automation controls exist; and whether
historical evidence is accepted or a URL must be re-verified.

## Method

Primary sources only: each recipient's own help pages, legal policies, the live web forms (rendered
and inspected on 2026-11-03), and first-party client-side resources served by those forms. Where a
policy page was geo/captcha-gated, an Internet Archive snapshot of the same first-party page was
used and is cited as such. Anything not stated by a recipient is marked `[INFERENCE]`.

Two important framing facts:

- All three accept notices from an **authorized agent**, not only the rights holder itself
  ([G1], [G4], [M1], [Y1]). Patrol can therefore be the submitter, but it must be able to make the
  perjury/authority statements.
- **None of the three offers a public API for copyright removal.** All three are web forms (plus
  invitation-only bulk programs at Google, and an industry registry at Yandex).

---

## 1. Per-recipient field map

Legend: **R** = required, **O** = optional, **—** = not present.

| Field | Google Search (DMCA) | Bing content removal | Yandex copyright form |
|---|---|---|---|
| Intake | Web form at `reportcontent.google.com/forms/dmca_search`; Google account sign-in before starting [G3] | Web form at `bing.com/webmaster/contentremovalform`; anonymous submission path exists (`SubmitUrlAnon`), email still R [M2][M4] | Embedded Yandex Form (`forms.yandex.com/surveys/1773`) linked from the Copyright Notice Policy [Y1][Y2] |
| Product selector | Separate notice per Google product [G2] | Search Type: Web / Image / Video, R [M2] | "Type of Product Involved" (Web / Image / Video search), R [Y2] |
| Submitter name | Contact information R (email, physical address, or phone) [G1] | First name R, last name R; Reporting Organization O [M2] | First name R, last name R [Y2] |
| Rights-holder identity | Description/representation of the owner; agent must be authorized [G1][G4] | Full name of copyright owner R; country/region of owner R [M2] | "Name, address and contact details of the copyright holder you represent (or indicate that you act in your own name)" R [Y2] |
| Contact details | Email/address/phone R [G1] | Email R; **no postal address or phone field in the online form** (the legal page separately asks for them for email/mail notices) [M1][M2] | Country R, Address R, Telephone O, Email R [Y2] |
| Work identification | Description of the work R; representative list allowed for multiple works [G1] | Type of work R (Web only), Title O, Description R [M2] | Type, identification and description of the work R [Y1][Y2] |
| Authorized example of the work | Form collects an "authorised example" URL; the form rejects infringing URLs identical to it [G5] | "Authorized example of copyrighted work" page URL O [M2] | "Precise location (URL) of the authorized copy ... or specify that the work is not available online" R [Y2] |
| Infringing URL | Specific URL(s) R; homepage or Google search-result/cache URLs rejected [G1][G5] | Specific page URL(s) R, not a homepage; images require both Source Page URL and Source Image URL, and `bing.com`/`tse` URLs are rejected [M2] | Full URL of the page R, "not the search results link" [Y2] |
| Evidence / attachment | No evidence-upload field documented; the form has a URL-list file upload [G5] | Attachment(s) O: pdf, txt, docx, msg, xlsx, xls, 10 MB max [M2] | Files O: up to 10 files, 10 MB each [Y2] |
| Nature of infringement | Covered by the work description and the statements [G1] | Covered by Description R [M2] | Identification of the material and nature of infringement R [Y1][Y2] |
| Good-faith belief | R, exact statement [G1] | R checkbox, "Good Faith Belief" [M2] | R checkbox [Y2] |
| Accuracy / authority under penalty of perjury | R, exact statement [G1] | R checkbox, "Authority to Act" [M2] | R checkbox [Y2] |
| Liability acknowledgement | Not a separate field | R checkbox, "512(f) Acknowledgement" [M2] | Not a separate field |
| Signature | R; typed full legal name, must match the name at the top of the form [G1][G5] | R; typing full name is the electronic signature [M2] | R; "Signature (please provide your full name)" [Y2] |
| Date | Not a separate field | Not a separate field | R; format `DD.MM.YYYY` [Y2] |
| Consent to share with third parties/public | Not a separate field; Google publishes qualifying notices to Lumen [G4] | R acknowledgement that the notice may be shared with third parties/the alleged infringer [M2] | Policy states notices may be disclosed to third parties and the public [Y1] |
| Data-processing consent | — | — | R checkbox [Y2] |

### Notes that change the field model

- **Bing is one work per notice.** The form says: "If you are reporting infringement of multiple
  works, please submit a different notice for each work" [M2]. Google permits a representative list
  of works in one notice [G1]. Yandex has one work-description field and one infringing-URL field,
  so it is effectively one work and one URL per submission [Y2].
- **Yandex requires an authorized-copy URL** (or an explicit "not available online"), and also
  requires a date and a typed signature; Google and Bing do not date the notice [Y1][Y2].
- **Google requires a Google account** before the form can be started (observed sign-in gate on
  2026-11-03) [G3]. Bing explicitly supports anonymous submissions (the form calls
  `SubmitUrlAnon` when no session is present) [M4].
- Bing's legal page lists "full name, mailing address, phone number and, if available, an email
  address" as required notice elements [M1], but the online form only collects name, optional
  organization, owner name/country, and email [M2]. This is a documented inconsistency, not a form
  field.

---

## 2. Channels, bulk paths, and limits

| | Google Search | Bing | Yandex |
|---|---|---|---|
| Public channel | Web form; Google account | Web form; anonymous allowed | Web form (Yandex Forms survey 1773) |
| Email / post | Google's help does not present email as a submission channel for Search; the form is the documented route [G2] | `dmcaagnt@microsoft.com` and postal mail to the DMCA Agent, but Microsoft says the form is fastest [M1] | `copyright@yandex-team.ru`, fax, and postal mail to Yandex LLC (current policy); attachments are not accepted by email [Y1] |
| Bulk path | File upload of a URL list in the form; each line a URL or a `#` comment [G5]. Plus **TCRP**, an invitation-only program for high-volume, high-accuracy submitters: "thousands of notifications ... each day", bulk submissions and expedited review [G6][G7] | Bulk upload `.txt`: **1000 URLs maximum**; for images a tab-separated file with Source Page URL + Source Image URL, max 1000 lines [M2] | None public. One URL per form submission [Y2]. The Russian "Memorandum" registry is a separate industry channel: rights holders fill a link registry and Yandex removes registry links within hours [Y3]; participation is not a public self-serve path `[INFERENCE]` |
| Per-notice URL limit | Per-file URL cap enforced, value supplied by the server and not published; error: "The uploaded file exceeds the maximum of {0} URLs. Please split the URLs in this file into multiple requests." [G5] | 1000 URLs per bulk file; manual web textarea has no documented numeric cap [M2] | One URL field per submission; no repeatable URL control and no bulk upload [Y2] |
| Per-day quota | Daily URL quota and daily ticket quota enforced; error returns the remaining URL allowance: "Your remaining quota for today is only {0 URLs.}" [G5] | Daily content-removal quota enforced: "You have exceeded your daily content removal quota of {0} submissions." [M5] | Not documented |
| Duplicate handling | Duplicates are removed before submission; if nothing remains: "No new URLs were found in your submission. There are no URLs remaining after duplicate URLs were removed. Duplicate URLs may have been in this request or previous requests." Dashboard offers "Download duplicate details" [G5] | Resubmitting a URL already in flight is rejected: "Your submitted URL is already being processed. Please check status of your submission at a later time." [M5] | Not documented |
| Rate limiting | Submission-attempt limit and CAPTCHA; error "You have exceeded the max number of attempts and we can no longer proceed with your submission." [G5] | Custom anti-automation challenge and daily quota [M4][M5] | SmartCaptcha on Yandex support surfaces; no documented form-level quota [Y4] |

Google's `{0}` values are placeholders: the exact per-file and per-day numbers are server-side
configuration and are **not published** in Google's help center or in the client bundle. Any design
must treat them as runtime-discoverable, not constants. `[INFERENCE]` The public form is aimed at
ordinary rights holders; sustained high volume is expected to go through TCRP [G6].

---

## 3. Acknowledgement and outcome signals

| | Google Search | Bing | Yandex |
|---|---|---|---|
| Immediate acknowledgement | On-screen "Thanks! We've received your legal request" and a link to the Removals Dashboard [G5] | Redirect to `TicketDetails?ticketId=<id>`; the submit response carries `TicketId` [M4] | A Yandex Forms submission confirmation screen is expected, but the form configuration exposes no ticket id or status URL `[INFERENCE]` [Y2] |
| Case/reference number | Yes: "you will receive an email confirmation and a reference number" [G2] | Yes: `TicketId`, visible in the ticket-details URL [M4] | No published case number or reference ID `[INFERENCE]` |
| Email confirmation | Yes, to the contact email [G2] | Email is a required field, and Microsoft's process is email-based; a confirmation email is expected but not explicitly documented `[INFERENCE]` | Email is required; Yandex's policy says it will respond to compliant notices; email is the response channel [Y1] |
| Status page | Removals Dashboard, per-URL status, appeal per URL, "Not in index URLs", duplicate details [G5] | Ticket details page per ticket; Bing Webmaster Tools also shows "Copyright Removal Notices" to site owners, with counter-notice flow [M4][M5] | None published `[INFERENCE]` |
| Typical turnaround | "approximately 6 hours" average across all web-form Search requests [G4] | Not published. Microsoft publishes volume/acceptance statistics only [M3] | Not published. The separate Memorandum registry promises removal "within several hours" for registry links [Y3] |
| Adverse outcome / appeal | Per-URL decline visible in dashboard; site owners can file a counter-notification [G4] | Ticket status and site-owner counter-notice; Bing added webmaster visibility and an appeals process in 2017 [M7] | Policy reserves the right to contact the applicant for clarification; no formal appeal documented [Y1] |

Design consequence: Google and Bing give a durable external identifier per submission; Yandex does
not. For Yandex the only reliable correlation key is Patrol's own submission record plus the
recipient's reply email.

---

## 4. Automation: terms and anti-automation controls

| | Google | Microsoft/Bing | Yandex |
|---|---|---|---|
| Terms position | Prohibits "using automated means to access content from any of our services in violation of the machine-readable instructions on our web pages"; also prohibits "bypassing our systems or protective measures" [G8] | Code of Conduct prohibits "circumventing any restrictions on access to, usage, or availability of the Services (e.g., ... impermissible scraping)" and "automating inauthentic activity" [M8]; Bing/MSN materials are for "noncommercial, personal use only" [M8] | User Agreement: "Yandex may prohibit automatic requests to its servers as well as terminate acceptance of any automatically generated information" [Y4] |
| Anti-automation controls observed | Google account sign-in gate; reCAPTCHA Enterprise configuration in the form page; submission-attempt limit [G3][G5] | Custom `solveAntiAutomation` challenge returning `_aa_token` / `_aa_solution`, plus a honeypot field `_aa_honeypot` and an ASP.NET antiforgery token [M4] | Yandex SmartCaptcha on `yandex.ru`/`yandex.com` support surfaces (encountered while fetching the policy/form pages); Yandex Forms submission [Y2][Y4] |
| Public API | None for Search removals. TCRP is an invitation-only program with its own intake, not a public API [G6][G7] | None for content removal. Bing Webmaster APIs cover URL submission/indexing, not copyright removal `[INFERENCE]` | None |
| Practical verdict | Unattended headless submission is not permitted by the terms and is actively challenged. Treat as human-in-the-loop, or apply to TCRP for bulk [G6][G7] | Same: the form is bot-challenged and the terms prohibit circumvention. Human-in-the-loop unless Microsoft grants a partner channel `[INFERENCE]` | Same: captcha plus an explicit prohibition on automatic requests. Human-in-the-loop `[INFERENCE]` |

This does not prevent Patrol from *preparing* notices, computing field values, and driving a
human-operated browser session. It does prevent a cron job that logs in and posts notices headlessly
without recipient approval.

---

## 5. Historical evidence vs. re-verification

| | Google | Bing | Yandex |
|---|---|---|---|
| Accepts URLs not currently indexed? | **Yes, explicitly.** "As a matter of policy, Google accepts and processes DMCA notices for any URL, even those that are not in our Search index. We may crawl the page at a later date..." [G4] | Not stated. The copyright form only requires a valid URL; unlike Bing's separate *Content Removal Tool* for webmasters, it does not require a 404/410 or cached-text proof [M2][M5] | Not stated. The form requires a "precise location (URL)" and Yandex may contact the applicant to clarify [Y1][Y2] |
| Re-verification requirement | None documented. A URL that is not in the index at submission time is still processed [G4] | `[INFERENCE]` The notice is reviewed against the URL as served at processing time; no historical-evidence policy is published. Patrol should capture a timestamped snapshot itself | `[INFERENCE]` No published policy. Capture a timestamped snapshot and expect Yandex to check the live page |
| Evidence Patrol must retain | URL, work, timestamp, screenshot/hash; Google's own processing may happen later, so Patrol's snapshot is the only durable proof [G4] | URL, work, timestamp, screenshot/hash; Bing does not publish what it retains [M2] | URL, work, authorized-copy URL, timestamp, screenshot/hash; the form accepts attachments, which Patrol can use to supply the snapshot [Y2] |

---

## 6. What this means for the design

1. **Model a notice as `(recipient, product, work, [urls], statements, submitter)`**, not as one
   universal "DMCA notice". The recipients disagree on cardinality: Google allows a representative
   list of works and a URL file; Bing is one work per notice with up to 1000 URLs; Yandex is one URL
   per form.
2. **Bing is the batch-friendly public channel.** A single notice per work with a 1000-line `.txt`
   upload is the highest-throughput no-negotiation path. Google's public form also accepts a URL
   file but its caps are undisclosed and low enough to require chunking; Google's real bulk path is
   TCRP, which is invitation-only.
3. **Yandex cannot be batched.** One URL per submission, no public case number, and the current
   Copyright Notice Policy applies only to notices from rights holders in the US, EU, or
   Switzerland (IP-based) [Y1]. Confirm the rights holder's territory before building the Yandex
   channel; otherwise the applicable route may be Russian-law notices, which are out of scope here.
4. **Store the recipient's identifier.** Google reference number + dashboard URL; Bing `TicketId` +
   ticket URL. Without this, status polling is guesswork. Yandex has no identifier, so keep the
   exact submitted payload and the reply email thread.
5. **Deduplicate before submission.** Google silently removes duplicate URLs and can reject a
   submission that becomes empty. Bing rejects URLs already in flight. Both behaviours imply an
   idempotency key of `(recipient, normalized URL, work)` in Patrol's database.
6. **Do not build unattended headless submission.** All three terms prohibit automatic access or
   circumvention, and all three deploy active challenges (Google reCAPTCHA Enterprise + sign-in,
   Bing proof-of-work challenge + honeypot, Yandex SmartCaptcha). Build a "prepare and hand off"
   flow: generate the exact field values, open a human-controlled browser, and record the
   acknowledgement. If volume justifies it, pursue TCRP (Google) as a partner integration.
7. **Retain evidence independently.** Google explicitly processes URLs that are not in the index, so
   a later review may see a different page than Patrol saw. Patrol's own timestamped capture
   (screenshot + hash + HTTP metadata) is the evidence of record, not the recipient's state.
8. **Expect inconsistent contact requirements.** Bing's legal page requires a mailing address and
   phone, but its form does not collect them; Google requires only one contact channel; Yandex
   requires country, address, and email. Store a full contact profile per recipient and render only
   the fields that recipient's form actually shows.

## 7. Open risks

- Google's per-file and per-day limits, and the exact quota-reset behaviour, are server-configured
  and unpublished. They can change without notice; Patrol must parse the form's error text rather
  than hard-code thresholds.
- Bing's daily quota value is also server-supplied; public reports of the number vary and were not
  treated as authoritative here.
- Yandex's form and policy are geo- and captcha-gated; the live form (survey 1773) was inspected
  directly, but the surrounding help page was read from an Internet Archive snapshot. Yandex can
  change the survey without changing the policy URL.
- The Yandex policy's territorial limitation is decisive and easy to miss; a non-US/EU/CH rights
  holder may not be able to use this channel at all.
- Anti-automation implementations (reCAPTCHA Enterprise, Bing's challenge, SmartCaptcha) change
  frequently; any browser automation will be brittle even if it were permitted.
- TCRP admission is discretionary and requires a track record of accurate submissions; it is not a
  fallback for a new submitter [G7].
- None of the recipients publishes an SLA for Bing or Yandex; only Google publishes an average.

## 8. Citations

- **[G1]** Google, "What is copyright? — Copyright infringement notification requirements",
  https://support.google.com/legal/answer/3463239?hl=en
- **[G2]** Google, "Learn how to report content for legal reasons" (email confirmation, reference
  number, separate notice per product),
  https://support.google.com/legal-help-center/answer/13887279?hl=en
- **[G3]** Google, DMCA Search form (sign-in gate), https://reportcontent.google.com/forms/dmca_search
- **[G4]** Google Transparency Report, "Google Search removals due to copyright infringement FAQs"
  (6-hour average, not-in-index policy, Lumen, counter-notice, agents),
  https://support.google.com/transparencyreport/answer/7347743?hl=en
- **[G5]** Google DMCA Search form client resources: field validation, duplicate handling, file
  upload, quota and attempt-limit messages, served from
  https://reportcontent.google.com/forms/dmca_search (observed 2026-11-03)
- **[G6]** Google, "Understanding Google's different prioritised content flagger programs" (TCRP:
  thousands per day, bulk, invitation only),
  https://services.google.com/fh/files/misc/google_version_external_understanding_googles_different_prioritised_content_flagger_programs.pdf
- **[G7]** Google, "Trusted Copyright Removal Program Guidelines: Google Compute Engine" (admission,
  application, discretion), https://support.google.com/legal/answer/12022066?hl=en
- **[G8]** Google Terms of Service ("Don't abuse our services"),
  https://policies.google.com/terms?hl=en
- **[M1]** Microsoft, "Infringement Notices: Copyright and Trademark" (DMCA agent, required
  elements, Bing form link), https://www.microsoft.com/en-us/legal/intellectualproperty/infringement
- **[M2]** Microsoft Bing, "Notices of Infringement" form (fields, work-per-notice rule, 1000-URL
  bulk upload, image URL rules, statements, signature),
  https://www.bing.com/webmaster/contentremovalform/showcontentremovalform
- **[M3]** Microsoft, "Copyright Content Removal Requests" report (volumes, acceptance rate),
  https://www.microsoft.com/en-us/corporate-responsibility/copyright-removal-requests-report
- **[M4]** Bing content-removal form client code: `SubmitUrlAnon`, `TicketId` /
  `TicketDetails?ticketId=`, `solveAntiAutomation`, `_aa_token`/`_aa_solution`/`_aa_honeypot`,
  served from https://www.bing.com/webmaster/bundles/application.js via
  https://www.bing.com/webmaster/contentremovalform/showcontentremovalform (observed 2026-11-03)
- **[M5]** Bing Webmaster Tools help/resources: "daily content removal quota",
  "already being processed", copyright notice list/counter-notice strings, served from
  https://www.bing.com/webmasters/help/content-removal-cb6c294d (observed 2026-11-03)
- **[M7]** Bing Webmaster Blog, "Bing refines its copyright removals process" (webmaster visibility,
  appeals), https://blogs.bing.com/webmaster/2017/4/bing-refines-its-copyright-removals-process/
- **[M8]** Microsoft Services Agreement, Code of Conduct and "Bing and MSN" service terms,
  https://www.microsoft.com/en-us/servicesagreement/
- **[Y1]** Yandex, "Copyright Infringement Policy" (form URL, designated agent, required information,
  territorial scope, disclosure), https://yandex.ru/legal/copyright/en/
- **[Y2]** Yandex, "Abuse: Copyright Infringement" form (survey 1773): fields, required checkboxes,
  file limits (10 × 10 MB), signature and date; survey configuration observed 2026-11-03 at
  https://forms.yandex.com/surveys/1773/?lang=en&iframe=1
- **[Y3]** Yandex, "Protecting the interests of copyright holders" (Memorandum registry, removal
  within hours), https://yandex.ru/rightsholders (live page captcha-gated; Internet Archive snapshot
  2026-10-24 used: https://web.archive.org/web/20261024233138/https://yandex.ru/rightsholders)
- **[Y4]** Yandex, "User Agreement for Yandex Services", clause 3.1 (automatic requests prohibited),
  https://yandex.com/legal/rules/
- **[Y5]** Yandex, "A website in the search results contains content that violates my copyright"
  (search engine cannot remove third-party content; contact site/hosting),
  https://yandex.com/support/abuse/en/troubleshooting/search/copyright
- **[Y6]** Yandex Webmaster, "How do I remove pages from the search?" (site-owner tool; copyright
  removal is not the robot's priority; 500 URLs/site/day),
  https://yandex.com/support/webmaster/en/yandex-indexing/removing-from-index

### Archive note

The Yandex Copyright Notice Policy page `https://yandex.com/support/copyright-complaint/` was
captcha-gated from this network on 2026-11-03; the live form it embeds (survey 1773) was rendered
directly and is cited as [Y2]. The policy text is also reproduced at [Y1], which was readable. The
rightsholders registry page is cited from an Internet Archive snapshot [Y3] for the same reason.
