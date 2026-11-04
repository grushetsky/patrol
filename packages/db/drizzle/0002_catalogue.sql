-- Slice 2: catalogue and settings.
-- Title groups, tracked titles, variants, external identifiers, allowlist
-- entries, recipient profiles, and the acquisition budget embedded in the
-- rights holder row (the domain model nests AcquisitionBudget inside
-- RightsHolder, so its columns land there; 0001 created the signatory
-- columns already).

-- One operator-defined set of tracked titles sharing scan settings and
-- allowlist scope. scan_time spreads inside the 02:00-05:59 UTC window by
-- default; the window is the design's spreading rule, so the database
-- enforces it and the application derives the default from the group's
-- identity (docs/design/scan-scheduling.md).
CREATE TABLE title_groups (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  name text NOT NULL,
  locales text[] NOT NULL CHECK (array_length(locales, 1) > 0),
  scan_time time NOT NULL DEFAULT '02:30',
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('high', 'normal', 'low')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (scan_time >= time '02:00' AND scan_time < time '06:00')
);

CREATE INDEX title_groups_name_idx ON title_groups (name);

-- A work the rights holder monitors. Keyed by Patrol's own UUIDv7, never by
-- an external identifier. original_variant_id lands below, after
-- title_variants exists: the two tables reference each other, and a title
-- and its original variant are born in one transaction. merged_into_title_id
-- archives a merged duplicate; archived titles are never deleted.
CREATE TABLE tracked_titles (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  title_group_id uuid NOT NULL REFERENCES title_groups (id),
  release_year integer NOT NULL CHECK (release_year >= 1878),
  title_type text NOT NULL
    CHECK (title_type IN ('film', 'series', 'miniseries', 'other')),
  runtime_minutes integer CHECK (runtime_minutes >= 1),
  original_variant_id uuid,
  paused boolean NOT NULL DEFAULT false,
  merged_into_title_id uuid REFERENCES tracked_titles (id),
  source text NOT NULL
    CHECK (source IN ('rights_holder_record', 'operator_knowledge', 'wikidata')),
  entered_by uuid NOT NULL REFERENCES operators (id),
  entered_at timestamptz NOT NULL,
  updated_by uuid NOT NULL REFERENCES operators (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tracked_titles_group_idx ON tracked_titles (title_group_id);

-- A recorded name by which a tracked title is known. normalized_text is the
-- storage key derived from the text (NFKC, case fold, diacritic fold,
-- punctuation and whitespace collapse); the native string is never
-- overwritten. Exactly one variant per title is original: the partial
-- unique index enforces it, and tracked_titles.original_variant_id points
-- at it. The key difference from the full matching normalizer (per-language
-- article-less key, transliteration) arrives with slice 5.
CREATE TABLE title_variants (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tracked_title_id uuid NOT NULL REFERENCES tracked_titles (id) ON DELETE CASCADE,
  text text NOT NULL,
  normalized_text text NOT NULL,
  kind text NOT NULL
    CHECK (kind IN ('original', 'localized', 'transliterated', 'alternate')),
  language text NOT NULL,
  script text NOT NULL,
  territory text,
  source text NOT NULL
    CHECK (source IN ('rights_holder_record', 'operator_knowledge', 'wikidata')),
  added_by uuid NOT NULL REFERENCES operators (id),
  added_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX title_variants_unique_text ON title_variants (tracked_title_id, normalized_text);
CREATE UNIQUE INDEX title_variants_one_original ON title_variants (tracked_title_id) WHERE kind = 'original';
CREATE INDEX title_variants_normalized_idx ON title_variants (normalized_text);

ALTER TABLE tracked_titles
  ADD CONSTRAINT tracked_titles_original_variant_fk
  FOREIGN KEY (original_variant_id) REFERENCES title_variants (id);

-- An external identifier for a tracked title: a fact, not a lookup key. A
-- value is unique within its scheme across tracked titles, so identifier
-- equality identifies one title whatever its text says. KinoPoisk ids
-- arrive as facts from Wikidata or operator knowledge; no KinoPoisk page is
-- ever fetched. Shape validation (Q+digits, tt+>=7 digits, digits) is an
-- application guard on create.
CREATE TABLE external_identifiers (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tracked_title_id uuid NOT NULL REFERENCES tracked_titles (id) ON DELETE CASCADE,
  scheme text NOT NULL CHECK (scheme IN ('wikidata', 'imdb', 'kinopoisk')),
  value text NOT NULL,
  source text NOT NULL
    CHECK (source IN ('rights_holder_record', 'operator_knowledge', 'wikidata')),
  retrieved_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX external_identifiers_scheme_value_key ON external_identifiers (scheme, value);
CREATE INDEX external_identifiers_title_idx ON external_identifiers (tracked_title_id);

-- A scoped rule that marks a host or URL prefix as authorized or
-- non-infringing. Scope wiring is enforced by the database, not just the
-- application: a licensed destination needs a territory; a title-group
-- scope carries a group and no title; a tracked-title scope carries a title
-- and no group; the rights-holder scope carries neither.
-- proposed_by_decision_id points at the review decision that proposed a
-- learned entry; the review_decisions table arrives with slice 5, so the
-- reference is an untyped uuid for now and gains its foreign key there.
CREATE TABLE allowlist_entries (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  kind text NOT NULL
    CHECK (kind IN ('official_domain', 'licensed_destination', 'neutral_source')),
  match_kind text NOT NULL CHECK (match_kind IN ('host', 'url_prefix')),
  value text NOT NULL,
  scope text NOT NULL
    CHECK (scope IN ('rights_holder', 'title_group', 'tracked_title')),
  title_group_id uuid REFERENCES title_groups (id),
  tracked_title_id uuid REFERENCES tracked_titles (id),
  territory text CHECK (territory ~ '^[A-Z]{2}$'),
  origin text NOT NULL CHECK (origin IN ('operator', 'review_decision')),
  proposed_by_decision_id uuid,
  confirmed_by uuid NOT NULL REFERENCES operators (id),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'licensed_destination' OR territory IS NOT NULL),
  CHECK (
    (scope = 'rights_holder' AND title_group_id IS NULL AND tracked_title_id IS NULL)
    OR (scope = 'title_group' AND title_group_id IS NOT NULL AND tracked_title_id IS NULL)
    OR (scope = 'tracked_title' AND title_group_id IS NULL AND tracked_title_id IS NOT NULL)
  ),
  CHECK (origin <> 'review_decision' OR proposed_by_decision_id IS NOT NULL)
);

CREATE INDEX allowlist_entries_match_idx ON allowlist_entries (match_kind, value);
CREATE INDEX allowlist_entries_title_group_idx ON allowlist_entries (title_group_id) WHERE title_group_id IS NOT NULL;
CREATE INDEX allowlist_entries_tracked_title_idx ON allowlist_entries (tracked_title_id) WHERE tracked_title_id IS NOT NULL;
CREATE INDEX allowlist_entries_territory_idx ON allowlist_entries (territory) WHERE territory IS NOT NULL;

-- One profile per recipient. The recent-submission window (SubmissionStats)
-- is the input to the pause threshold; the submissions table arrives with
-- slice 6, so the counters stand at zero until then and that slice's write
-- path maintains them. version rises on every edit and is snapshotted into
-- a notice at approval. Rows are seeded lazily by the application on first
-- read (migrations run before any operator exists to record as updated_by).
CREATE TABLE recipient_profiles (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  recipient text NOT NULL
    CHECK (recipient IN ('google', 'bing', 'yandex')),
  channel text NOT NULL DEFAULT 'web_form'
    CHECK (channel IN ('web_form', 'trusted_program')),
  account text NOT NULL DEFAULT '',
  contact_email text,
  composition_trigger text NOT NULL DEFAULT 'scheduled'
    CHECK (composition_trigger IN ('scheduled', 'on_demand')),
  window_time time,
  eligible_territories text[] NOT NULL DEFAULT '{}',
  max_urls_per_notice integer CHECK (max_urls_per_notice >= 1),
  max_urls_per_file integer CHECK (max_urls_per_file >= 1),
  max_urls_per_day integer CHECK (max_urls_per_day >= 1),
  last_observed_max_urls_per_file integer CHECK (last_observed_max_urls_per_file >= 1),
  last_observed_daily_quota integer CHECK (last_observed_daily_quota >= 1),
  paused boolean NOT NULL DEFAULT false,
  pause_reason text,
  cleared_reason text,
  cleared_by uuid REFERENCES operators (id),
  cleared_at timestamptz,
  recent_window_size integer NOT NULL DEFAULT 0 CHECK (recent_window_size >= 0),
  recent_rejected integer NOT NULL DEFAULT 0 CHECK (recent_rejected >= 0),
  recent_failed integer NOT NULL DEFAULT 0 CHECK (recent_failed >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by uuid NOT NULL REFERENCES operators (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (composition_trigger <> 'scheduled' OR window_time IS NOT NULL)
);

CREATE UNIQUE INDEX recipient_profiles_recipient_key ON recipient_profiles (recipient);

-- The acquisition budget, embedded in the rights holder per the domain
-- model. Defaults are the design-point envelope: $48 Google, $12 Yandex,
-- $0 deferred Bing, 30% of each allowance reserved for re-checks. The
-- currency is USD (the contract's only Currency); lowering a cap never
-- un-spends what the ledger committed (the ledger arrives with slice 3).
ALTER TABLE rights_holder
  ADD COLUMN budget_google_monthly_cap_minor integer NOT NULL DEFAULT 4800
    CHECK (budget_google_monthly_cap_minor >= 0),
  ADD COLUMN budget_yandex_monthly_cap_minor integer NOT NULL DEFAULT 1200
    CHECK (budget_yandex_monthly_cap_minor >= 0),
  ADD COLUMN budget_bing_monthly_cap_minor integer NOT NULL DEFAULT 0
    CHECK (budget_bing_monthly_cap_minor >= 0),
  ADD COLUMN budget_recheck_share_percent integer NOT NULL DEFAULT 30
    CHECK (budget_recheck_share_percent BETWEEN 0 AND 100);
