# Recipient statement texts and template versions

**Date:** 2026-11-04
**Ticket:** Recipient statement texts and template versions
**Scope:** Google Search (DMCA legal removals), Microsoft Bing (content removal), Yandex (copyright infringement form).

## Question

What exact statement text does each recipient require, in which language, and how should Patrol
version that text so that `NoticeContent.templateVersion` and `NoticeStatement.templateVersion`
identify the text an operator actually approved?

## Method

Primary sources only: each recipient's own legal/help pages, the live form HTML and rendered form UI,
and first-party client resources served by those forms, all read on 2026-11-04. The Google DMCA form
is behind a Google sign-in wall, so its UI could not be observed; Google's published help-center
statements are used instead and the form-level gap is marked `[INFERENCE]`. The Bing form is
server-rendered HTML and its statement checkboxes are directly observable. The Yandex form is a
JavaScript Yandex Forms survey; it was rendered in a browser (English and `?lang=ru`) and its
question and checkbox text was read from the DOM.

Verbatim text below preserves the recipient's punctuation, including typographic apostrophes where
the source uses them. Quotation marks are not part of the statement text unless shown.

## Source map

| Recipient | Form URL | Policy / help URL | Language observed |
|---|---|---|---|
| Google Search | `https://reportcontent.google.com/forms/dmca_search` [G3] | `https://support.google.com/legal/answer/3463239?hl=en` [G1]; `https://support.google.com/transparencyreport/answer/7347743?hl=en` [G2] | English; help article localized (German checked) [G5] |
| Bing | `https://www.bing.com/webmaster/contentremovalform/showcontentremovalform` [M2] | `https://www.microsoft.com/en-us/legal/intellectualproperty/infringement` [M1] | English (US) only |
| Yandex | `https://forms.yandex.com/surveys/1773/?lang=en&iframe=1` [Y3] | `https://yandex.ru/legal/copyright/en/` [Y1]; `https://yandex.ru/support/copyright-complaint/en/` [Y2] | English only; form chrome localizes, questions do not |

All URLs and all quoted text were accessed on **2026-11-04**.

## 1. Google Search (DMCA)

Google publishes the required statements in the copyright help article, not in a downloadable
template [G1]. The live form starts with a sign-in gate ("Sign in to get started", "Continue with
Google"), so no statement text was observable in the form itself [G3].

| Statement key | Verbatim text or citation | Language | Status |
|---|---|---|---|
| `google.good_faith_belief` | “I have a good faith belief that use of the copyrighted materials described above as allegedly infringing is not authorized by the copyright owner, its agent, or the law.” [G1] | English | Published in help; form UI unverified `[INFERENCE]` |
| `google.accuracy_perjury_authority` | “The information in this notification is accurate and I swear, under penalty of perjury, that I am the copyright owner or am authorized to act on behalf of the owner of an exclusive right that is allegedly infringed.” [G1] | English | Published in help; form UI unverified `[INFERENCE]` |
| `google.512f_acknowledgement` | Not published as a separate statement. The perjury/authority statement above is the only affirmation in the help article [G1]. | — | Not present as a separate statement; form UI unverified `[INFERENCE]` |
| `google.third_party_sharing` | No consent checkbox is documented. Google says it shares “a copy of qualifying copyright removal requests with the public site Lumen” [G2]. | — | Publication practice, not a required acknowledgement |
| `google.data_processing_consent` | Not published as a statement; the help page links Google's Privacy Policy [G4]. | — | Not present |
| `google.signature` | “Complete complaints require the physical or electronic signature of the copyright owner or a representative authorized to act on their behalf. To satisfy this requirement, you may type your full legal name to act as your signature at the bottom of your complaint.” [G1] | English | Published instruction; required field |

**Notes.**

- Google's published wording combines accuracy, penalty of perjury, and authority in one statement;
  Patrol must not split it into a Bing-style “Authority to Act” plus separate accuracy text.
- Google publishes the statements in localized help articles. The German rendering translates both
  statements [G5], so a German form template must use the German published text, not an English
  string with a German label. `[INFERENCE]` The form renders the statements in the account/`hl`
  language, matching the localized help article; the sign-in wall prevented direct confirmation.
- Google's form requires a Google account before the notice can be started [G3]; this research did
  not attempt to sign in.
- The help article publishes no form-field keys. The keys above are Patrol's own stable keys.

## 2. Bing content removal

Bing's legal page states the notice requirements [M1]; the form itself renders the operative
checkboxes and the third-party sharing sentence [M2]. The form's statement text is more specific than
the legal page's summary, so the form text is the rendering source of truth.

| Statement key | Verbatim text or citation | Language | Status |
|---|---|---|---|
| `bing.good_faith_belief` | “By typing in my name (electronic signature), I state that I have a good faith belief that the use of the material is not authorized by the intellectual property owner, its agent, or the law (e.g., it is not fair use).” [M2] | English | Observable form HTML; required checkbox |
| `bing.authority_to_act` | “I represent that the information in the notification is accurate and, under penalty of perjury, that I am authorized to act on behalf of the owner of an exclusive right that is allegedly infringed.” [M2] | English | Observable form HTML; required checkbox |
| `bing.512f_acknowledgement` | “As applicable under 17 U.S.C. 512(f), I acknowledge that I may be subject to liability for damages if I knowingly materially misrepresent that material or activity is infringing.” [M2] | English | Observable form HTML; required checkbox |
| `bing.third_party_sharing` | “I understand that the information submitted in this form may be shared with third parties or the public, including the alleged infringer about whom I am filing this complaint.” [M2] | English | Displayed in “Required statements”; no checkbox |
| `bing.data_processing_consent` | Not present. The form links Microsoft's privacy statement only [M2]. | — | Not present |
| `bing.signature` | Field label “Signature”; required. The good-faith statement defines typing the name as the electronic signature [M2]. | English | Required field |
| `bing.date` | No date field or date statement [M2]. | — | Not present |

**Notes.**

- The legal page's shorter variants are: “I have a good faith belief that use of the material is not
  authorized by the copyright owner, its agent, or the law.” and “Under penalty of perjury, the
  information in this notification is accurate and that I am the copyright owner, or am authorized
  to act on behalf of the owner, of an exclusive right that is allegedly infringed.” [M1] The form
  version says “intellectual property owner” and adds “(e.g., it is not fair use)”. Patrol must
  render the form version, because that is the text the signatory actually accepts.
- The sharing sentence sits inside the “Required statements” section but has no checkbox and no
  `mustselect` marker [M2]. `[INFERENCE]` Submitting the form therefore records the disclosure but
  not a separate, independently toggled consent.
- The form is English (US) only: `?mkt=de-DE`, `?lang=de`, and `?cc=de` all returned the same
  English statement labels [M2]. The country selector changes the copyright owner's country, not the
  form language.
- Bing's legal page also says Microsoft “may provide your notice of infringement to third parties,
  including the alleged infringer” [M1], consistent with the form sentence.

## 3. Yandex copyright form

Yandex's policy states the legal requirements [Y1]; the support page repeats them and adds the
disclosure sentence [Y2]; the embedded survey supplies the form-level wording and the separate
data-processing consent [Y3]. The survey content is English even when the form chrome is Russian
(`?lang=ru` localized “Required”, “Upload”, and “Send” but left every question and statement in
English) [Y3].

| Statement key | Verbatim text or citation | Language | Status |
|---|---|---|---|
| `yandex.good_faith_belief` | “By submitting this notice and signing with your digital signature below, you confirm that you have a good faith belief that the use of the material in the manner complained of is not authorized by the copyright owner, its agent, or the law.” [Y3] | English | Observable form UI; required checkbox |
| `yandex.accuracy_perjury_authority` | “You further confirm that the information in this notification is accurate and, under penalty of perjury, that you are authorized to act on behalf of the owner of an exclusive right that is allegedly infringed.” [Y3] | English | Observable form UI; required checkbox |
| `yandex.data_processing_consent` | “I hereby consent to the processing of the personal data provided above for the purpose of reviewing the application and getting feedback. I am aware of my right to withdraw the consent via address mentioned above.” [Y3] | English | Observable form UI; required checkbox |
| `yandex.512f_acknowledgement` | Not present [Y1][Y3]. | — | Not present |
| `yandex.third_party_sharing` | No consent checkbox. The support page says “we reserve the right to disclose your notices to third parties (including the alleged infringer), as well as to the public in general” [Y2]. | English | Published disclosure, not a required acknowledgement |
| `yandex.signature` | “Signature (please provide your full name)” [Y3]; policy requires “Your signature and date of the notice” [Y1]. | English | Required field |
| `yandex.date` | “Date (Format:DD.MM.YYYY)” [Y3]; policy requires the date of the notice [Y1]. | English | Required field |

**Notes.**

- The policy's own wording differs slightly from the form: “By submitting the notice and signing
  with my signature, I confirm that I have a good faith belief…” and “I confirm that the information
  in this notification is accurate, and under penalty of perjury, that I am authorized to act…”
  [Y1]. The form uses “your digital signature below” and “You further confirm”. Patrol should render
  the form text, because that is what the operator sees and accepts, while keeping the policy text as
  the legal citation.
- The data-processing consent sentence is a required checkbox in the form [Y3]; the policy does not
  reproduce it. The form links `https://yandex.com/legal/confidential/` for details [Y3].
- **Territory and language.** The policy is available only to IP addresses in the United States, EU
  member states, or Switzerland, and applies only to notices from right holders residing or
  registered there [Y1]; the support page repeats the gate [Y2]. The legal page's embedded metadata
  lists `docLangs:["en"]` and no document version (`docVersion:null`), and the page served English
  from this network [Y1]. `[INFERENCE]` The form's statement text therefore does not change by
  territory inside the US/EU/CH set; a rights holder outside that set is routed to a different,
  Russian-law process that is out of scope here, and no Russian-language version of these statements
  was observed.
- The form accepts one URL per submission and requires the authorized-copy URL, but those are field
  requirements, not statements [Y3].

## 4. Cross-recipient matrix: what Patrol must render

| Concept | Google Search | Bing | Yandex | Patrol rendering requirement |
|---|---|---|---|---|
| Good-faith belief | Required, one published sentence [G1] | Required checkbox, longer form wording [M2] | Required checkbox, “digital signature” wording [Y3] | Render each recipient's own text; never reuse one recipient's sentence for another. |
| Accuracy + penalty of perjury + authority | Combined in one sentence [G1] | Split into “Authority to Act” [M2] | Combined in one sentence [Y3] | Preserve the recipient's split/combination; do not normalise across recipients. |
| 17 U.S.C. 512(f) acknowledgement | Not separate [G1] | Required checkbox [M2] | Not present [Y1][Y3] | Render only for Bing; do not invent it for the others. |
| Third-party/public sharing | Google publishes qualifying notices to Lumen; no checkbox [G2] | Displayed sentence, no checkbox [M2] | Policy disclosure, no checkbox [Y2] | Show the recipient's disclosure where it exists; do not turn a disclosure into a consent checkbox. |
| Data-processing consent | Not a statement [G4] | Not present [M2] | Required checkbox [Y3] | Render only for Yandex, including the privacy-policy URL. |
| Signature | Typed full legal name [G1] | Typed name is the electronic signature [M2] | Full name [Y3] | Render a signature field whose value is the frozen signatory's full legal name. |
| Date | No date [G1] | No date [M2] | Required `DD.MM.YYYY` [Y3] | Render the notice date only for Yandex. |
| Language | English source; localized editions exist [G5] | English only [M2] | English only [Y1][Y3] | Template key includes language; unsupported language blocks composition rather than falling back silently. |
| Form URL | Sign-in-gated form [G3] | Server-rendered form [M2] | Embedded survey [Y3] | Store the observed form URL in the profile snapshot; re-check it with the text. |

## 5. Versioning recommendation

### 5.1 Identifier shape

Use one identifier for the whole statement set, carried by both `NoticeContent.templateVersion` and
every `NoticeStatement.templateVersion` in that notice:

```
<recipient>.<language>.v<major>@<hash12>
```

- `<recipient>`: `google-search`, `bing`, or `yandex`.
- `<language>`: lowercase BCP 47 (`en`, `de`, `ru`). Only languages a recipient actually publishes
  get an identifier.
- `<major>`: a positive integer bumped when the set's shape, field map, or legal meaning changes — a
  statement is added, removed, or re-keyed, a field label or requiredness changes, or legal review
  re-approves the set.
- `<hash12>`: the first 12 lowercase hex characters of SHA-256 over the canonical statement set.

The hash is computed over the `NoticeStatement` rows only, in form order, as a JSON array of
`{"key":...,"text":...}` objects, UTF-8, no insignificant whitespace, after normalising each text
with Unicode NFC, trimming, and collapsing every whitespace run to one space. Keys and case are
preserved. Interpolated values (signatory name, date) are not hashed. Signature and date field labels
are fields, not statements, and are excluded from the hash; they are still versioned by the same
template row, so a label-only change creates a new revision and bumps `major` while the hash stays
the same.

Example identifiers computed from the text above on 2026-11-04:

| Recipient | Example `templateVersion` |
|---|---|
| Google Search, English | `google-search.en.v1@ed9f34155836` |
| Bing, English | `bing.en.v1@e36eaf64fd3c` |
| Yandex, English | `yandex.en.v1@209722198e33` |

A silent edit to any statement changes the hash and therefore the identifier. A structural change
also bumps `major`. The hash alone is not a legal approval: it proves only that the stored text is
the text the operator verified.

### 5.2 How this maps to the contract

- `NoticeContent.templateVersion` = the set identifier, e.g. `bing.en.v1@e36eaf64fd3c`.
- `NoticeStatement.templateVersion` = the same set identifier for every statement in that notice.
  Statements are accepted by the recipient as a set; allowing per-statement versions would permit a
  mixture of revisions that no recipient ever saw.
- `NoticeStatement.key` = Patrol's stable key (`bing.512f_acknowledgement`). It must not be the
  recipient's display label, which can change without the statement changing.
- The recipient profile snapshot already stores `formUrl` and `capturedAt`; the template registry
  stores the source URLs and the verification date that the identifier refers to.

### 5.3 Approval procedure

1. **Registry row.** Each template revision is a row keyed by the identifier, holding recipient,
   language, ordered statements, canonical hash, source URLs, `accessed_at`, `verified_by`,
   `verified_at`, and `supersedes`.
2. **Manual re-read.** Before an operator may approve a notice, they open every source URL in the
   registry in a normal browser — not an automated form submission — and compare each statement
   character-for-character. They record the access date and confirm the comparison.
3. **Approval confirms currency.** The approval screen shows the identifier, the source URLs, and
   “last verified” date, plus a diff against the previous revision when one exists. The operator's
   approval means: *I read these sources on this date and the text shown is the text they publish.*
   That is the only claim `templateVersion` makes.
4. **Blocking.** Approval is blocked if the template was last verified more than 90 days ago, if a
   newer revision exists, or if the recipient/language has no verified template. A draft composed
   under an older template cannot be approved unchanged; it must be re-composed.
5. **Freeze.** Approval copies the identifier into the notice and all its statements. A later
   template revision never rewrites an approved or delivered notice.

### 5.4 Change detection without automating the form

No recipient publishes a machine-readable version or change log (see §6), and none of the five pages
returned `Last-Modified` or `ETag` on 2026-11-04. Detection is therefore procedural:

- **Release gate.** Re-read every statement source before any release that changes notice rendering.
- **Quarterly floor.** Re-read all three recipients at least once a quarter, even without a release.
- **Recorded access.** Store `accessed_at` and `verified_by` per revision. The 90-day approval block
  makes a stale template impossible to use silently.
- **Fixture test.** Keep a checked-in fixture per identifier (`statement-template.json`) with the
  ordered statements and the expected hash. A unit test recomputes the hash and fails if the fixture
  or the rendered strings drift. Updating the fixture is a deliberate, reviewed change that also
  updates the registry row.
- **Human snapshot diff (optional).** Save the rendered form HTML (Bing, Yandex) or the help-article
  text (Google) at verification time and diff it at the next review. Do not fetch these pages from
  CI: Google's form is sign-in-gated and Bing/Yandex deploy bot challenges.
- **Google-specific caveat.** Because the form itself cannot be read without an account, the
  quarterly check must include a signed-in human look at the form, not only the help article.

## 6. Published version identifiers, change logs, and signals

| Recipient | Version identifier | Change log | Dated revision | Observed change signals |
|---|---|---|---|---|
| Google | None published [G1][G2] | None | None observed | Help article has no visible “last updated”; form is server-rendered and can change silently [G1][G3] |
| Bing | None published [M1][M2] | None | None observed | Legal page and form have no date or revision marker; form HTML can change silently [M1][M2] |
| Yandex | None published. Policy shows “Effective Date: December 12, 2012” and a “Current version available at” link [Y1] | None | Effective date only; no revision number | Embedded page metadata shows `docVersion:null`; no document version is published [Y1] |

None of the five URLs returned `Last-Modified` or `ETag` on 2026-11-04. Yandex's 2012 effective date
is not a change signal: it would not move if the form's 2026 wording changed. Google's and
Microsoft's pages likewise carry no statement-level date. Patrol therefore cannot detect a change by
polling headers or watching a version number; the quarterly human re-read is the detection mechanism,
and the fixture hash is the tripwire for accidental local drift.

## 7. Limits and inferences

- **Google form UI unverified.** The DMCA form requires sign-in [G3]; this research read the
  published help statements [G1] but not the form's rendered wording. `[INFERENCE]` The form may add
  a sharing sentence or slightly different labels. A signed-in operator must confirm before the
  Google template is approved for the first time.
- **Google localization.** Only the English and German help renderings were checked [G1][G5]. Other
  locales' statement text is unverified; the template registry must not create a locale until a
  human has read it.
- **Bing sharing statement.** The sentence is displayed without a checkbox [M2]. `[INFERENCE]`
  Whether submitting the form legally records consent, or merely notice, is not stated; Patrol should
  present it as a disclosure, not as a separately toggled consent.
- **Bing legal-page variant.** The legal page's statement text differs from the form's [M1][M2].
  Patrol renders the form text; the legal page remains the citation for why the statement is
  required.
- **Yandex territory.** The channel is limited to IPs and right holders in the US, EU, or Switzerland
  [Y1][Y2]. `[INFERENCE]` Notices from other territories follow a different process; Patrol must
  check `eligibleTerritories` before offering the Yandex template.
- **Yandex language.** The form's questions and statements stayed English with `?lang=ru`; only the
  chrome localized [Y3]. `[INFERENCE]` There is no Russian-language statement set to version for this
  channel.
- **Yandex policy wording vs. form wording.** The two differ [Y1][Y3]; the form text is what the
  operator accepts. The difference is recorded, not reconciled.
- **No published versioning.** No recipient publishes a statement version, changelog, or dated
  revision that Patrol can consume [G1][G2][M1][M2][Y1]. The identifier scheme in §5 is Patrol's own;
  it must never be presented to a recipient as the recipient's version.
- **Hash examples are date-stamped.** The example hashes were computed from the text in this
  document on 2026-11-04. They are illustrative of the scheme and must be recomputed from the
  registry's canonical text before use.

## 8. Citations

- **[G1]** Google, “What is copyright? — Copyright infringement notification requirements”
  (statements, signature, contact/work/URL requirements),
  https://support.google.com/legal/answer/3463239?hl=en (accessed 2026-11-04)
- **[G2]** Google Transparency Report, “Google Search removals due to copyright infringement FAQs”
  (Lumen publication, counter-notice, qualifying requests),
  https://support.google.com/transparencyreport/answer/7347743?hl=en (accessed 2026-11-04)
- **[G3]** Google, DMCA Search form (sign-in gate: “Sign in to get started”),
  https://reportcontent.google.com/forms/dmca_search (accessed 2026-11-04)
- **[G4]** Google, “Learn how to report content for legal reasons” (one notice per product, reference
  number, privacy link), https://support.google.com/legal-help-center/answer/13887279?hl=en
  (accessed 2026-11-04)
- **[G5]** Google, “What is copyright?” German rendering (translated statements),
  https://support.google.com/legal/answer/3463239?hl=de (accessed 2026-11-04)
- **[M1]** Microsoft, “Infringement Notices: Copyright and Trademark” (required elements, DMCA agent,
  third-party disclosure), https://www.microsoft.com/en-us/legal/intellectualproperty/infringement
  (accessed 2026-11-04)
- **[M2]** Microsoft Bing, “Notices of Infringement” form, server-rendered HTML (Good Faith Belief,
  Authority to Act, 512(f) Acknowledgement, sharing sentence, Signature),
  https://www.bing.com/webmaster/contentremovalform/showcontentremovalform (accessed 2026-11-04)
- **[Y1]** Yandex, “Copyright Infringement Policy” (effective date, territory, required information,
  statements 9(a)–(b), signature and date),
  https://yandex.ru/legal/copyright/en/ (accessed 2026-11-04)
- **[Y2]** Yandex, “Copyright Notice Policy” support page (disclosure to third parties and the
  public, form location, territory gate), https://yandex.ru/support/copyright-complaint/en/
  (accessed 2026-11-04)
- **[Y3]** Yandex, “Abuse: Copyright Infringement” form (survey 1773), rendered English UI: good
  faith, accuracy/perjury, data-processing consent, signature, date,
  https://forms.yandex.com/surveys/1773/?lang=en&iframe=1 (accessed 2026-11-04)
