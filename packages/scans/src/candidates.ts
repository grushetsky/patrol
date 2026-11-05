import type { Pool, PoolClient } from "pg";
import {
  candidateDedupKey,
  entryAppliesInTitleContext,
  findAllowlistHit,
  hostForUrl,
  initialCandidateScore,
  parseSidecar,
  registrableDomainFor,
  registrableDomainForUrl,
  scoreFromPage,
  variantSnapshot,
  type AllowlistTitleContext,
  type FormationTitle,
  type ReputationFacts,
} from "@patrol/domain";

/**
 * The candidate store (docs/design/matching-and-classification-rules.md
 * "Candidate formation", "Score and bands"; contract Patrol.Domain.Candidate).
 * A search result creates a candidate by pairing its URL with the tracked
 * title whose variant generated the query; candidates deduplicate across
 * queries and engines on (normalized URL, tracked title), so the upsert is
 * the dedup and every observation only refreshes the observation summary —
 * first engine, first query, best rank, the engines array, and the last
 * observation time. Scores are never clobbered by a re-observation: the
 * formation score is what the SERP row alone supports (the URL slug), and
 * the deepened score lands when the capture's sidecar arrives.
 *
 * The allowlist check runs here, scoped: an entry applies when its scope is
 * the rights holder, the candidate's title group, or the candidate's title,
 * and a licensed destination additionally needs the observation's territory.
 * A hit is recorded on the candidate and the detection capture is not
 * enqueued — an allowlisted URL is never fetched.
 */

/** The engines a candidate row names. */
export type CandidateEngine = "google" | "bing" | "yandex";

/** One candidate row (the candidates table). */
export interface CandidateRow {
  id: string;
  trackedTitleId: string;
  url: string;
  normalizedUrl: string;
  host: string;
  registrableDomain: string;
  source: "serp" | "manual";
  engine: CandidateEngine | null;
  engines: CandidateEngine[];
  queryId: string | null;
  queryText: string | null;
  locale: string | null;
  territory: string | null;
  bestRank: number | null;
  matchedVariantId: string;
  matchedVariant: Record<string, unknown>;
  score: number;
  band: "a" | "b" | "c";
  scoreComponents: Record<string, unknown>;
  reputation: Record<string, unknown>;
  allowlistEntryId: string | null;
  allowlistKind: string | null;
  firstSeenAt: Date;
  lastObservedAt: Date;
  state: "pending" | "confirmed" | "dismissed";
  reviewDecisionId: string | null;
  violationId: string | null;
  confirmedAt: Date | null;
  dismissedAt: Date | null;
  dismissal: Record<string, unknown> | null;
  createdBy: string | null;
}

const CANDIDATE_COLUMNS = `id, tracked_title_id, url, normalized_url, host, registrable_domain,
  source, engine, engines, query_id, query_text, locale, territory, best_rank,
  matched_variant_id, matched_variant, score, band, score_components, reputation,
  allowlist_entry_id, allowlist_kind, first_seen_at, last_observed_at, state,
  review_decision_id, violation_id, confirmed_at, dismissed_at, dismissal, created_by`;

/** A candidates-table row in its snake-case shape, as the store reads it. */
export type RawCandidateRow = {
  id: string;
  tracked_title_id: string;
  url: string;
  normalized_url: string;
  host: string;
  registrable_domain: string;
  source: "serp" | "manual";
  engine: CandidateEngine | null;
  engines: CandidateEngine[];
  query_id: string | null;
  query_text: string | null;
  locale: string | null;
  territory: string | null;
  best_rank: number | null;
  matched_variant_id: string;
  matched_variant: Record<string, unknown>;
  score: string;
  band: "a" | "b" | "c";
  score_components: Record<string, unknown>;
  reputation: Record<string, unknown>;
  allowlist_entry_id: string | null;
  allowlist_kind: string | null;
  first_seen_at: Date;
  last_observed_at: Date;
  state: "pending" | "confirmed" | "dismissed";
  review_decision_id: string | null;
  violation_id: string | null;
  confirmed_at: Date | null;
  dismissed_at: Date | null;
  dismissal: Record<string, unknown> | null;
  created_by: string | null;
};

export function mapCandidate(row: RawCandidateRow): CandidateRow {
  return {
    id: row.id,
    trackedTitleId: row.tracked_title_id,
    url: row.url,
    normalizedUrl: row.normalized_url,
    host: row.host,
    registrableDomain: row.registrable_domain,
    source: row.source,
    engine: row.engine,
    engines: row.engines ?? [],
    queryId: row.query_id,
    queryText: row.query_text,
    locale: row.locale,
    territory: row.territory,
    bestRank: row.best_rank === null ? null : Number(row.best_rank),
    matchedVariantId: row.matched_variant_id,
    matchedVariant: row.matched_variant,
    score: Number(row.score),
    band: row.band,
    scoreComponents: row.score_components,
    reputation: row.reputation,
    allowlistEntryId: row.allowlist_entry_id,
    allowlistKind: row.allowlist_kind,
    firstSeenAt: new Date(row.first_seen_at),
    lastObservedAt: new Date(row.last_observed_at),
    state: row.state,
    reviewDecisionId: row.review_decision_id,
    violationId: row.violation_id,
    confirmedAt: row.confirmed_at === null ? null : new Date(row.confirmed_at),
    dismissedAt: row.dismissed_at === null ? null : new Date(row.dismissed_at),
    dismissal: row.dismissal,
    createdBy: row.created_by,
  };
}

/** Reads one candidate by id; null when absent. */
export async function readCandidate(
  pool: Pool,
  candidateId: string,
): Promise<CandidateRow | null> {
  const result = await pool.query<RawCandidateRow>(
    `select ${CANDIDATE_COLUMNS} from candidates where id = $1`,
    [candidateId],
  );
  return result.rows.length === 0 ? null : mapCandidate(result.rows[0]);
}

/** The candidate for one (URL, tracked title) pair, when one stands. */
export async function candidateForPair(
  pool: Pool,
  input: { url: string; trackedTitleId: string },
): Promise<CandidateRow | null> {
  const key = candidateDedupKey(input.url, input.trackedTitleId);
  const result = await pool.query<RawCandidateRow>(
    `select ${CANDIDATE_COLUMNS} from candidates
      where normalized_url = $1 and tracked_title_id = $2`,
    [key.normalizedUrl, key.trackedTitleId],
  );
  return result.rows.length === 0 ? null : mapCandidate(result.rows[0]);
}

/** One tracked title with its variants, as formation and scoring see it. */
export async function loadTitleForMatching(
  pool: Pool,
  trackedTitleId: string,
): Promise<
  (FormationTitle & { titleGroupId: string; originalVariantId: string }) | null
> {
  const title = await pool.query<{
    id: string;
    title_group_id: string;
    runtime_minutes: number | null;
    release_year: number | null;
    original_variant_id: string;
  }>(
    `select id, title_group_id, runtime_minutes, release_year, original_variant_id
       from tracked_titles where id = $1 and merged_into_title_id is null`,
    [trackedTitleId],
  );
  if (title.rows.length === 0) {
    return null;
  }
  const variants = await pool.query<{
    id: string;
    text: string;
    kind: string;
    language: string;
    script: string;
    territory: string | null;
  }>(
    `select id, text, kind, language, script, territory from title_variants
      where tracked_title_id = $1 order by added_at, id`,
    [trackedTitleId],
  );
  const row = title.rows[0];
  return {
    id: row.id,
    titleGroupId: row.title_group_id,
    runtimeMinutes: row.runtime_minutes === null ? null : Number(row.runtime_minutes),
    releaseYear: row.release_year === null ? null : Number(row.release_year),
    originalVariantId: row.original_variant_id,
    variants: variants.rows.map((variant) => ({
      id: variant.id,
      text: variant.text,
      kind: variant.kind as FormationTitle["variants"][number]["kind"],
      language: variant.language,
      script: variant.script,
      territory: variant.territory,
    })),
  };
}

/**
 * The allowlist entries whose scope can apply to one title's context: every
 * rights-holder entry plus the title-group and tracked-title entries whose
 * ids the context names — filtered in SQL, read once per formation pass
 * rather than once per result row. A licensed destination additionally
 * needs the observation's territory to match its own; official domains and
 * neutral sources ignore territory, per the design. The territory half runs
 * per pair (a query's rows may carry different territories) through
 * `applicableAllowlistFor`.
 */
async function scopedAllowlistEntries(
  client: Pool | PoolClient,
  context: Pick<AllowlistTitleContext, "titleGroupId" | "trackedTitleId">,
): Promise<ScopedAllowlistEntry[]> {
  const result = await client.query<{
    id: string;
    kind: ScopedAllowlistEntry["kind"];
    match_kind: ScopedAllowlistEntry["matchKind"];
    value: string;
    scope: string;
    title_group_id: string | null;
    tracked_title_id: string | null;
    territory: string | null;
  }>(
    `select id, kind, match_kind, value, scope, title_group_id, tracked_title_id, territory
       from allowlist_entries
      where scope = 'rights_holder'
         or (scope = 'title_group' and title_group_id = $1)
         or (scope = 'tracked_title' and tracked_title_id = $2)`,
    [context.titleGroupId ?? null, context.trackedTitleId ?? null],
  );
  return result.rows.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    matchKind: entry.match_kind,
    value: entry.value,
    scope: entry.scope as "rights_holder" | "title_group" | "tracked_title",
    titleGroupId: entry.title_group_id,
    trackedTitleId: entry.tracked_title_id,
    territory: entry.territory,
  }));
}

/** One allowlist entry as the scoped check reads it. */
interface ScopedAllowlistEntry {
  id: string;
  kind: "official_domain" | "licensed_destination" | "neutral_source";
  matchKind: "host" | "url_prefix";
  value: string;
  scope: "rights_holder" | "title_group" | "tracked_title";
  titleGroupId: string | null;
  trackedTitleId: string | null;
  territory: string | null;
}

/**
 * The pre-read scoped entries that apply to one observation's territory:
 * the shared context rule (a licensed destination needs the territory),
 * leaving the URL match itself to `findAllowlistHit`.
 */
function applicableAllowlistFor(
  entries: readonly ScopedAllowlistEntry[],
  context: AllowlistTitleContext,
): Array<{ id: string; kind: ScopedAllowlistEntry["kind"]; matchKind: ScopedAllowlistEntry["matchKind"]; value: string }> {
  return entries
    .filter((entry) => entryAppliesInTitleContext(entry, context))
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      matchKind: entry.matchKind,
      value: entry.value,
    }));
}

/**
 * The detection-capture enqueue port, injected by the caller's process. The
 * optional title context rides along so the port's own allowlist guard can
 * apply the scoped entries for the same pair the formation checked.
 */
export type EnqueueDetectionCapture = (input: {
  url: string;
  reason: "detection";
  context?: AllowlistTitleContext;
}) => Promise<unknown>;

/** What forming one observation produced. */
export interface FormationOutcome {
  candidate: CandidateRow;
  created: boolean;
  /** The allowlist entry that hit the URL, when one did. */
  allowlistEntryId: string | null;
}

/**
 * Upserts one (URL, tracked title) pair inside the caller's transaction and
 * links the result rows that observed it. The conflict path refreshes only
 * the observation summary — a re-observation never rewrites the score, the
 * frozen variant snapshot, or the first-surfaced engine and query. A pair
 * that already stands as `manual` keeps its manual shape entirely: the
 * table's CHECKs tie `source = 'manual'` to empty engines and a null rank,
 * so a SERP re-observation of the operator's pair touches nothing but the
 * observation times — the SERP observation itself is recorded through the
 * search_results pairing link, not through the candidate row.
 */
async function upsertPair(
  client: PoolClient,
  now: () => Date,
  input: {
    url: string;
    host: string;
    registrableDomain: string;
    trackedTitleId: string;
    source: "serp" | "manual";
    engine: CandidateEngine | null;
    queryId: string | null;
    queryText: string | null;
    locale: string | null;
    territory: string | null;
    rank: number | null;
    matchedVariantId: string;
    matchedVariantJson: string;
    score: number;
    band: "a" | "b" | "c";
    scoreComponentsJson: string;
    reputationJson: string;
    allowlistEntryId: string | null;
    allowlistKind: string | null;
    createdBy: string | null;
    resultIds: string[];
  },
): Promise<{ created: boolean; row: CandidateRow }> {
  const at = now();
  const key = candidateDedupKey(input.url, input.trackedTitleId);
  const inserted = await client.query<RawCandidateRow & { created: boolean }>(
    `insert into candidates
       (tracked_title_id, url, normalized_url, host, registrable_domain, source,
        engine, engines, query_id, query_text, locale, territory, best_rank,
        matched_variant_id, matched_variant, score, band, score_components,
        reputation, allowlist_entry_id, allowlist_kind,
        first_seen_at, last_observed_at, created_by, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7,
             case when $7::text is null then '{}'::text[] else array[$7::text] end,
             $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17::jsonb,
             $18::jsonb, $19, $20, $21, $21, $22, $21, $21)
     on conflict (normalized_url, tracked_title_id) do update set
       last_observed_at = excluded.last_observed_at,
       best_rank = case when candidates.source = 'manual' then candidates.best_rank
                        else least(candidates.best_rank, excluded.best_rank) end,
       engines = case when candidates.source = 'manual' then candidates.engines
                      else coalesce(
                        array(select distinct unnest(candidates.engines || excluded.engines)),
                        candidates.engines) end,
       allowlist_entry_id = case when candidates.source = 'manual' then candidates.allowlist_entry_id
                                 else coalesce(candidates.allowlist_entry_id, excluded.allowlist_entry_id) end,
       allowlist_kind = case when candidates.source = 'manual' then candidates.allowlist_kind
                             else coalesce(candidates.allowlist_kind, excluded.allowlist_kind) end,
       updated_at = excluded.updated_at
     returning ${CANDIDATE_COLUMNS}, (xmax = 0) as created`,
    [
      input.trackedTitleId,
      input.url,
      key.normalizedUrl,
      input.host,
      input.registrableDomain,
      input.source,
      input.engine,
      input.queryId,
      input.queryText,
      input.locale,
      input.territory,
      input.rank,
      input.matchedVariantId,
      input.matchedVariantJson,
      input.score,
      input.band,
      input.scoreComponentsJson,
      input.reputationJson,
      input.allowlistEntryId,
      input.allowlistKind,
      at,
      input.createdBy,
    ],
  );
  const row = inserted.rows[0];
  if (input.resultIds.length > 0) {
    await client.query(
      `update search_results set candidate_id = $1
        where id = any($2::uuid[]) and candidate_id is null`,
      [row.id, input.resultIds],
    );
  }
  return { created: row.created === true, row: mapCandidate(row) };
}

/** The scoped allowlist hit for one URL among pre-read entries, or null. */
function allowlistHitForPair(
  entries: readonly ScopedAllowlistEntry[],
  input: { url: string } & AllowlistTitleContext,
): { id: string | null; kind: string } | null {
  const applicable = applicableAllowlistFor(entries, input);
  const hit = findAllowlistHit(applicable, input.url);
  if (hit === null) {
    return null;
  }
  const entry = applicable.find(
    (candidate) =>
      candidate.kind === hit.kind &&
      candidate.value === hit.value &&
      candidate.matchKind === hit.matchKind,
  );
  return { id: entry?.id ?? null, kind: hit.kind };
}

/**
 * Forms the candidates one query's results pair: every result row of the
 * query, paired with the tracked title the query targeted. Deduplication is
 * the upsert — the same URL from a second query or a second engine refreshes
 * the observation summary and links the new result rows to the standing
 * candidate. A newly created candidate without an allowlist hit enqueues its
 * detection capture through the injected port (the port re-checks the
 * allowlist itself; formation skips the enqueue so a scoped hit never
 * fetches either). The formation score reads the domain's real reputation
 * facts, so the snapshot a candidate freezes at observation time is the
 * domain's standing, not a placeholder. A query without scan provenance —
 * no plan, no scan — has no engine to attribute and forms nothing; the
 * caller logs and walks on rather than guessing an engine.
 */
export async function formCandidatesForQuery(
  pool: Pool,
  now: () => Date,
  input: {
    queryId: string;
    enqueueCapture?: EnqueueDetectionCapture;
    log?: (message: string, extra?: Record<string, unknown>) => void;
  },
): Promise<FormationOutcome[]> {
  const query = await pool.query<{
    tracked_title_id: string;
    variant_id: string | null;
    text: string;
    locale: string;
  }>(
    `select q.tracked_title_id, q.variant_id, q.text, q.locale
       from search_queries q where q.id = $1`,
    [input.queryId],
  );
  if (query.rows.length === 0) {
    return [];
  }
  const { tracked_title_id: titleId, variant_id, text, locale } = query.rows[0];
  const title = await loadTitleForMatching(pool, titleId);
  if (title === null) {
    return [];
  }
  const territoryResult = await pool.query<{ territory: string | null }>(
    `select r.territory from search_results r where r.query_id = $1 and r.territory is not null limit 1`,
    [input.queryId],
  );
  const territory = territoryResult.rows[0]?.territory ?? null;

  const results = await pool.query<{
    id: string;
    url: string;
    rank: number;
    observed_at: Date;
    territory: string | null;
  }>(
    `select id, url, rank, observed_at, territory from search_results
      where query_id = $1 order by rank, id`,
    [input.queryId],
  );

  // One pair per normalized URL within the query; the best rank wins.
  const byUrl = new Map<
    string,
    { url: string; rank: number; resultIds: string[]; territory: string | null }
  >();
  for (const row of results.rows) {
    const key = candidateDedupKey(row.url, title.id).normalizedUrl;
    const standing = byUrl.get(key);
    if (standing === undefined) {
      byUrl.set(key, {
        url: row.url,
        rank: Number(row.rank),
        resultIds: [row.id],
        territory: row.territory ?? territory,
      });
    } else {
      standing.rank = Math.min(standing.rank, Number(row.rank));
      standing.resultIds.push(row.id);
    }
  }

  const matchedVariantId =
    variant_id ?? title.originalVariantId;
  const matchedVariant = title.variants.find(
    (variant) => variant.id === matchedVariantId,
  );
  if (matchedVariant === undefined) {
    return [];
  }

  const engine = await engineOfQuery(pool, input.queryId);
  if (engine === null) {
    input.log?.(
      "candidates.formation skipped a query without scan provenance",
      { queryId: input.queryId },
    );
    return [];
  }

  // One scoped-allowlist read for the whole formation pass: the SQL filters
  // by scope, the per-pair territory rule runs in memory where the pairs do.
  const allowlist = await scopedAllowlistEntries(pool, {
    titleGroupId: title.titleGroupId,
    trackedTitleId: title.id,
  });

  const client = await pool.connect();
  const outcomes: FormationOutcome[] = [];
  const createdForCapture: Array<{ url: string; context: AllowlistTitleContext }> = [];
  try {
    await client.query("begin");
    for (const pair of byUrl.values()) {
      const registrableDomain = registrableDomainForUrl(pair.url);
      const scored = initialCandidateScore({
        title,
        url: pair.url,
        reputation: await readReputationFacts(pool, now, registrableDomain),
      });
      const hit = allowlistHitForPair(allowlist, {
        url: pair.url,
        titleGroupId: title.titleGroupId,
        trackedTitleId: title.id,
        territory: pair.territory,
      });
      const result = await upsertPair(client, now, {
        url: pair.url,
        host: hostForUrl(pair.url),
        registrableDomain,
        trackedTitleId: title.id,
        source: "serp",
        engine,
        queryId: input.queryId,
        queryText: text,
        locale,
        territory: pair.territory,
        rank: pair.rank,
        matchedVariantId,
        matchedVariantJson: JSON.stringify(variantSnapshot(matchedVariant)),
        score: scored.score,
        band: scored.band,
        scoreComponentsJson: JSON.stringify(scored.components),
        reputationJson: JSON.stringify(scored.reputation),
        allowlistEntryId: hit?.id ?? null,
        allowlistKind: hit?.kind ?? null,
        createdBy: null,
        resultIds: pair.resultIds,
      });
      const outcome: FormationOutcome = {
        candidate: result.row,
        created: result.created,
        allowlistEntryId: hit?.id ?? null,
      };
      outcomes.push(outcome);
      if (result.created && hit === null) {
        createdForCapture.push({
          url: pair.url,
          context: {
            titleGroupId: title.titleGroupId,
            trackedTitleId: title.id,
            territory: pair.territory,
          },
        });
      }
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  // The capture enqueues happen after the commit: the enqueue port runs its
  // own guards and its own transaction, and a candidate that stands in the
  // database is what authorizes a fetch of its URL. One refused enqueue
  // never stops the rest — the candidates stand either way, and the next
  // scan of the title re-enqueues what this pass could not.
  if (input.enqueueCapture !== undefined) {
    for (const { url, context } of createdForCapture) {
      try {
        await input.enqueueCapture({ url, reason: "detection", context });
      } catch (error) {
        input.log?.("candidates.formation failed enqueueing a detection capture", {
          queryId: input.queryId,
          url,
          err: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return outcomes;
}

/**
 * The engine whose scan issued a query, or null when the query carries no
 * scan provenance (no query plan, no scan). A candidate's first engine is
 * provenance — an attribution Patrol cannot establish is not guessed.
 */
async function engineOfQuery(
  pool: Pool,
  queryId: string,
): Promise<CandidateEngine | null> {
  const result = await pool.query<{ engine: CandidateEngine }>(
    `select s.engine from scans s
       join query_plans p on p.scan_id = s.id
       join search_queries q on q.query_plan_id = p.id
      where q.id = $1`,
    [queryId],
  );
  return result.rows[0]?.engine ?? null;
}

/**
 * Creates (or returns) the candidate a manual entry names: the operator's
 * URL paired with the tracked title they selected, source `manual`, no
 * engine, and the operator as actor. An existing pair is returned unchanged
 * — the deduplication key already names it. The matched variant is the
 * title's original variant, and the score is the formation score (the URL
 * slug), exactly like a SERP-formed pair. Throws when the title does not
 * exist or was merged; the caller decides how that reaches the operator.
 */
export async function formManualCandidate(
  pool: Pool,
  now: () => Date,
  input: {
    url: string;
    trackedTitleId: string;
    operatorId: string;
    enqueueCapture?: EnqueueDetectionCapture;
  },
): Promise<FormationOutcome> {
  const title = await loadTitleForMatching(pool, input.trackedTitleId);
  if (title === null) {
    throw new Error(`tracked title ${input.trackedTitleId} not found`);
  }
  const existing = await candidateForPair(pool, {
    url: input.url,
    trackedTitleId: input.trackedTitleId,
  });
  if (existing !== null) {
    return {
      candidate: existing,
      created: false,
      allowlistEntryId: existing.allowlistEntryId,
    };
  }

  const scored = initialCandidateScore({
    title,
    url: input.url,
    reputation: await readReputationFacts(pool, now, registrableDomainForUrl(input.url)),
  });
  const allowlist = await scopedAllowlistEntries(pool, {
    titleGroupId: title.titleGroupId,
    trackedTitleId: title.id,
  });
  const hit = allowlistHitForPair(allowlist, {
    url: input.url,
    titleGroupId: title.titleGroupId,
    trackedTitleId: title.id,
    territory: null,
  });
  const matchedVariant = title.variants.find(
    (variant) => variant.id === title.originalVariantId,
  )!;

  const client = await pool.connect();
  let outcome: FormationOutcome;
  try {
    await client.query("begin");
    const result = await upsertPair(client, now, {
      url: input.url,
      host: hostForUrl(input.url),
      registrableDomain: registrableDomainForUrl(input.url),
      trackedTitleId: title.id,
      source: "manual",
      engine: null,
      queryId: null,
      queryText: null,
      locale: null,
      territory: null,
      rank: null,
      matchedVariantId: title.originalVariantId,
      matchedVariantJson: JSON.stringify(variantSnapshot(matchedVariant)),
      score: scored.score,
      band: scored.band,
      scoreComponentsJson: JSON.stringify(scored.components),
      reputationJson: JSON.stringify(scored.reputation),
      allowlistEntryId: hit?.id ?? null,
      allowlistKind: hit?.kind ?? null,
      createdBy: input.operatorId,
      resultIds: [],
    });
    await client.query("commit");
    outcome = {
      candidate: result.row,
      created: result.created,
      allowlistEntryId: hit?.id ?? null,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  if (outcome.created && outcome.allowlistEntryId === null && input.enqueueCapture !== undefined) {
    await input.enqueueCapture({
      url: input.url,
      reason: "detection",
      context: {
        titleGroupId: title.titleGroupId,
        trackedTitleId: title.id,
        territory: null,
      },
    });
  }
  return outcome;
}

/** Twelve months, the reputation window. */
export const REPUTATION_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * The reputation facts for one registrable domain: confirmed violations of
 * the last twelve months. A confirmed candidate is an operator-confirmed
 * violation — the violation row the decision creates (slice 5b) carries the
 * same confirmation — so the confirmed-candidate count is the domain's
 * standing until the violations table exists to read instead. Blocklists
 * have no stored source yet ("reputation blocklists" arrive with the review
 * slice's learning paths), so `blocklisted` reads false until one does.
 */
export async function readReputationFacts(
  pool: Pool,
  now: () => Date,
  registrableDomain: string,
): Promise<ReputationFacts> {
  // TODO(slice-5b): swap this interim source — the confirmed-candidate
  // count — for the violations table the review decision writes, so the
  // reputation aggregate reads the violation rows themselves.
  const cutoff = new Date(now().getTime() - REPUTATION_WINDOW_MS);
  const result = await pool.query<{ count: string }>(
    `select count(*) as count from candidates
      where registrable_domain = $1 and state = 'confirmed' and confirmed_at >= $2`,
    [registrableDomain, cutoff],
  );
  // TODO(slice-5b): wire a blocklist source. `blocklisted` is seam-false
  // until the review slice's reputation blocklists exist to read; a real
  // source must land here, not a hardcoded constant.
  return { confirmedViolations: Number(result.rows[0].count), blocklisted: false };
}

/**
 * The player hosts among a capture's facts that reputation knows: at least
 * one confirmed violation at the host's registrable domain in the last
 * twelve months. (A blocklist hit would qualify too; no blocklist source is
 * stored yet.)
 */
export async function knownBadPlayerHosts(
  pool: Pool,
  now: () => Date,
  hosts: readonly string[],
): Promise<(host: string) => boolean> {
  const domains = [
    ...new Set(
      hosts
        .map((host) => {
          try {
            return registrableDomainFor(host);
          } catch {
            return null;
          }
        })
        .filter((domain): domain is string => domain !== null),
    ),
  ];
  if (domains.length === 0) {
    return () => false;
  }
  const cutoff = new Date(now().getTime() - REPUTATION_WINDOW_MS);
  // TODO(slice-5b): this known-bad set reads the same interim source as
  // readReputationFacts — confirmed candidates standing in for violations —
  // and shares its blocklist seam (no blocklist source is stored yet).
  const result = await pool.query<{ registrable_domain: string }>(
    `select distinct registrable_domain from candidates
      where registrable_domain = any($1::text[]) and state = 'confirmed' and confirmed_at >= $2`,
    [domains, cutoff],
  );
  const bad = new Set(result.rows.map((row) => row.registrable_domain));
  return (host: string): boolean => {
    try {
      return bad.has(registrableDomainFor(host));
    } catch {
      return false;
    }
  };
}

/**
 * Deepens the scores of one URL's pending candidates from a capture's
 * extraction sidecar: the exact or partial page-title match, the signals
 * the page's facts fire, and reputation applied only alongside a strong
 * signal. The frozen variant snapshot and the observation summary stand —
 * a candidate explains the observation it was formed from, and the score
 * explains the latest captured evidence. Confirmed and dismissed candidates
 * keep their decision-time scores; their lifecycle is the review slice's.
 * Returns the candidates rescored.
 */
export async function rescoreCandidatesFromSidecar(
  pool: Pool,
  now: () => Date,
  input: { normalizedUrl: string; sidecar: string | null },
): Promise<CandidateRow[]> {
  const candidates = await pool.query<RawCandidateRow>(
    `select ${CANDIDATE_COLUMNS} from candidates
      where normalized_url = $1 and state = 'pending'`,
    [input.normalizedUrl],
  );
  if (candidates.rows.length === 0) {
    return [];
  }
  const facts = parseSidecar(input.sidecar);
  const playerHosts = [
    ...new Set(
      facts.playerCandidates
        .map((candidate) => {
          try {
            return hostForUrl(candidate);
          } catch {
            return null;
          }
        })
        .filter((host): host is string => host !== null),
    ),
  ];
  const knownBad = await knownBadPlayerHosts(pool, now, playerHosts);

  const rescored: CandidateRow[] = [];
  for (const raw of candidates.rows) {
    const title = await loadTitleForMatching(pool, raw.tracked_title_id);
    if (title === null) {
      continue;
    }
    const reputation = await readReputationFacts(pool, now, raw.registrable_domain);
    const scored = scoreFromPage({
      title,
      url: raw.url,
      sidecar: input.sidecar,
      reputation,
      playerHostKnownBad: knownBad,
      now: now(),
    });
    await pool.query(
      `update candidates
          set score = $2, band = $3, score_components = $4::jsonb,
              reputation = $5::jsonb, updated_at = $6
        where id = $1`,
      [
        raw.id,
        scored.score,
        scored.band,
        JSON.stringify(scored.components),
        JSON.stringify(scored.reputation),
        now(),
      ],
    );
    rescored.push({
      ...mapCandidate(raw),
      score: scored.score,
      band: scored.band,
      scoreComponents: scored.components as unknown as Record<string, unknown>,
      reputation: scored.reputation as unknown as Record<string, unknown>,
    });
  }
  return rescored;
}
