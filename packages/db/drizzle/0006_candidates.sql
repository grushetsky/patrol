-- Slice 5a: candidates (docs/design/matching-and-classification-rules.md;
-- contract Patrol.Domain.Candidate / Patrol.Http.CandidateReviewRow). One
-- candidate is one URL paired with one tracked title, deduplicated across
-- queries and engines on (normalized_url, tracked_title_id). The row carries
-- the observation summary (first engine and query, best rank, every engine
-- that surfaced the pair), the frozen variant snapshot, the score with every
-- component, the reputation snapshot, and the allowlist hit -- recorded, not
-- suppressing; the confirm-time suppression guard is 5b's transition.

-- The candidate lifecycle columns for 5b (confirmed needs the decision and
-- the violation; dismissed needs the decision and the dismissal) stand
-- nullable from day one so 5b never rewrites this table's shape.
CREATE TABLE candidates (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tracked_title_id uuid NOT NULL REFERENCES tracked_titles (id),
  url text NOT NULL,
  normalized_url text NOT NULL,
  host text NOT NULL,
  registrable_domain text NOT NULL,
  source text NOT NULL CHECK (source IN ('serp', 'manual')),
  -- The engine whose result first surfaced the pair; null for a manual
  -- entry. engines[] carries every engine that ever surfaced it, because a
  -- candidate deduplicates across engines rather than belonging to one.
  engine text CHECK (engine IN ('google', 'bing', 'yandex')),
  engines text[] NOT NULL DEFAULT '{}' CHECK (array_length(engines, 1) IS NULL OR source <> 'manual'),
  query_id uuid REFERENCES search_queries (id),
  query_text text,
  locale text,
  territory text CHECK (territory ~ '^[A-Z]{2}$'),
  -- The best SERP rank across observations; the review queue orders by it
  -- after the score. Null for a manual entry.
  best_rank integer CHECK (best_rank >= 1),
  matched_variant_id uuid NOT NULL REFERENCES title_variants (id),
  matched_variant jsonb NOT NULL,
  score numeric(4, 3) NOT NULL CHECK (score >= 0 AND score <= 1),
  band text NOT NULL CHECK (band IN ('a', 'b', 'c')),
  score_components jsonb NOT NULL,
  reputation jsonb NOT NULL,
  -- The allowlist entry that hit this URL at formation, recorded so the
  -- review row shows it; the hit never suppresses the candidate here.
  allowlist_entry_id uuid REFERENCES allowlist_entries (id),
  allowlist_kind text CHECK (
    allowlist_kind IN ('official_domain', 'licensed_destination', 'neutral_source')
  ),
  first_seen_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'confirmed', 'dismissed')),
  -- 5b's lifecycle columns, nullable until a review decision exists.
  review_decision_id uuid,
  violation_id uuid,
  confirmed_at timestamptz,
  dismissed_at timestamptz,
  dismissal jsonb,
  created_by uuid REFERENCES operators (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source <> 'serp' OR (engine IS NOT NULL AND best_rank IS NOT NULL)),
  CHECK (source <> 'manual' OR (engine IS NULL AND query_id IS NULL AND best_rank IS NULL)),
  CHECK (state <> 'confirmed' OR (review_decision_id IS NOT NULL AND violation_id IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK (state <> 'dismissed' OR (review_decision_id IS NOT NULL AND dismissed_at IS NOT NULL AND dismissal IS NOT NULL)),
  CHECK (state <> 'pending' OR (review_decision_id IS NULL AND violation_id IS NULL AND confirmed_at IS NULL AND dismissed_at IS NULL AND dismissal IS NULL)),
  UNIQUE (normalized_url, tracked_title_id)
);

-- The review queue's fixed order: score descending, SERP rank ascending
-- (nulls -- manual entries -- last), observation time descending.
CREATE INDEX candidates_queue_order_idx
  ON candidates (state, score DESC, best_rank ASC NULLS LAST, last_observed_at DESC);
CREATE INDEX candidates_domain_idx ON candidates (registrable_domain, state);
CREATE INDEX candidates_title_idx ON candidates (tracked_title_id);
CREATE INDEX candidates_url_idx ON candidates (normalized_url);
CREATE INDEX candidates_host_idx ON candidates (host);
CREATE INDEX candidates_allowlist_idx ON candidates (allowlist_entry_id) WHERE allowlist_entry_id IS NOT NULL;

-- The results a candidate paired, linked at formation. 0004 left
-- candidate_id an untyped uuid for exactly this moment.
ALTER TABLE search_results
  ADD CONSTRAINT search_results_candidate_fk
  FOREIGN KEY (candidate_id) REFERENCES candidates (id);

-- Provenance stays immutable: the raw URL, rank, title, snippet, and their
-- observation are never rewritten. The pairing link alone is writable --
-- formation attaches the candidate the row paired into, which 0004 could
-- not know at insert time -- and writable one-way: a paired row never
-- unpairs, because the pairing is provenance of the candidate as much as
-- the rank is provenance of the scan. The trigger keeps its name so the
-- contract of "results are never edited" keeps one enforcement point.
CREATE OR REPLACE FUNCTION patrol_search_results_never_update() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.scan_id IS DISTINCT FROM NEW.scan_id
      OR OLD.query_id IS DISTINCT FROM NEW.query_id
      OR OLD.url IS DISTINCT FROM NEW.url
      OR OLD.normalized_url IS DISTINCT FROM NEW.normalized_url
      OR OLD.rank IS DISTINCT FROM NEW.rank
      OR OLD.title IS DISTINCT FROM NEW.title
      OR OLD.snippet IS DISTINCT FROM NEW.snippet
      OR OLD.locale IS DISTINCT FROM NEW.locale
      OR OLD.territory IS DISTINCT FROM NEW.territory
      OR OLD.observed_at IS DISTINCT FROM NEW.observed_at
      OR OLD.raw_payload_ref IS DISTINCT FROM NEW.raw_payload_ref
      OR OLD.host IS DISTINCT FROM NEW.host
      OR OLD.registrable_domain IS DISTINCT FROM NEW.registrable_domain
      OR (OLD.candidate_id IS NOT NULL AND NEW.candidate_id IS NULL) THEN
    RAISE EXCEPTION 'search_results rows are provenance and are never edited; only the candidate pairing is writable, one-way (id %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
