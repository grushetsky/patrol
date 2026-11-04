import { ApiError, unprocessable } from "../errors.js";
import type { Connectable, Queryable } from "../db/migrations.js";
import { v5 as uuidv5 } from "uuid";
import { newId } from "../auth/tokens.js";
import { pageOf, type Page } from "../http.js";
import { normalizePlainTime } from "../time.js";
import {
  toAllowlistEntry,
  toRecipientProfile,
} from "../catalogue/records.js";

export interface PostalAddressInput {
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
}

export interface SignatoryInput {
  fullLegalName: string;
  authorityBasis: string;
  contactEmail: string;
  contactPhone?: string;
}

export interface UpdateRightsHolderInput {
  legalName?: string;
  country?: string;
  address?: PostalAddressInput;
  roleMailbox?: string;
  phone?: string;
  signatory?: SignatoryInput;
}

export interface EngineBudgetCapInput {
  engine: string;
  currency: string;
  monthlyCapMinor: number;
}

export interface AcquisitionBudgetInput {
  engineCaps: EngineBudgetCapInput[];
  recheckSharePercent: number;
}

export interface CapacityQuery {
  locales?: number;
  cadence?: string;
}

export interface UpdateRecipientProfileInput {
  channel?: string;
  account?: string;
  contactEmail?: string;
  compositionTrigger?: string;
  windowTime?: string;
  eligibleTerritories?: string[];
  maxUrlsPerNotice?: number;
  maxUrlsPerFile?: number;
  maxUrlsPerDay?: number;
}

export interface CreateAllowlistEntryInput {
  kind: string;
  matchKind: string;
  value: string;
  scope: string;
  titleGroupId?: string;
  trackedTitleId?: string;
  territory?: string;
}

export interface AllowlistFilters {
  kind?: string;
  scope?: string;
  territory?: string;
}

interface EngineCap {
  engine: string;
  currency: string;
  monthlyCapMinor: number;
}

interface BudgetConfig {
  caps: EngineCap[];
  recheckSharePercent: number;
}

export const ENGINES = ["google", "bing", "yandex"] as const;
const DEFAULT_ENGINE_CAPS: Record<
  string,
  { currency: string; monthlyCapMinor: number; unitPricePerThousandMinor: number; unitsPerQuery: number }
> = {
  google: {
    currency: "usd",
    monthlyCapMinor: 4_800,
    unitPricePerThousandMinor: 60,
    unitsPerQuery: 2,
  },
  bing: {
    currency: "usd",
    monthlyCapMinor: 0,
    unitPricePerThousandMinor: 0,
    unitsPerQuery: 0,
  },
  yandex: {
    currency: "usd",
    monthlyCapMinor: 1_200,
    unitPricePerThousandMinor: 25,
    unitsPerQuery: 1,
  },
};
const DEFAULT_RECHECK_SHARE_PERCENT = 30;
const DEFAULT_PROFILES: Array<{
  recipient: string;
  maxUrlsPerNotice: number;
  maxUrlsPerFile: number;
  formUrl: string;
}> = [
  {
    recipient: "google",
    maxUrlsPerNotice: 500,
    maxUrlsPerFile: 500,
    formUrl: "https://reportcontent.google.com/forms/dmca_search",
  },
  {
    recipient: "bing",
    maxUrlsPerNotice: 1_000,
    maxUrlsPerFile: 1_000,
    formUrl:
      "https://www.bing.com/webmaster/contentremovalform/showcontentremovalform",
  },
  {
    recipient: "yandex",
    maxUrlsPerNotice: 1,
    maxUrlsPerFile: 1,
    formUrl: "https://forms.yandex.com/surveys/1773/?lang=en&iframe=1",
  },
];
const SETTING_KEY = "recheck_share_percent";
const LEDGER_NAMESPACE = "2f8f6f7e-4a1b-4c2d-9e3f-6a5b4c3d2e1f";
const PAUSE_THRESHOLD = 0.1;
const PAUSE_WINDOW = 20;

/** Settings reads and administrator writes for the rights holder and budget. */
export class SettingsService {
  constructor(
    private readonly db: Connectable,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async readRightsHolder(operatorId: string) {
    await this.ensureBudgetDefaults(operatorId);
    const holder = await this.holder(this.db);
    const budget = await this.budget(this.db);
    return this.holderView(holder, budget);
  }

  async updateRightsHolder(
    input: UpdateRightsHolderInput,
    operatorId: string,
  ) {
    await this.ensureBudgetDefaults(operatorId);
    const holder = await this.holder(this.db);
    const sets: string[] = [];
    const values: unknown[] = [];
    if (input.legalName !== undefined) {
      values.push(input.legalName.trim());
      sets.push(`legal_name = $${values.length}`);
    }
    if (input.country !== undefined) {
      values.push(input.country);
      sets.push(`country = $${values.length}`);
    }
    if (input.address !== undefined) {
      values.push(JSON.stringify(input.address));
      sets.push(`address = $${values.length}`);
    }
    if (input.roleMailbox !== undefined) {
      values.push(input.roleMailbox);
      sets.push(`role_mailbox = $${values.length}`);
    }
    if (input.phone !== undefined) {
      values.push(input.phone);
      sets.push(`phone = $${values.length}`);
    }
    if (input.signatory !== undefined) {
      const signatory = input.signatory;
      values.push(
        signatory.fullLegalName,
        signatory.authorityBasis,
        signatory.contactEmail,
        signatory.contactPhone ?? null,
      );
      sets.push(
        `signatory_name = $${values.length - 3}`,
        `signatory_authority_basis = $${values.length - 2}`,
        `signatory_email = $${values.length - 1}`,
        `signatory_phone = $${values.length}`,
      );
    }
    values.push(this.clock());
    sets.push(`updated_at = $${values.length}`);
    await this.db.query(
      `UPDATE rights_holder SET ${sets.join(", ")} WHERE id = $${values.length + 1}`,
      [...values, holder.id],
    );
    return this.readRightsHolder(operatorId);
  }

  async readBudget(operatorId: string) {
    await this.ensureBudgetDefaults(operatorId);
    const budget = await this.budget(this.db);
    const ledger = await this.currentLedger(this.db, budget, false);
    const alerts = (
      await this.db.query(
        "SELECT * FROM budget_alert WHERE month_start = $1 ORDER BY created_at ASC",
        [this.monthStart()],
      )
    ).rows;
    const disabled = new Set(
      (
        await this.db.query(
          "SELECT engine FROM engine_route WHERE disabled_at IS NOT NULL",
        )
      ).rows.map((row) => String(row.engine)),
    );
    return {
      budget: {
        engineCaps: budget.caps.map((cap) => ({
          engine: cap.engine,
          currency: cap.currency,
          monthlyCapMinor: cap.monthlyCapMinor,
        })),
        recheckSharePercent: budget.recheckSharePercent,
      },
      ledger: ledger.map((row) => ({
        id: String(row.id),
        engine: String(row.engine),
        monthStart: String(row.month_start),
        allowanceUnits: Number(row.allowance_units),
        scanReserved: Number(row.scan_reserved),
        scanCommitted: Number(row.scan_committed),
        recheckReserved: Number(row.recheck_reserved),
        recheckCommitted: Number(row.recheck_committed),
      })),
      engines: ledger.map((row) => this.engineStatus(row, budget, disabled)),
      alerts: alerts.map((row) => ({
        engine: String(row.engine),
        bucket: String(row.bucket),
        level: String(row.level),
        percentUsed: Number(row.percent_used),
        message: String(row.message),
        groupsNotScanned: Number(row.groups_not_scanned),
      })),
    };
  }

  async updateBudget(input: AcquisitionBudgetInput, operatorId: string) {
    await this.ensureBudgetDefaults(operatorId);
    const seen = new Set<string>();
    for (const cap of input.engineCaps) {
      if (!ENGINES.includes(cap.engine as (typeof ENGINES)[number])) {
        throw unprocessable([
          { path: "/engineCaps", message: `Unknown engine ${cap.engine}.` },
        ]);
      }
      if (seen.has(cap.engine)) {
        throw unprocessable([
          { path: "/engineCaps", message: `Duplicate engine ${cap.engine}.` },
        ]);
      }
      seen.add(cap.engine);
    }
    for (const engine of ENGINES) {
      if (!seen.has(engine)) {
        throw unprocessable([
          { path: "/engineCaps", message: `The ${engine} cap is required.` },
        ]);
      }
    }
    await this.withClient(async (db) => {
      for (const cap of input.engineCaps) {
        await db.query(
          "UPDATE acquisition_budget SET currency = $2, monthly_cap_minor = $3 WHERE engine = $1",
          [cap.engine, cap.currency, cap.monthlyCapMinor],
        );
      }
      await db.query(
        "UPDATE application_setting SET value = $2 WHERE key = $1",
        [SETTING_KEY, String(input.recheckSharePercent)],
      );
      const budget = await this.budget(db);
      await this.currentLedger(db, budget, true);
      for (const cap of budget.caps) {
        await db.query(
          "UPDATE quota_ledger SET allowance_units = $3 WHERE engine = $1 AND month_start = $2",
          [
            cap.engine,
            this.monthStart(),
            this.allowanceUnits(cap.monthlyCapMinor, cap.engine),
          ],
        );
      }
    });
    return this.readBudget(operatorId);
  }

  async readCapacity(query: CapacityQuery, operatorId: string) {
    await this.ensureBudgetDefaults(operatorId);
    const locales = query.locales ?? 2;
    if (!Number.isInteger(locales) || locales < 1 || locales > 3) {
      throw new ApiError(
        400,
        "validation_failed",
        "Locales per title must be between one and three.",
      );
    }
    const cadence = query.cadence ?? "daily";
    if (!["daily", "every_other_day", "weekly"].includes(cadence)) {
      throw new ApiError(
        400,
        "validation_failed",
        "The cadence is not one of the declared values.",
      );
    }
    const scansPerMonth =
      cadence === "daily" ? 30 : cadence === "every_other_day" ? 15 : 30 / 7;
    const queriesPerTitlePerScan = locales * 3;
    const budget = await this.budget(this.db);
    const ledger = await this.currentLedger(this.db, budget, false);
    let supportedTitles = Number.MAX_SAFE_INTEGER;
    for (const row of ledger) {
      const cap = budget.caps.find((item) => item.engine === String(row.engine));
      if (!cap) {
        continue;
      }
      const defaults = DEFAULT_ENGINE_CAPS[cap.engine];
      if (!defaults || defaults.unitsPerQuery === 0) {
        continue;
      }
      const status = this.engineStatus(row, budget);
      const titleScans =
        status.scanShareUnits /
        (queriesPerTitlePerScan * defaults.unitsPerQuery);
      supportedTitles = Math.min(
        supportedTitles,
        Math.floor(titleScans / scansPerMonth),
      );
    }
    if (supportedTitles === Number.MAX_SAFE_INTEGER) {
      supportedTitles = 0;
    }
    const tracked = await this.db.query(
      "SELECT count(*) AS count FROM tracked_title WHERE merged_into_title_id IS NULL",
    );
    const trackedTitles = Number(tracked.rows[0]?.count ?? 0);
    return {
      localesPerTitle: locales,
      cadence,
      queriesPerTitlePerScan,
      supportedTitles,
      trackedTitles,
      shortfallTitles: Math.max(0, trackedTitles - supportedTitles),
    };
  }

  async listRecipientProfiles(page: Page, operatorId: string) {
    await this.ensureProfileDefaults(operatorId);
    const profiles = await this.profileViews(this.db);
    return pageOf(profiles, page);
  }

  async updateRecipientProfile(
    id: string,
    input: UpdateRecipientProfileInput,
    operatorId: string,
  ) {
    await this.ensureProfileDefaults(operatorId);
    const row = await this.findProfile(this.db, id);
    if (!row) {
      throw new ApiError(404, "not_found", "The recipient profile does not exist.");
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    const assign = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (input.channel !== undefined) {
      assign("channel", input.channel);
    }
    if (input.account !== undefined) {
      assign("account", input.account);
    }
    if (input.contactEmail !== undefined) {
      assign("contact_email", input.contactEmail);
    }
    if (input.compositionTrigger !== undefined) {
      assign("composition_trigger", input.compositionTrigger);
    }
    if (input.windowTime !== undefined) {
      assign("window_time", normalizePlainTime(input.windowTime, "/windowTime"));
    }
    if (input.eligibleTerritories !== undefined) {
      assign("eligible_territories", JSON.stringify(input.eligibleTerritories));
    }
    if (input.maxUrlsPerNotice !== undefined) {
      assign("max_urls_per_notice", input.maxUrlsPerNotice);
    }
    if (input.maxUrlsPerFile !== undefined) {
      assign("max_urls_per_file", input.maxUrlsPerFile);
    }
    if (input.maxUrlsPerDay !== undefined) {
      assign("max_urls_per_day", input.maxUrlsPerDay);
    }
    values.push(Number(row.version) + 1, operatorId, this.clock());
    sets.push(
      `version = $${values.length - 2}`,
      `updated_by = $${values.length - 1}`,
      `updated_at = $${values.length}`,
    );
    await this.db.query(
      `UPDATE recipient_profile SET ${sets.join(", ")} WHERE id = $${values.length + 1}`,
      [...values, id],
    );
    const updated = await this.findProfile(this.db, id);
    return this.profileView(updated!, await this.submissionStats(this.db, id));
  }

  async clearProfilePause(id: string, reason: string, operatorId: string) {
    await this.ensureProfileDefaults(operatorId);
    const row = await this.findProfile(this.db, id);
    if (!row) {
      throw new ApiError(404, "not_found", "The recipient profile does not exist.");
    }
    const stats = await this.submissionStats(this.db, id);
    if (
      stats.windowSize > 0 &&
      (stats.rejected + stats.failed) / stats.windowSize > PAUSE_THRESHOLD
    ) {
      throw new ApiError(
        409,
        "state_conflict",
        "The profile's recent rejection rate still exceeds the threshold.",
        undefined,
        { currentState: "paused" },
      );
    }
    if (reason.trim().length === 0) {
      throw unprocessable([
        { path: "/reason", message: "A reason is required." },
      ]);
    }
    const now = this.clock();
    await this.db.query(
      `UPDATE recipient_profile
          SET paused = false, pause_reason = NULL, version = version + 1,
              updated_by = $2, updated_at = $3, cleared_by = $2,
              cleared_at = $3, clearance_reason = $4
        WHERE id = $1`,
      [id, operatorId, now, reason.trim()],
    );
    const updated = await this.findProfile(this.db, id);
    return this.profileView(updated!, stats);
  }

  async listAllowlist(filters: AllowlistFilters, page: Page) {
    const conditions: string[] = ["removed_at IS NULL"];
    const values: unknown[] = [];
    if (filters.kind) {
      values.push(filters.kind);
      conditions.push(`kind = $${values.length}`);
    }
    if (filters.scope) {
      values.push(filters.scope);
      conditions.push(`scope = $${values.length}`);
    }
    if (filters.territory) {
      values.push(filters.territory);
      conditions.push(`territory = $${values.length}`);
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    const rows = (
      await this.db.query(
        `SELECT * FROM allowlist_entry ${where} ORDER BY confirmed_at DESC`,
        values,
      )
    ).rows;
    return pageOf(rows.map(toAllowlistEntry), page);
  }

  async createAllowlistEntry(
    input: CreateAllowlistEntryInput,
    operatorId: string,
  ) {
    const value = input.value.trim();
    if (value.length === 0) {
      throw unprocessable([
        { path: "/value", message: "A host or URL prefix is required." },
      ]);
    }
    if (input.scope === "rights_holder") {
      if (input.titleGroupId !== undefined || input.trackedTitleId !== undefined) {
        throw unprocessable([
          {
            path: "/scope",
            message: "A rights-holder entry takes no scope target.",
          },
        ]);
      }
    } else if (input.scope === "title_group") {
      if (!input.titleGroupId || input.trackedTitleId !== undefined) {
        throw unprocessable([
          {
            path: "/titleGroupId",
            message: "A title-group entry needs exactly a title group.",
          },
        ]);
      }
      if (!(await this.findGroup(input.titleGroupId))) {
        throw unprocessable([
          { path: "/titleGroupId", message: "No such title group." },
        ]);
      }
    } else if (input.scope === "tracked_title") {
      if (!input.trackedTitleId || input.titleGroupId !== undefined) {
        throw unprocessable([
          {
            path: "/trackedTitleId",
            message: "A tracked-title entry needs exactly a tracked title.",
          },
        ]);
      }
      if (!(await this.findTitle(input.trackedTitleId))) {
        throw unprocessable([
          { path: "/trackedTitleId", message: "No such tracked title." },
        ]);
      }
    }

    const licensed = input.kind === "licensed_destination";
    if (licensed && !input.territory) {
      throw unprocessable([
        {
          path: "/territory",
          message: "A licensed destination needs a territory.",
        },
      ]);
    }
    if (licensed && input.territory === "*") {
      throw unprocessable([
        {
          path: "/territory",
          message: "Use an ISO 3166-1 code for a licensed destination.",
        },
      ]);
    }

    const id = newId();
    await this.db.query(
      `INSERT INTO allowlist_entry
        (id, kind, match_kind, value, scope, title_group_id, tracked_title_id,
         territory, origin, proposed_by_decision_id, confirmed_by, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'operator', NULL, $9, $10)`,
      [
        id,
        input.kind,
        input.matchKind,
        input.matchKind === "host" ? value.toLowerCase() : value,
        input.scope,
        input.titleGroupId ?? null,
        input.trackedTitleId ?? null,
        licensed ? input.territory : null,
        operatorId,
        this.clock(),
      ],
    );
    const row = (
      await this.db.query("SELECT * FROM allowlist_entry WHERE id = $1", [id])
    ).rows[0];
    return toAllowlistEntry(row);
  }

  async removeAllowlistEntry(id: string, operatorId: string) {
    const row = await this.db.query(
      "SELECT id FROM allowlist_entry WHERE id = $1 AND removed_at IS NULL",
      [id],
    );
    if (row.rows.length === 0) {
      throw new ApiError(404, "not_found", "The allowlist entry does not exist.");
    }
    await this.db.query(
      "UPDATE allowlist_entry SET removed_by = $2, removed_at = $3 WHERE id = $1",
      [id, operatorId, this.clock()],
    );
  }

  private async ensureBudgetDefaults(operatorId: string) {
    const holder = await this.holder(this.db);
    if (!holder) {
      return;
    }
    for (const engine of ENGINES) {
      const defaults = DEFAULT_ENGINE_CAPS[engine];
      const existing = await this.db.query(
        "SELECT engine FROM acquisition_budget WHERE engine = $1",
        [engine],
      );
      if (existing.rows.length === 0) {
        await this.db.query(
          "INSERT INTO acquisition_budget (engine, currency, monthly_cap_minor) VALUES ($1, $2, $3)",
          [engine, defaults.currency, defaults.monthlyCapMinor],
        );
      }
    }
    const setting = await this.db.query(
      "SELECT value FROM application_setting WHERE key = $1",
      [SETTING_KEY],
    );
    if (setting.rows.length === 0) {
      await this.db.query(
        "INSERT INTO application_setting (key, value) VALUES ($1, $2)",
        [SETTING_KEY, String(DEFAULT_RECHECK_SHARE_PERCENT)],
      );
    }
  }

  private async ensureProfileDefaults(operatorId: string) {
    const holder = await this.holder(this.db);
    if (!holder) {
      return;
    }
    for (const profile of DEFAULT_PROFILES) {
      const existing = await this.db.query(
        "SELECT id FROM recipient_profile WHERE recipient = $1",
        [profile.recipient],
      );
      if (existing.rows.length === 0) {
        await this.db.query(
          `INSERT INTO recipient_profile
            (id, recipient, channel, account, contact_email, composition_trigger,
             window_time, eligible_territories, max_urls_per_notice,
             max_urls_per_file, max_urls_per_day, form_url,
             last_observed_max_urls_per_file,
             last_observed_daily_quota, paused, pause_reason, version, updated_by,
             updated_at)
           VALUES ($1, $2, 'web_form', '', NULL, 'scheduled', '07:00:00', '[]',
                   $3, $4, NULL, $7, NULL, NULL, false, NULL, 1, $5, $6)`,
          [
            newId(),
            profile.recipient,
            profile.maxUrlsPerNotice,
            profile.maxUrlsPerFile,
            operatorId,
            this.clock(),
            profile.formUrl,
          ],
        );
      }
    }
  }

  private async holder(db: Queryable) {
    const rows = (
      await db.query("SELECT * FROM rights_holder LIMIT 1")
    ).rows;
    const row = rows[0];
    if (!row) {
      throw new ApiError(404, "not_found", "The rights holder is not configured.");
    }
    return row;
  }

  private async budget(db: Queryable): Promise<BudgetConfig> {
    const rows = (
      await db.query("SELECT * FROM acquisition_budget")
    ).rows;
    const setting = (
      await db.query(
        "SELECT value FROM application_setting WHERE key = $1",
        [SETTING_KEY],
      )
    ).rows[0];
    const caps = ENGINES.map((engine) => {
      const row = rows.find((item) => String(item.engine) === engine);
      return {
        engine,
        currency: row ? String(row.currency) : DEFAULT_ENGINE_CAPS[engine].currency,
        monthlyCapMinor: row
          ? Number(row.monthly_cap_minor)
          : DEFAULT_ENGINE_CAPS[engine].monthlyCapMinor,
      };
    });
    return {
      caps,
      recheckSharePercent: Number(setting?.value ?? DEFAULT_RECHECK_SHARE_PERCENT),
    };
  }

  private async currentLedger(
    db: Queryable,
    budget: BudgetConfig,
    persist: boolean,
  ) {
    const monthStart = this.monthStart();
    const rows: Array<Record<string, unknown>> = [];
    for (const cap of budget.caps) {
      const existing = await db.query(
        "SELECT * FROM quota_ledger WHERE engine = $1 AND month_start = $2",
        [cap.engine, monthStart],
      );
      if (existing.rows.length > 0) {
        rows.push(existing.rows[0]);
        continue;
      }
      const id = persist
        ? newId()
        : uuidv5(`${cap.engine}:${monthStart}`, LEDGER_NAMESPACE);
      const allowance = this.allowanceUnits(cap.monthlyCapMinor, cap.engine);
      if (!persist) {
        rows.push({
          id,
          engine: cap.engine,
          month_start: monthStart,
          allowance_units: allowance,
          scan_reserved: 0,
          scan_committed: 0,
          recheck_reserved: 0,
          recheck_committed: 0,
        });
        continue;
      }
      try {
        await db.query(
          `INSERT INTO quota_ledger
            (id, engine, month_start, allowance_units, scan_reserved,
             scan_committed, recheck_reserved, recheck_committed)
           VALUES ($1, $2, $3, $4, 0, 0, 0, 0)`,
          [id, cap.engine, monthStart, allowance],
        );
      } catch {
        // The worker opened the month first; read its row instead.
      }
      const created = await db.query(
        "SELECT * FROM quota_ledger WHERE engine = $1 AND month_start = $2",
        [cap.engine, monthStart],
      );
      if (created.rows[0]) {
        rows.push(created.rows[0]);
      }
    }
    return rows;
  }

  private allowanceUnits(capMinor: number, engine: string) {
    const defaults = DEFAULT_ENGINE_CAPS[engine];
    if (!defaults || defaults.unitPricePerThousandMinor === 0) {
      return 0;
    }
    return Math.floor(
      (capMinor * 1_000) / defaults.unitPricePerThousandMinor,
    );
  }

  private engineStatus(
    row: Record<string, unknown>,
    budget: BudgetConfig,
    disabled: ReadonlySet<string> = new Set(),
  ) {
    const engine = String(row.engine);
    const cap = budget.caps.find((item) => item.engine === engine);
    const allowanceUnits = Number(row.allowance_units);
    const recheckShareUnits = Math.floor(
      (allowanceUnits * budget.recheckSharePercent) / 100,
    );
    const scanShareUnits = allowanceUnits - recheckShareUnits;
    const scanUsedUnits =
      Number(row.scan_reserved) + Number(row.scan_committed);
    const recheckUsedUnits =
      Number(row.recheck_reserved) + Number(row.recheck_committed);
    return {
      engine,
      currency: cap?.currency ?? "usd",
      monthlyCapMinor: cap?.monthlyCapMinor ?? 0,
      allowanceUnits,
      scanShareUnits,
      recheckShareUnits,
      scanUsedUnits,
      recheckUsedUnits,
      exhausted:
        allowanceUnits > 0 &&
        ((scanShareUnits > 0 && scanUsedUnits >= scanShareUnits) ||
          (recheckShareUnits > 0 && recheckUsedUnits >= recheckShareUnits)),
      routeDisabled: disabled.has(engine),
    };
  }

  private holderView(
    holder: Record<string, unknown>,
    budget: BudgetConfig,
  ) {
    return {
      id: String(holder.id),
      legalName: String(holder.legal_name),
      country: String(holder.country),
      address: this.address(holder),
      roleMailbox: String(holder.role_mailbox),
      phone: (holder.phone as string | null) ?? undefined,
      signatory: {
        fullLegalName: String(holder.signatory_name ?? ""),
        authorityBasis: String(holder.signatory_authority_basis ?? ""),
        contactEmail: String(
          holder.signatory_email ?? holder.role_mailbox ?? "",
        ),
        contactPhone: (holder.signatory_phone as string | null) ?? undefined,
      },
      acquisitionBudget: {
        engineCaps: budget.caps,
        recheckSharePercent: budget.recheckSharePercent,
      },
      createdAt: new Date(String(holder.created_at)).toISOString(),
      updatedAt: new Date(String(holder.updated_at)).toISOString(),
    };
  }

  private address(holder: Record<string, unknown>) {
    const raw = String(holder.address ?? "");
    if (raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw) as Partial<PostalAddressInput>;
        return {
          line1: String(parsed.line1 ?? ""),
          line2: parsed.line2,
          city: String(parsed.city ?? ""),
          region: parsed.region,
          postalCode: String(parsed.postalCode ?? ""),
          country: String(parsed.country ?? holder.country),
        };
      } catch {
        // A legacy plain-text address falls through to the line-one shape.
      }
    }
    return {
      line1: raw,
      city: "",
      postalCode: "",
      country: String(holder.country),
    };
  }

  private async profileViews(db: Queryable) {
    const rows = (
      await db.query("SELECT * FROM recipient_profile ORDER BY recipient ASC")
    ).rows;
    const views = [];
    for (const row of rows) {
      views.push(
        this.profileView(row, await this.submissionStats(db, String(row.id))),
      );
    }
    return views;
  }

  private profileView(
    row: Record<string, unknown>,
    stats: {
      windowSize: number;
      rejected: number;
      failed: number;
      thresholdExceeded: boolean;
    },
  ) {
    return toRecipientProfile({
      ...row,
      window_size: stats.windowSize,
      rejected: stats.rejected,
      failed: stats.failed,
      threshold_exceeded: stats.thresholdExceeded,
    });
  }

  private async submissionStats(db: Queryable, profileId: string) {
    const rows = (
      await db.query(
        "SELECT state FROM submission WHERE recipient_profile_id = $1 ORDER BY created_at DESC LIMIT $2",
        [profileId, PAUSE_WINDOW],
      )
    ).rows;
    const rejected = rows.filter((row) => row.state === "rejected").length;
    const failed = rows.filter((row) => row.state === "failed").length;
    return {
      windowSize: rows.length,
      rejected,
      failed,
      thresholdExceeded:
        rows.length > 0 && (rejected + failed) / rows.length > PAUSE_THRESHOLD,
    };
  }

  private async findProfile(db: Queryable, id: string) {
    const rows = (
      await db.query("SELECT * FROM recipient_profile WHERE id = $1", [id])
    ).rows;
    return rows[0];
  }

  private async findGroup(id: string) {
    const rows = (
      await this.db.query("SELECT id FROM title_group WHERE id = $1", [id])
    ).rows;
    return rows[0];
  }

  private async findTitle(id: string) {
    const rows = (
      await this.db.query("SELECT id FROM tracked_title WHERE id = $1", [id])
    ).rows;
    return rows[0];
  }

  private async withClient<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private monthStart() {
    const now = this.clock();
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `${now.getUTCFullYear()}-${month}-01`;
  }
}
