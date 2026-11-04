import { v7 as uuidv7 } from "uuid";
import {
  isShortener,
  parseSidecar,
  scoreCandidate,
  type ReputationInput,
} from "@patrol/matching";
import type { Queryable } from "../db.js";
import {
  normalizeUrl,
  registrableDomainOf,
} from "../acquisition/normalize.js";

export interface CandidateFormationInput {
  scanId: string;
  engine: string;
  trackedTitleId: string;
  variantId?: string;
  locale: string;
  territory?: string;
  queryText: string;
  rank: number;
  url: string;
  title: string;
  observedAt: Date;
}

export interface FormedCandidate {
  id: string;
  allowlisted: boolean;
  objected: boolean;
}

interface VariantSnapshot {
  id: string;
  text: string;
  kind: string;
  language: string;
  script: string;
  territory?: string;
}

/**
 * Pair one search result with the tracked title whose query surfaced it.
 * Deduplicates on the normalized URL and title, records the observation, and
 * queues a detection capture unless an allowlist or objection suppresses it.
 */
export async function formCandidate(
  db: Queryable,
  input: CandidateFormationInput,
): Promise<FormedCandidate> {
  const normalizedUrl = normalizeUrl(input.url);
  const host = new URL(input.url).hostname.toLowerCase();
  const registrableDomain = registrableDomainOf(input.url);
  const title = (
    await db.query(
      `SELECT t.id, t.title_group_id, t.original_variant_id, t.runtime_minutes
         FROM tracked_title t WHERE t.id = $1`,
      [input.trackedTitleId],
    )
  ).rows[0];
  if (!title) {
    throw new Error(`The tracked title ${input.trackedTitleId} does not exist.`);
  }
  const variant = await loadVariant(db, input.variantId, title);
  const allowlist = await allowlistHit(
    db,
    input.url,
    host,
    String(title.title_group_id),
    input.trackedTitleId,
    input.territory,
  );
  const objected = await hostObjected(db, host);
  const reputation = await reputationAt(db, registrableDomain, input.observedAt);
  const facts = parseSidecar({
    title: input.title,
    h1: [input.title],
    meta: {},
    jsonLd: [],
    iframes: [],
    videos: [],
    downloadAffordances: [],
  });
  const scored = scoreCandidate(facts, {
    variantText: variant.text,
    variantLanguage: variant.language,
    runtimeMinutes:
      title.runtime_minutes === null || title.runtime_minutes === undefined
        ? undefined
        : Number(title.runtime_minutes),
    url: input.url,
    reputation,
    allowlisted: allowlist !== undefined,
    shortener: isShortener(host),
  });
  const scoreComponents = JSON.stringify({
    titleMatch: scored.titleMatch,
    signals: scored.signals,
    reputation: scored.reputation,
  });
  const reputationSnapshot = JSON.stringify({
    registrableDomain,
    confirmedViolations: reputation.confirmedViolations,
    bonus: reputationBonus(reputation.confirmedViolations),
    blocklisted: reputation.blocklisted,
  });

  const existing = (
    await db.query(
      "SELECT * FROM candidate WHERE normalized_url = $1 AND tracked_title_id = $2",
      [normalizedUrl, input.trackedTitleId],
    )
  ).rows[0];

  let candidateId: string;
  if (existing) {
    candidateId = String(existing.id);
    await db.query(
      `UPDATE candidate
          SET last_observed_at = $2,
              score = CASE WHEN score IS NULL OR score < $3 THEN $3 ELSE score END,
              score_components = CASE WHEN score IS NULL OR score < $3 THEN $4 ELSE score_components END,
              reputation = $5,
              allowlist_entry_id = $6
        WHERE id = $1`,
      [
        candidateId,
        input.observedAt,
        scored.score,
        scoreComponents,
        reputationSnapshot,
        allowlist?.id ?? null,
      ],
    );
  } else {
    candidateId = uuidv7();
    try {
      await db.query(
        `INSERT INTO candidate
          (id, tracked_title_id, state, url, normalized_url, host,
           registrable_domain, source, engine, rank, query_text, locale,
           territory, matched_variant_id, matched_variant, score,
           score_components, reputation, allowlist_entry_id,
           first_observed_at, last_observed_at, created_at)
         VALUES ($1, $2, 'pending', $3, $4, $5, $6, 'serp', $7, $8, $9,
                 $10, $11, $12, $13, $14, $15, $16, $17, $18, $18, $18)`,
        [
          candidateId,
          input.trackedTitleId,
          input.url,
          normalizedUrl,
          host,
          registrableDomain,
          input.engine,
          input.rank,
          input.queryText,
          input.locale,
          input.territory ?? null,
          variant.id,
          JSON.stringify(variant),
          scored.score,
          scoreComponents,
          reputationSnapshot,
          allowlist?.id ?? null,
          input.observedAt,
        ],
      );
    } catch {
      const raced = (
        await db.query(
          "SELECT id FROM candidate WHERE normalized_url = $1 AND tracked_title_id = $2",
          [normalizedUrl, input.trackedTitleId],
        )
      ).rows[0];
      if (!raced) {
        throw new Error("The candidate could not be recorded.");
      }
      candidateId = String(raced.id);
    }
  }

  if (!allowlist && !objected) {
    const pending = (
      await db.query(
        `SELECT id FROM capture_request
          WHERE candidate_id = $1 AND reason = 'detection'
            AND state IN ('pending', 'queued')
          LIMIT 1`,
        [candidateId],
      )
    ).rows[0];
    if (!pending) {
      await db.query(
        `INSERT INTO capture_request
        (id, url, normalized_url, reason, candidate_id, tracked_title_id,
         title_group_id, state, created_at)
       VALUES ($1, $2, $3, 'detection', $4, $5, $6, 'pending', $7)`,
      [
        uuidv7(),
        input.url,
        normalizedUrl,
        candidateId,
        input.trackedTitleId,
        title.title_group_id,
        input.observedAt,
      ],
    );
    }
  }

  return {
    id: candidateId,
    allowlisted: allowlist !== undefined,
    objected,
  };
}

async function loadVariant(
  db: Queryable,
  variantId: string | undefined,
  title: Record<string, unknown>,
): Promise<VariantSnapshot> {
  const id = variantId ?? String(title.original_variant_id ?? "");
  if (id !== "") {
    const row = (
      await db.query("SELECT * FROM title_variant WHERE id = $1", [id])
    ).rows[0];
    if (row) {
      return {
        id: String(row.id),
        text: String(row.text),
        kind: String(row.kind),
        language: String(row.language),
        script: String(row.script),
        ...(row.territory ? { territory: String(row.territory) } : {}),
      };
    }
  }
  return {
    id: "",
    text: "",
    kind: "original",
    language: "en",
    script: "Latn",
  };
}

async function allowlistHit(
  db: Queryable,
  url: string,
  host: string,
  titleGroupId: string,
  trackedTitleId: string,
  territory: string | undefined,
): Promise<Record<string, unknown> | undefined> {
  const rows = (
    await db.query(
      `SELECT * FROM allowlist_entry
        WHERE removed_at IS NULL
          AND (scope = 'rights_holder'
            OR (scope = 'title_group' AND title_group_id = $1)
            OR (scope = 'tracked_title' AND tracked_title_id = $2))`,
      [titleGroupId, trackedTitleId],
    )
  ).rows;
  return rows.find((row) => {
    if (
      row.kind === "licensed_destination" &&
      row.territory &&
      row.territory !== "*" &&
      territory !== row.territory
    ) {
      return false;
    }
    const value = String(row.value).toLowerCase();
    return row.match_kind === "host"
      ? host === value || host.endsWith(`.${value}`)
      : url.startsWith(String(row.value));
  });
}

async function hostObjected(
  db: Queryable,
  host: string,
): Promise<boolean> {
  const row = (
    await db.query(
      "SELECT id FROM host_objection WHERE host = $1 AND cleared_at IS NULL LIMIT 1",
      [host],
    )
  ).rows[0];
  return row !== undefined;
}

export async function reputationAt(
  db: Queryable,
  registrableDomain: string,
  now: Date,
): Promise<ReputationInput> {
  const since = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const count = (
    await db.query(
      `SELECT COUNT(*)::int AS count FROM violation
        WHERE registrable_domain = $1 AND confirmed_at >= $2`,
      [registrableDomain, since],
    )
  ).rows[0]?.count;
  const blocklisted = (
    await db.query("SELECT domain FROM blocklist WHERE domain = $1", [
      registrableDomain,
    ])
  ).rows[0];
  return {
    confirmedViolations: Number(count ?? 0),
    blocklisted: blocklisted !== undefined,
  };
}

function reputationBonus(count: number): number {
  return count >= 10 ? 0.1 : count >= 3 ? 0.05 : count >= 1 ? 0.02 : 0;
}
