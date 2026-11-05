import type { Pool } from "pg";

/**
 * The dashboard suites' shared seeding (slice 8): catalogue rows with
 * controlled timestamps, violations with hand-set lifecycles, the notices
 * and submissions the counters and the recipient grouping read, finished
 * scans, and review decisions — the four activity sources the feed merges.
 * Every helper writes the minimum the schema's CHECKs demand, so the
 * expected numbers the tests assert stay hand-derived from the design
 * document's definitions rather than from whatever the write paths happen
 * to stamp.
 */

/** One title group. */
export async function seedGroup(pool: Pool, name: string): Promise<string> {
  const group = await pool.query<{ id: string }>(
    `insert into title_groups (name, locales) values ($1, '{en}') returning id`,
    [name],
  );
  return group.rows[0].id;
}

/** One operator-defined group when a test does not care which. */
export async function anyGroup(pool: Pool): Promise<string> {
  const group = await pool.query<{ id: string }>(
    `insert into title_groups (name, locales)
     values ('Dashboard group ' || uuidv7()::text, '{en}') returning id`,
  );
  return group.rows[0].id;
}

export interface SeedTitle {
  groupId: string;
  name: string;
  createdAt: string;
  /** When the title was paused; null leaves it running. */
  pausedAt?: string;
  /** When a paused title resumed; closes the seeded pause period. */
  resumedAt?: string;
}

/** One tracked title with its original variant and a controlled birth date. */
export async function seedTrackedTitle(
  pool: Pool,
  operatorId: string,
  input: SeedTitle,
): Promise<{ titleId: string; variantId: string }> {
  // The current-state columns read the way the write path leaves them: a
  // resumed title runs again (paused_at null) with its pause interval
  // living in the periods table alone.
  const running = input.pausedAt === undefined || input.resumedAt !== undefined;
  const title = await pool.query<{ id: string }>(
    `insert into tracked_titles
       (title_group_id, release_year, title_type, paused, paused_at, source,
        entered_by, entered_at, updated_by, created_at, updated_at)
     values ($1, 2024, 'film', $3, $2, 'operator_knowledge', $4, $5, $4, $5, $5)
     returning id`,
    [
      input.groupId,
      running ? null : (input.pausedAt ?? null),
      !running,
      operatorId,
      input.createdAt,
    ],
  );
  if (input.pausedAt !== undefined) {
    // The pause period the chart's per-day probe reads, closed by the
    // resume instant when one is seeded.
    await pool.query(
      "insert into title_pause_periods (tracked_title_id, paused_at, resumed_at) values ($1, $2, $3)",
      [title.rows[0].id, input.pausedAt, input.resumedAt ?? null],
    );
  }
  const variant = await pool.query<{ id: string }>(
    `insert into title_variants
       (tracked_title_id, text, normalized_text, kind, language, script, source, added_by, added_at)
     values ($1, $2, lower($2), 'original', 'en', 'Latn', 'operator_knowledge', $3, $4) returning id`,
    [title.rows[0].id, input.name, operatorId, input.createdAt],
  );
  await pool.query(
    "update tracked_titles set original_variant_id = $2 where id = $1",
    [title.rows[0].id, variant.rows[0].id],
  );
  return { titleId: title.rows[0].id, variantId: variant.rows[0].id };
}

export interface SeedViolation {
  titleId: string;
  variantId: string;
  url: string;
  /** When the pair was first observed — the open series' anchor. */
  detectedAt: string;
  /** open leaves closedAt unset; removed/closed carry it. */
  state?: "open" | "removed" | "closed";
  closedAt?: string;
  /** Every engine that surfaced the pair; drives the engine grouping. */
  engines?: string[];
}

/**
 * One violation with its confirmed candidate and decision. The detected and
 * closed instants are the test's to set: the chart's day semantics are the
 * object under test, so nothing here derives them.
 */
export async function seedViolation(
  pool: Pool,
  operatorId: string,
  input: SeedViolation,
): Promise<{ violationId: string; candidateId: string; decisionId: string }> {
  const state = input.state ?? "open";
  const host = new URL(input.url).hostname;
  const normalized = `${host}${new URL(input.url).pathname}`;
  const engines = input.engines ?? ["google"];
  const candidate = await pool.query<{ id: string }>(
    `insert into candidates
       (tracked_title_id, url, normalized_url, host, registrable_domain, source, engine,
        engines, best_rank, matched_variant_id, matched_variant, score, band,
        score_components, reputation, first_seen_at, last_observed_at, state,
        review_decision_id, violation_id, confirmed_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'serp', $6, $7, 1, $8,
        '{"id":"x","text":"v","kind":"original","language":"en","script":"Latn"}'::jsonb,
        0.75, 'b', '{"titleMatch":0.6,"signals":[],"reputation":0}'::jsonb,
        '{"registrableDomain":"","confirmedViolations":0,"bonus":0,"blocklisted":false}'::jsonb,
        $9, $9, 'pending', null, null, null, $9, $9)
     returning id`,
    [
      input.titleId,
      input.url,
      normalized,
      host,
      host.split(".").slice(-2).join("."),
      engines[0] ?? null,
      engines,
      input.variantId,
      input.detectedAt,
    ],
  );
  const ids = await pool.query<{ decision_id: string; violation_id: string }>(
    "select uuidv7()::text as decision_id, uuidv7()::text as violation_id",
  );
  const decisionId = ids.rows[0].decision_id;
  const violationId = ids.rows[0].violation_id;
  await pool.query(
    `insert into review_decisions (id, candidate_id, operator_id, action, decided_at, evidence_ids, violation_id)
     values ($1, $2, $3, 'violation', $4, '{}'::uuid[], $5)`,
    [decisionId, candidate.rows[0].id, operatorId, input.detectedAt, violationId],
  );
  await pool.query(
    `insert into violations
       (id, tracked_title_id, candidate_id, review_decision_id, url, normalized_url, host,
        host_source, registrable_domain, detected_at, confirmed_at, confirmed_by, state, opened_at,
        created_at, closed_at, closure_reason, closure_note, closed_by)
     values ($1, $2, $3, $4, $5, $6, $7, 'landing_page', $8, $9, $9, $10, $11, $9, $9,
        $12, $13, $14, $15)`,
    [
      violationId,
      input.titleId,
      candidate.rows[0].id,
      decisionId,
      input.url,
      normalized,
      host,
      host.split(".").slice(-2).join("."),
      input.detectedAt,
      operatorId,
      state,
      input.closedAt ?? null,
      state === "open" ? null : state === "removed" ? "url_removed" : "operator_closed",
      state === "closed" ? "seed closure" : null,
      state === "closed" ? operatorId : null,
    ],
  );
  await pool.query(
    `update candidates set state = 'confirmed', review_decision_id = $2, violation_id = $3,
        confirmed_at = $4 where id = $1`,
    [candidate.rows[0].id, decisionId, violationId, input.detectedAt],
  );
  return { violationId, candidateId: candidate.rows[0].id, decisionId };
}

/** One pending review candidate, optionally suppressed into band C. */
export async function seedPendingCandidate(
  pool: Pool,
  operatorId: string,
  input: { titleId: string; variantId: string; url: string; band?: "a" | "b" | "c" },
): Promise<string> {
  const host = new URL(input.url).hostname;
  const normalized = `${host}${new URL(input.url).pathname}`;
  const candidate = await pool.query<{ id: string }>(
    `insert into candidates
       (tracked_title_id, url, normalized_url, host, registrable_domain, source, engine,
        engines, best_rank, matched_variant_id, matched_variant, score, band,
        score_components, reputation, first_seen_at, last_observed_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'serp', 'google', '{google}', 1, $6,
        '{"id":"x","text":"v","kind":"original","language":"en","script":"Latn"}'::jsonb,
        0.75, $7, '{"titleMatch":0.6,"signals":[],"reputation":0}'::jsonb,
        '{"registrableDomain":"","confirmedViolations":0,"bonus":0,"blocklisted":false}'::jsonb,
        '2025-12-31T00:00:00Z', '2025-12-31T00:00:00Z', '2025-12-31T00:00:00Z', '2025-12-31T00:00:00Z')
     returning id`,
    [input.titleId, input.url, normalized, host, host.split(".").slice(-2).join("."), input.variantId, input.band ?? "b"],
  );
  return candidate.rows[0].id;
}

/** One review decision on a pending candidate (the feed's decision kind). */
export async function seedDecision(
  pool: Pool,
  operatorId: string,
  input: { candidateId: string; action: string; decidedAt: string },
): Promise<string> {
  const decision = await pool.query<{ id: string }>(
    `insert into review_decisions (candidate_id, operator_id, action, decided_at, evidence_ids)
     values ($1, $2, $3, $4, '{}'::uuid[]) returning id`,
    [input.candidateId, operatorId, input.action, input.decidedAt],
  );
  return decision.rows[0].id;
}

/** One approved notice citing the given violations. */
export async function seedApprovedNotice(
  pool: Pool,
  input: {
    recipient: "google" | "bing" | "yandex";
    profileId: string;
    operatorId: string;
    composedAt: string;
    approvedAt: string;
    citations: Array<{ violationId: string; titleId: string; url: string }>;
    template?: string;
  },
): Promise<string> {
  const template =
    input.template ??
    ({
      google: "google-search.en.v1@ed9f34155836",
      bing: "bing.en.v1@e36eaf64fd3c",
      yandex: "yandex.en.v1@209722198e33",
    }[input.recipient]);
  // Composed as a draft (the freeze triggers hold from approval on, so the
  // citations must land first), then approved in place.
  const notice = await pool.query<{ id: string }>(
    `insert into notices
       (recipient, recipient_profile_id, channel, state, template_version, language,
        composed_at, composed_by, trigger_kind)
     values ($1, $2, 'web_form', 'draft', $3, 'en', $4, $5, 'on_demand') returning id`,
    [input.recipient, input.profileId, template, input.composedAt, input.operatorId],
  );
  let position = 0;
  for (const citation of input.citations) {
    const host = new URL(citation.url).hostname;
    const normalized = `${host}${new URL(citation.url).pathname}`;
    await pool.query(
      `insert into notice_citations
         (notice_id, violation_id, recipient_profile_id, tracked_title_id, url, normalized_url, state, position)
       values ($1, $2, $3, $4, $5, $6, 'draft', $7)`,
      [
        notice.rows[0].id,
        citation.violationId,
        input.profileId,
        citation.titleId,
        citation.url,
        normalized,
        position,
      ],
    );
    position += 1;
  }
  // The transition out of draft is approval's own write; the citations'
  // state mirror is the one sanctioned update afterwards.
  await pool.query(
    `update notices set state = 'approved', approved_by = $2, approved_at = $3,
        rights_holder_snapshot = '{"legalName":"Example Rights GmbH"}'::jsonb,
        signatory_snapshot = '{"fullLegalName":"Anna Beispiel"}'::jsonb,
        profile_snapshot = '{"recipient":"seed"}'::jsonb
     where id = $1`,
    [notice.rows[0].id, input.operatorId, input.approvedAt],
  );
  await pool.query(
    `update notice_citations set state = 'approved' where notice_id = $1`,
    [notice.rows[0].id],
  );
  return notice.rows[0].id;
}

/** One draft notice (no citations needed for the counters). */
export async function seedDraftNotice(
  pool: Pool,
  input: { recipient: "google" | "bing" | "yandex"; profileId: string; operatorId: string; composedAt: string },
): Promise<string> {
  const template = {
    google: "google-search.en.v1@ed9f34155836",
    bing: "bing.en.v1@e36eaf64fd3c",
    yandex: "yandex.en.v1@209722198e33",
  }[input.recipient];
  const notice = await pool.query<{ id: string }>(
    `insert into notices
       (recipient, recipient_profile_id, channel, state, template_version, language,
        composed_at, composed_by, trigger_kind)
     values ($1, $2, 'web_form', 'draft', $3, 'en', $4, $5, 'on_demand') returning id`,
    [input.recipient, input.profileId, template, input.composedAt, input.operatorId],
  );
  return notice.rows[0].id;
}

/** One acknowledged submission on an approved notice. */
export async function seedAcknowledgedSubmission(
  pool: Pool,
  input: {
    noticeId: string;
    profileId: string;
    operatorId: string;
    acknowledgedAt: string;
    recipient: "google" | "bing" | "yandex";
  },
): Promise<string> {
  const submission = await pool.query<{ id: string }>(
    `insert into submissions
       (notice_id, recipient_profile_id, channel, state, attempt_count, pack_language,
        operator_id, delivered_at, attested_at, statement_version, acknowledgement, acknowledged_at)
     values ($1, $2, 'web_form', 'acknowledged', 1, 'en', $3, $4, $4, 'google-search.en.v1@ed9f34155836',
        '{"caseId":"123","dashboardUrl":"https://example.test/d"}'::jsonb, $4)
     returning id`,
    [input.noticeId, input.profileId, input.operatorId, input.acknowledgedAt],
  );
  return submission.rows[0].id;
}

/** One finished scan (the feed's three scan kinds). */
export async function seedFinishedScan(
  pool: Pool,
  input: {
    groupId: string;
    engine: "google" | "bing" | "yandex";
    state: "succeeded" | "partial" | "failed";
    finishedAt: string;
  },
): Promise<string> {
  const scan = await pool.query<{ id: string }>(
    `insert into scans
       (title_group_id, engine, due_date, trigger_kind, scan_time, state, failure_reason,
        created_at, started_at, finished_at)
     values ($1, $2, '2026-01-01', 'scheduled', '02:30', $3, $4, $5, $5, $5) returning id`,
    [
      input.groupId,
      input.engine,
      input.state,
      input.state === "failed" ? "provider_error" : null,
      input.finishedAt,
    ],
  );
  return scan.rows[0].id;
}
