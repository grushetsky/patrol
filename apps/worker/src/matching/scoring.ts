import {
  isShortener,
  parseSidecar,
  scoreCandidate,
  type SignalKind,
} from "@patrol/matching";
import type { Queryable } from "../db.js";
import {
  hostOf,
  registrableDomainOf,
} from "../acquisition/normalize.js";
import { reputationAt } from "./candidates.js";

export interface ScoredCapture {
  candidateId: string;
  sidecar?: Record<string, unknown>;
  dom?: string;
  finalUrl?: string;
  host?: string;
  outcome: string;
  observedAt: Date;
}

/**
 * Rescore a candidate from the captured page, and reopen a dismissed pair when
 * the capture shows a material change: a new strong signal, an expanded
 * episode range, a different landing domain, or content on a dead page.
 */
export async function scoreCandidateAfterCapture(
  db: Queryable,
  input: ScoredCapture,
): Promise<void> {
  const candidate = (
    await db.query("SELECT * FROM candidate WHERE id = $1", [input.candidateId])
  ).rows[0];
  if (!candidate) {
    return;
  }
  const title = (
    await db.query("SELECT * FROM tracked_title WHERE id = $1", [
      candidate.tracked_title_id,
    ])
  ).rows[0];
  if (!title) {
    return;
  }
  const variant = candidate.matched_variant
    ? (JSON.parse(String(candidate.matched_variant)) as {
        text?: string;
        language?: string;
      })
    : undefined;
  const finalUrl = input.finalUrl ?? String(candidate.url ?? "");
  const host = input.host ?? hostOf(finalUrl);
  const registrableDomain = registrableDomainOf(finalUrl);
  const facts = parseSidecar(input.sidecar, input.dom);
  const reputation = await reputationAt(db, registrableDomain, input.observedAt);
  const playerHosts = (
    await db.query(
      `SELECT DISTINCT host FROM violation
        WHERE host IS NOT NULL AND confirmed_at >= $1`,
      [new Date(input.observedAt.getTime() - 365 * 24 * 60 * 60 * 1000)],
    )
  ).rows.map((row) => String(row.host));
  const scored = scoreCandidate(facts, {
    variantText: variant?.text ?? "",
    variantLanguage: variant?.language,
    runtimeMinutes:
      title.runtime_minutes === null || title.runtime_minutes === undefined
        ? undefined
        : Number(title.runtime_minutes),
    url: finalUrl,
    playerHosts,
    reputation,
    allowlisted:
      candidate.allowlist_entry_id !== null &&
      candidate.allowlist_entry_id !== undefined,
    shortener: isShortener(host),
  });

  const dismissal = candidate.dismissal
    ? (JSON.parse(String(candidate.dismissal)) as { action?: string })
    : undefined;
  const baselineSignals = new Set<SignalKind>(
    candidate.dismissal_signals
      ? (JSON.parse(String(candidate.dismissal_signals)) as SignalKind[])
      : [],
  );
  const episodeMax = facts.episodeNumbers.at(-1) ?? 0;
  const reopenable =
    dismissal?.action === "not_a_violation" || dismissal?.action === "page_dead";
  const reopened =
    candidate.state === "dismissed" &&
    reopenable &&
    ((dismissal?.action === "page_dead" && input.outcome === "captured") ||
      scored.signals.some((signal) => !baselineSignals.has(signal.kind)) ||
      episodeMax > Number(candidate.dismissal_episode_max ?? 0) ||
      (candidate.dismissal_registrable_domain !== null &&
        candidate.dismissal_registrable_domain !== undefined &&
        String(candidate.dismissal_registrable_domain) !== registrableDomain));

  await db.query(
    `UPDATE candidate
        SET final_url = $2, host = $3, registrable_domain = $4,
            score = $5, score_components = $6, reputation = $7,
            last_observed_at = $8, episode_max = $10,
            state = CASE WHEN $9 THEN 'pending' ELSE state END,
            dismissal = CASE WHEN $9 THEN NULL ELSE dismissal END,
            dismissal_signals = CASE WHEN $9 THEN NULL ELSE dismissal_signals END,
            dismissal_episode_max = CASE WHEN $9 THEN NULL ELSE dismissal_episode_max END,
            dismissal_registrable_domain = CASE WHEN $9 THEN NULL ELSE dismissal_registrable_domain END,
            review_decision_id = CASE WHEN $9 THEN NULL ELSE review_decision_id END,
            violation_id = CASE WHEN $9 THEN NULL ELSE violation_id END,
            confirmed_at = CASE WHEN $9 THEN NULL ELSE confirmed_at END
      WHERE id = $1`,
    [
      input.candidateId,
      finalUrl,
      host,
      registrableDomain,
      scored.score,
      JSON.stringify({
        titleMatch: scored.titleMatch,
        signals: scored.signals,
        reputation: scored.reputation,
      }),
      JSON.stringify({
        registrableDomain,
        confirmedViolations: reputation.confirmedViolations,
        bonus: reputationBonus(reputation.confirmedViolations),
        blocklisted: reputation.blocklisted,
      }),
      input.observedAt,
      reopened,
      episodeMax,
    ],
  );
}

function reputationBonus(count: number): number {
  return count >= 10 ? 0.1 : count >= 3 ? 0.05 : count >= 1 ? 0.02 : 0;
}
