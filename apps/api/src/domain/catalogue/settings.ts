import type { Pool, PoolClient } from "pg";
import { ApiError } from "../../errors.js";
import { allowanceUnits, type EngineName } from "./capacity.js";
import { rightsHolderJson, type RightsHolderRow } from "./serialize.js";

/**
 * Settings reads and writes: the rights holder and its signatory, and the
 * acquisition budget with its derived per-engine allowance. The budget is
 * embedded in the rights holder row (the domain model nests
 * AcquisitionBudget inside RightsHolder). Lowering a cap never un-spends
 * what the ledger committed — no endpoint deletes a ledger row, and the
 * ledger itself arrives with slice 3.
 */

export async function readRightsHolderRow(
  pool: Pool | PoolClient,
): Promise<RightsHolderRow> {
  const result = await pool.query<RightsHolderRow>(
    "select * from rights_holder limit 1",
  );
  if (result.rows.length === 0) {
    throw new ApiError(503, "setup_required");
  }
  return result.rows[0];
}

export interface UpdateRightsHolderInput {
  legalName?: string;
  country?: string;
  address?: {
    line1: string;
    line2?: string;
    city: string;
    region?: string;
    postalCode: string;
    country: string;
  };
  roleMailbox?: string;
  phone?: string;
  signatory?: {
    fullLegalName: string;
    authorityBasis: string;
    contactEmail: string;
    contactPhone?: string;
  };
}

/** Edits the rights holder or its signatory. The signatory is a profile,
 * not an account: replacing it whole is the operation, so a partial
 * signatory is a validation failure, not a merge. The address's country is
 * the rights holder's country — one column, one fact — so the composite's
 * country persists there, taking precedence over the top-level field in
 * the same request as the more specific statement of the same fact. */
export async function updateRightsHolder(
  pool: Pool,
  now: () => Date,
  input: UpdateRightsHolderInput,
): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await readRightsHolderRow(client);
    const address = input.address;
    const signatory = input.signatory;
    const country = address?.country ?? input.country ?? null;
    const updated = await client.query<RightsHolderRow>(
      `update rights_holder set
         legal_name = coalesce($1, legal_name),
         country = coalesce($2, country),
         address_line1 = coalesce($3, address_line1),
         address_line2 = coalesce($4, address_line2),
         address_city = coalesce($5, address_city),
         address_region = coalesce($6, address_region),
         address_postal_code = coalesce($7, address_postal_code),
         role_mailbox = coalesce($8, role_mailbox),
         phone = coalesce($9, phone),
         signatory_full_legal_name = coalesce($10, signatory_full_legal_name),
         signatory_authority_basis = coalesce($11, signatory_authority_basis),
         signatory_contact_email = coalesce($12, signatory_contact_email),
         signatory_contact_phone = coalesce($13, signatory_contact_phone),
         updated_at = $14
       where singleton
       returning *`,
      [
        input.legalName ?? null,
        country,
        address?.line1 ?? null,
        address?.line2 ?? null,
        address?.city ?? null,
        address?.region ?? null,
        address?.postalCode ?? null,
        input.roleMailbox ?? null,
        input.phone ?? null,
        signatory?.fullLegalName ?? null,
        signatory?.authorityBasis ?? null,
        signatory?.contactEmail ?? null,
        signatory?.contactPhone ?? null,
        now().toISOString(),
      ],
    );
    await client.query("commit");
    return rightsHolderJson(updated.rows[0]);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface BudgetCaps {
  google: number;
  yandex: number;
  bing: number;
  recheckSharePercent: number;
}

/** The caps as the rights holder row stores them. */
export async function readBudgetCaps(pool: Pool): Promise<BudgetCaps> {
  const row = await readRightsHolderRow(pool);
  return {
    google: row.budget_google_monthly_cap_minor,
    yandex: row.budget_yandex_monthly_cap_minor,
    bing: row.budget_bing_monthly_cap_minor,
    recheckSharePercent: row.budget_recheck_share_percent,
  };
}

export interface BudgetPutInput {
  engineCaps: Array<{
    engine: EngineName;
    currency: string;
    monthlyCapMinor: number;
  }>;
  recheckSharePercent: number;
}

/** Validates and persists the budget. Caps are non-negative minor units;
 * the re-check share is a percentage between zero and one hundred. The JSON
 * Schema enforces both bounds already; the explicit re-check guards the
 * engine list's shape (an unknown engine, a duplicate engine, or a
 * non-USD currency is a request that misstates the budget). */
export async function updateBudget(
  pool: Pool,
  now: () => Date,
  input: BudgetPutInput,
): Promise<BudgetCaps> {
  const caps: Partial<Record<EngineName, number>> = {};
  for (const cap of input.engineCaps) {
    if (cap.engine !== "google" && cap.engine !== "bing" && cap.engine !== "yandex") {
      throw new ApiError(400, "validation_failed", {
        fieldErrors: [
          { path: "/engineCaps", message: `unknown engine ${String(cap.engine)}` },
        ],
      });
    }
    if (cap.currency !== "usd") {
      throw new ApiError(400, "validation_failed", {
        fieldErrors: [
          { path: "/engineCaps", message: "only USD caps are supported" },
        ],
      });
    }
    if (!Number.isInteger(cap.monthlyCapMinor) || cap.monthlyCapMinor < 0) {
      throw new ApiError(400, "validation_failed", {
        fieldErrors: [
          {
            path: "/engineCaps",
            message: "a monthly cap is a non-negative amount in minor units",
          },
        ],
      });
    }
    if (caps[cap.engine] !== undefined) {
      throw new ApiError(400, "validation_failed", {
        fieldErrors: [
          { path: "/engineCaps", message: `duplicate cap for ${cap.engine}` },
        ],
      });
    }
    caps[cap.engine] = cap.monthlyCapMinor;
  }
  if (
    !Number.isInteger(input.recheckSharePercent) ||
    input.recheckSharePercent < 0 ||
    input.recheckSharePercent > 100
  ) {
    throw new ApiError(400, "validation_failed", {
      fieldErrors: [
        {
          path: "/recheckSharePercent",
          message: "the re-check share is a percentage between 0 and 100",
        },
      ],
    });
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await readRightsHolderRow(client);
    await client.query(
      `update rights_holder set
         budget_google_monthly_cap_minor = $1,
         budget_yandex_monthly_cap_minor = $2,
         budget_bing_monthly_cap_minor = $3,
         budget_recheck_share_percent = $4,
         updated_at = $5`,
      [
        caps.google ?? 0,
        caps.yandex ?? 0,
        caps.bing ?? 0,
        input.recheckSharePercent,
        now().toISOString(),
      ],
    );
    await client.query("commit");
    return {
      google: caps.google ?? 0,
      yandex: caps.yandex ?? 0,
      bing: caps.bing ?? 0,
      recheckSharePercent: input.recheckSharePercent,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** One engine's derived budget position for the current UTC month. */
function engineStatus(
  engine: EngineName,
  monthlyCapMinor: number,
  recheckSharePercent: number,
): Record<string, unknown> {
  const units = allowanceUnits(engine, monthlyCapMinor);
  const scanShare = Math.floor((units * (100 - recheckSharePercent)) / 100);
  const recheckShare = units - scanShare;
  return {
    engine,
    currency: "usd",
    monthlyCapMinor,
    allowanceUnits: units,
    scanShareUnits: scanShare,
    recheckShareUnits: recheckShare,
    // Slice 3's ledger fills the used counters; nothing is spent yet.
    scanUsedUnits: 0,
    recheckUsedUnits: 0,
    exhausted: false,
    routeDisabled: false,
  };
}

/** The budget overview: the configured cap, the (empty until slice 3)
 * ledger, the derived per-engine allowance, and the (empty) alerts. */
export async function readBudgetOverview(
  pool: Pool,
): Promise<Record<string, unknown>> {
  const caps = await readBudgetCaps(pool);
  return {
    budget: {
      engineCaps: [
        { engine: "google", currency: "usd", monthlyCapMinor: caps.google },
        { engine: "bing", currency: "usd", monthlyCapMinor: caps.bing },
        { engine: "yandex", currency: "usd", monthlyCapMinor: caps.yandex },
      ],
      recheckSharePercent: caps.recheckSharePercent,
    },
    ledger: [],
    engines: [
      engineStatus("google", caps.google, caps.recheckSharePercent),
      engineStatus("bing", caps.bing, caps.recheckSharePercent),
      engineStatus("yandex", caps.yandex, caps.recheckSharePercent),
    ],
    alerts: [],
  };
}

/** How many titles the catalogue currently holds (live, not archived). */
export async function countTrackedTitles(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "select count(*) as count from tracked_titles where merged_into_title_id is null",
  );
  return Number(result.rows[0].count);
}
