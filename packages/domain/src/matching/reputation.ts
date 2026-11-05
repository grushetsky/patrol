/**
 * The reputation aggregate (docs/design/matching-and-classification-rules.md
 * "Score and bands", "Hosts and reputation"). Reputation keys by registrable
 * domain — subdomains share it — and counts confirmed violations in the last
 * twelve months:
 *
 * | Confirmed violations | Reputation bonus |
 * | --- | --- |
 * | 1–2 | 0.02 |
 * | 3–9 | 0.05 |
 * | 10 or more | 0.10 |
 *
 * A blocklist hit adds 0.02 and the total contribution is capped at 0.10. It
 * applies only when the candidate has at least one strong signal, so it can
 * corroborate page evidence but never promote a candidate that has nothing
 * beyond a title match. A blocklist never vetoes a per-URL match; it only
 * feeds this number.
 */

/** The contract's ReputationSnapshot. */
export interface ReputationSnapshot {
  /** The registrable domain the reputation belongs to. */
  registrableDomain: string;
  /** Confirmed violations at the domain in the last twelve months. */
  confirmedViolations: number;
  /** The bonus the count earned, before the cap. */
  bonus: number;
  /** Whether a blocklist entry added its small contribution. */
  blocklisted: boolean;
}

/** The bonus a 1–2 violation domain earns. */
export const REPUTATION_FEW_BONUS = 0.02;

/** The bonus a 3–9 violation domain earns. */
export const REPUTATION_SEVERAL_BONUS = 0.05;

/** The bonus a 10-or-more violation domain earns. */
export const REPUTATION_MANY_BONUS = 0.1;

/** What a blocklist hit adds. */
export const BLOCKLIST_BONUS = 0.02;

/** The most reputation can ever contribute. */
export const REPUTATION_CAP = 0.1;

/**
 * The snapshot for one registrable domain. `confirmedViolations` is the
 * twelve-month count the caller read; the buckets are the document's.
 */
export function reputationSnapshot(
  registrableDomain: string,
  confirmedViolations: number,
  blocklisted: boolean,
): ReputationSnapshot {
  let bonus = 0;
  if (confirmedViolations >= 10) {
    bonus = REPUTATION_MANY_BONUS;
  } else if (confirmedViolations >= 3) {
    bonus = REPUTATION_SEVERAL_BONUS;
  } else if (confirmedViolations >= 1) {
    bonus = REPUTATION_FEW_BONUS;
  }
  return {
    registrableDomain,
    confirmedViolations,
    bonus,
    blocklisted,
  };
}

/**
 * The reputation contribution to a score: the earned bonus plus the
 * blocklist's, capped at 0.10, and zero unless at least one strong signal
 * fired. Reputation alone never promotes a candidate.
 */
export function reputationContribution(
  snapshot: ReputationSnapshot,
  hasStrongSignal: boolean,
): number {
  if (!hasStrongSignal) {
    return 0;
  }
  return Math.min(
    REPUTATION_CAP,
    snapshot.bonus + (snapshot.blocklisted ? BLOCKLIST_BONUS : 0),
  );
}
