-- Slice 6a: statement templates and the draft composer (docs/design/
-- notice-composition.md; implementation rules "Notices and submissions" and
-- "Notice templates"). A notice is the unit one recipient receives: the
-- draft the composer writes here, frozen by approval in 6b. The citations
-- table carries BOTH invariants the design names — a draft reserves its
-- cited violations (no second draft may cite them) and the recipient-level
-- deduplication (recipient profile, normalized URL, tracked title) unique
-- among notices that are not withdrawn, superseded, rejected, or failed.

-- The statement-template registry. One row per revision, keyed by the
-- identifier `<recipient>.<language>.v<major>@<hash12>`: SHA-256 over the
-- ordered {key, text} statements (each text NFC, trimmed, whitespace runs
-- collapsed), first twelve hex characters. The `fields` jsonb carries the
-- signature/date FIELD LABELS (with their label text, verbatim from the
-- research) the row versions but the hash excludes, so a label-only change
-- is a new revision with the same hash12. The three verified English sets
-- are seeded from the research (every source read 2026-11-04);
-- `verified_by`/`verified_at` are stamped by the approval attestation
-- (6b) — until then the set is the research-verified text and the summary's
-- staleness reads `accessed_at`.
CREATE TABLE notice_templates (
  identifier text PRIMARY KEY,
  recipient text NOT NULL CHECK (recipient IN ('google', 'bing', 'yandex')),
  language text NOT NULL,
  major integer NOT NULL CHECK (major >= 1),
  hash12 text NOT NULL CHECK (hash12 ~ '^[0-9a-f]{12}$'),
  -- Ordered [{key, text}] in form order; the canonical hash input.
  statements jsonb NOT NULL,
  -- Ordered [{name, label, required}] field labels with their label text;
  -- versioned, never hashed.
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_urls text[] NOT NULL CHECK (array_length(source_urls, 1) > 0),
  accessed_at timestamptz NOT NULL,
  -- A plain uuid, deliberately not a foreign key: the registry is
  -- migration-owned REFERENCE data (its seed rides the migration), so it
  -- must not cascade with operational tables' lifecycle — a truncate of
  -- operators would otherwise wipe the seeded templates through the FK.
  -- The id still names an operator; the approval attestation (6b) stamps it.
  verified_by uuid,
  verified_at timestamptz,
  supersedes text REFERENCES notice_templates (identifier),
  superseded_by text REFERENCES notice_templates (identifier),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(statements) = 'array'),
  CHECK (jsonb_typeof(fields) = 'array')
);

CREATE INDEX notice_templates_recipient_language_idx
  ON notice_templates (recipient, language, active);

-- The verified seed (research read 2026-11-04; fixture drift CI recomputes
-- the same hashes in packages/notices). Forward-only: a later revision is
-- a new row that supersedes these, never an edit of them.
INSERT INTO notice_templates
  (identifier, recipient, language, major, hash12, statements, fields, source_urls, accessed_at)
VALUES
  (
    'google-search.en.v1@ed9f34155836',
    'google', 'en', 1, 'ed9f34155836',
    '[{"key":"good_faith_belief","text":"I have a good faith belief that use of the copyrighted materials described above as allegedly infringing is not authorized by the copyright owner, its agent, or the law."},{"key":"accuracy_perjury_authority","text":"The information in this notification is accurate and I swear, under penalty of perjury, that I am the copyright owner or am authorized to act on behalf of the owner of an exclusive right that is allegedly infringed."}]'::jsonb,
    '[{"name":"signature","label":"Complete complaints require the physical or electronic signature of the copyright owner or a representative authorized to act on their behalf. To satisfy this requirement, you may type your full legal name to act as your signature at the bottom of your complaint.","required":true}]'::jsonb,
    ARRAY[
      'https://support.google.com/legal/answer/3463239?hl=en',
      'https://reportcontent.google.com/forms/dmca_search'
    ],
    '2026-11-04T00:00:00Z'
  ),
  (
    'bing.en.v1@e36eaf64fd3c',
    'bing', 'en', 1, 'e36eaf64fd3c',
    '[{"key":"good_faith_belief","text":"By typing in my name (electronic signature), I state that I have a good faith belief that the use of the material is not authorized by the intellectual property owner, its agent, or the law (e.g., it is not fair use)."},{"key":"authority_to_act","text":"I represent that the information in the notification is accurate and, under penalty of perjury, that I am authorized to act on behalf of the owner of an exclusive right that is allegedly infringed."},{"key":"512f_acknowledgement","text":"As applicable under 17 U.S.C. 512(f), I acknowledge that I may be subject to liability for damages if I knowingly materially misrepresent that material or activity is infringing."},{"key":"third_party_sharing","text":"I understand that the information submitted in this form may be shared with third parties or the public, including the alleged infringer about whom I am filing this complaint."}]'::jsonb,
    '[{"name":"signature","label":"Signature","required":true}]'::jsonb,
    ARRAY[
      'https://www.bing.com/webmaster/contentremovalform/showcontentremovalform',
      'https://www.microsoft.com/en-us/legal/intellectualproperty/infringement'
    ],
    '2026-11-04T00:00:00Z'
  ),
  (
    'yandex.en.v1@209722198e33',
    'yandex', 'en', 1, '209722198e33',
    '[{"key":"good_faith_belief","text":"By submitting this notice and signing with your digital signature below, you confirm that you have a good faith belief that the use of the material in the manner complained of is not authorized by the copyright owner, its agent, or the law."},{"key":"accuracy_perjury_authority","text":"You further confirm that the information in this notification is accurate and, under penalty of perjury, that you are authorized to act on behalf of the owner of an exclusive right that is allegedly infringed."},{"key":"data_processing_consent","text":"I hereby consent to the processing of the personal data provided above for the purpose of reviewing the application and getting feedback. I am aware of my right to withdraw the consent via address mentioned above."}]'::jsonb,
    '[{"name":"signature","label":"Signature (please provide your full name)","required":true},{"name":"date","label":"Date (Format:DD.MM.YYYY)","required":true}]'::jsonb,
    ARRAY[
      'https://forms.yandex.com/surveys/1773/?lang=en&iframe=1',
      'https://yandex.ru/legal/copyright/en/',
      'https://yandex.ru/support/copyright-complaint/en/'
    ],
    '2026-11-04T00:00:00Z'
  );

-- One notice: identity and lifecycle. The content freeze columns the
-- approval (6b) fills — the rights-holder, signatory, and profile
-- snapshots and the approval/withdrawal/supersession records — are present
-- and nullable now. A draft's content lives in the child tables below; an
-- approval freezes it (a draft may be re-composed, an approved notice
-- never edited).
CREATE TABLE notices (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  recipient text NOT NULL CHECK (recipient IN ('google', 'bing', 'yandex')),
  recipient_profile_id uuid NOT NULL REFERENCES recipient_profiles (id),
  channel text NOT NULL CHECK (channel IN ('web_form', 'trusted_program')),
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'approved', 'withdrawn', 'superseded')),
  -- The statement set the notice was composed under; every notice statement
  -- repeats it (the recipient accepts the statements as a set).
  template_version text NOT NULL REFERENCES notice_templates (identifier),
  language text NOT NULL,
  composed_at timestamptz NOT NULL,
  composed_by uuid NOT NULL REFERENCES operators (id),
  -- scheduled: the profile's daily window composed it; on_demand: an
  -- operator selected the violations.
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('scheduled', 'on_demand')),
  updated_at timestamptz,
  -- Content freeze and lifecycle records (6b writes these; nullable now).
  approved_by uuid REFERENCES operators (id),
  approved_at timestamptz,
  rights_holder_snapshot jsonb,
  signatory_snapshot jsonb,
  profile_snapshot jsonb,
  withdrawn_by uuid REFERENCES operators (id),
  withdrawn_at timestamptz,
  withdrawal_reason text,
  superseded_at timestamptz,
  superseded_by_notice_id uuid REFERENCES notices (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'approved' OR (approved_by IS NOT NULL AND rights_holder_snapshot IS NOT NULL AND signatory_snapshot IS NOT NULL AND profile_snapshot IS NOT NULL)),
  CHECK (state <> 'withdrawn' OR (withdrawn_by IS NOT NULL AND withdrawn_at IS NOT NULL)),
  CHECK (state <> 'superseded' OR (superseded_at IS NOT NULL AND superseded_by_notice_id IS NOT NULL))
);

CREATE INDEX notices_profile_idx ON notices (recipient_profile_id, state);
CREATE INDEX notices_state_idx ON notices (state);
CREATE INDEX notices_created_idx ON notices (composed_at DESC);

-- The citations: one row per violation the notice claims, with the pinned
-- evidence refs (id, capture time, reason) the composition relied on — a
-- later capture never changes what an approved notice claims. The denormalized
-- recipient_profile_id carries the recipient-level dedup; the denormalized
-- `state` mirrors the notice's lifecycle (and the submission outcomes that
-- end the reservation, 'rejected' and 'failed', which 6b/7 write) so BOTH
-- partial unique indexes below hold the design's invariants in the database:
--
--   reservation — a violation is cited by at most one active notice;
--   dedup — (recipient profile, normalized URL, tracked title) is unique
--   among notices that are not withdrawn, superseded, rejected, or failed.
--
-- The ACTIVE set ('draft', 'approved') spelled in the two indexes below is
-- the SQL mirror of ACTIVE_CITATION_STATES in
-- packages/notices/src/compose.ts — SQL cannot import the constant, so the
-- homes move together by hand.
CREATE TABLE notice_citations (
  notice_id uuid NOT NULL REFERENCES notices (id) ON DELETE CASCADE,
  violation_id uuid NOT NULL REFERENCES violations (id),
  recipient_profile_id uuid NOT NULL REFERENCES recipient_profiles (id),
  tracked_title_id uuid NOT NULL REFERENCES tracked_titles (id),
  url text NOT NULL,
  normalized_url text NOT NULL,
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'approved', 'withdrawn', 'superseded', 'rejected', 'failed')),
  position integer NOT NULL CHECK (position >= 0),
  -- [{evidenceId, capturedAt, reason}] pinned at composition (6b freezes
  -- the set at approval).
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (notice_id, violation_id),
  UNIQUE (notice_id, position)
);

CREATE UNIQUE INDEX notice_citations_reservation_uniq
  ON notice_citations (violation_id) WHERE state IN ('draft', 'approved');

CREATE UNIQUE INDEX notice_citations_dedup_uniq
  ON notice_citations (recipient_profile_id, normalized_url, tracked_title_id)
  WHERE state IN ('draft', 'approved');

CREATE INDEX notice_citations_violation_idx ON notice_citations (violation_id);
CREATE INDEX notice_citations_title_idx ON notice_citations (tracked_title_id);

-- How each cited tracked title is identified to the recipient: the display
-- title (the original-title variant), the year, the kind of work, and the
-- authorized example URL where the form asks for one. One row per cited
-- title per notice, in composition order.
CREATE TABLE notice_work_identifications (
  notice_id uuid NOT NULL REFERENCES notices (id) ON DELETE CASCADE,
  tracked_title_id uuid NOT NULL REFERENCES tracked_titles (id),
  display_title text NOT NULL,
  release_year integer NOT NULL CHECK (release_year >= 1878),
  title_type text NOT NULL CHECK (title_type IN ('film', 'series', 'miniseries', 'other')),
  authorized_example_url text,
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (notice_id, tracked_title_id)
);

-- The exact statement text the notice carries, stamped with the SAME set
-- identifier as the notice — per-statement versions are refused, by the
-- trigger below as well as by the composer.
CREATE TABLE notice_statements (
  notice_id uuid NOT NULL REFERENCES notices (id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  key text NOT NULL,
  text text NOT NULL,
  template_version text NOT NULL REFERENCES notice_templates (identifier),
  PRIMARY KEY (notice_id, position)
);

-- A notice's statements all carry the notice's template version: the
-- recipient accepts the set as a set, so a mixture of revisions must never
-- be writable.
CREATE OR REPLACE FUNCTION patrol_notice_statements_one_version() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.template_version IS DISTINCT FROM (
    SELECT template_version FROM notices WHERE id = NEW.notice_id
  ) THEN
    RAISE EXCEPTION 'notice statements carry the notice''s template version (notice %)', NEW.notice_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notice_statements_one_version
  BEFORE INSERT OR UPDATE ON notice_statements
  FOR EACH ROW EXECUTE FUNCTION patrol_notice_statements_one_version();

-- The form-ordered resolved field map the operator copies from: the
-- recipient's field names with the values the rights holder, signatory,
-- and profile resolve to at composition (approval freezes them; 6b).
CREATE TABLE notice_resolved_fields (
  notice_id uuid NOT NULL REFERENCES notices (id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  name text NOT NULL,
  value text NOT NULL,
  required boolean NOT NULL,
  max_length integer CHECK (max_length IS NULL OR max_length >= 1),
  PRIMARY KEY (notice_id, position)
);

-- One row per composition window a scheduled profile ran: the idempotency
-- key (a window is composed at most once, whatever the cron does) and the
-- record of a skipped window (paused, ineligible, or missing its setup
-- facts) so the next window — not the next tick — is the next attempt.
-- The PREVIOUS window a run composes from is the profile's last UNSKIPPED
-- one (a skipped window never moves the cut-off — the interval it stood
-- over folds into the first window after the clearance), so a worker that
-- was down for days catches up in one cut-off rather than skipping days.
CREATE TABLE notice_composition_runs (
  recipient_profile_id uuid NOT NULL REFERENCES recipient_profiles (id),
  window_at timestamptz NOT NULL,
  composed_notices integer NOT NULL DEFAULT 0 CHECK (composed_notices >= 0),
  skipped_reason text
    CHECK (skipped_reason IS NULL OR skipped_reason IN
      ('paused', 'recipient_ineligible', 'template_absent', 'rights_holder_absent')),
  ran_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recipient_profile_id, window_at)
);
