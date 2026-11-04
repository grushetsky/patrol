namespace Patrol.Http;

using TypeSpec.Http;
using TypeSpec.OpenAPI;
using Patrol.Domain;

// Settings: the rights holder and its signatory, the acquisition budget and its
// derived capacity, the recipient profiles, and the scoped allowlist.

@doc("A change to the rights holder or its signatory. Omitted fields keep their value.")
model UpdateRightsHolderRequest {
  @doc("The legal name, as it appears on a notice.")
  legalName?: string;

  @doc("The country of the rights holder's address.")
  country?: CountryCode;

  @doc("The rights holder's postal address.")
  address?: PostalAddress;

  @doc("The role mailbox a recipient may contact about a notice.")
  roleMailbox?: Email;

  @doc("A phone number, where a recipient's form asks for one.")
  phone?: string;

  @doc("The natural person authorised to sign notices.")
  signatory?: Signatory;
}

@doc("One engine's budget position for the current UTC month.")
model EngineBudgetStatus {
  @doc("The engine.")
  engine: Engine;

  @doc("The currency of the engine's cap.")
  currency: Currency;

  @doc("The monthly cap in the currency's minor unit.")
  monthlyCapMinor: int32;

  @doc("The month's billable units, derived from the cap.")
  allowanceUnits: int32;

  @doc("The units reserved for scheduled scans, seventy percent of the allowance.")
  scanShareUnits: int32;

  @doc("The units reserved for re-checks, thirty percent of the allowance.")
  recheckShareUnits: int32;

  @doc("Units committed and reserved by scans.")
  scanUsedUnits: int32;

  @doc("Units committed and reserved by re-checks.")
  recheckUsedUnits: int32;

  @doc("Whether a bucket is fully spent.")
  exhausted: boolean;

  @doc("Whether the route is disabled after an authentication failure or an empty provider balance.")
  routeDisabled: boolean;
}

@doc("One budget alert, fired once per threshold per engine per month.")
model BudgetAlert {
  @doc("The engine the alert concerns.")
  engine: Engine;

  @doc("The bucket that reached the threshold. Present only for the bucket-level thresholds — the ninety-percent critical and the exhaustion; the engine-level rules, the seventy-five-percent monthly warning and the provider-balance critical, concern no bucket and omit it.")
  bucket?: BudgetBucket;

  @doc("The alert's severity.")
  level: QuotaAlertLevel;

  @doc("The share the alert measured, as a percentage: of the bucket for the bucket thresholds, of the monthly allowance for the warning, and of the engine's monthly cap for the provider-balance critical.")
  percentUsed: float32;

  @doc("The message the dashboard renders.")
  message: string;

  @doc("How many groups have not scanned this month, for the monthly shortfall count.")
  groupsNotScanned: int32;
}

@doc("The current budget, ledger, engine shares, and alerts.")
model BudgetOverview {
  @doc("The configured cap and re-check share.")
  budget: AcquisitionBudget;

  @doc("The current month's ledger rows, one per engine.")
  ledger: QuotaLedger[];

  @doc("The derived per-engine allowance and share.")
  engines: EngineBudgetStatus[];

  @doc("The alerts that have fired this month.")
  alerts: BudgetAlert[];
}

@doc("The scanning cadence a capacity projection assumes.")
enum Cadence {
  Daily: "daily",
  EveryOtherDay: "every_other_day",
  Weekly: "weekly",
}

@doc("How many titles the current cap supports at a given locale count and cadence.")
model CapacityProjection {
  @doc("The locales assumed per title.")
  localesPerTitle: int32;

  @doc("The cadence assumed.")
  cadence: Cadence;

  @doc("The queries one title issues in one scan at that locale count.")
  queriesPerTitlePerScan: int32;

  @doc("How many titles the cap supports at that shape.")
  supportedTitles: int32;

  @doc("How many titles the catalogue currently holds.")
  trackedTitles: int32;

  @doc("How many titles the current plan exceeds the cap by, zero when it fits.")
  shortfallTitles: int32;
}

@doc("A page of recipient profiles.")
model RecipientProfilePage {
  @doc("The profiles on this page.")
  items: RecipientProfile[];

  @doc("How many profiles exist in total.")
  total: int32;

  @doc("The one-based page number.")
  page: int32;

  @doc("The page size.")
  pageSize: int32;
}

@doc("A change to a recipient profile. Omitted fields keep their value.")
model UpdateRecipientProfileRequest {
  @doc("The channel the submission runs through.")
  channel?: RecipientChannel;

  @doc("The account the submission runs under.")
  account?: string;

  @doc("The contact mailbox the form asks for.")
  contactEmail?: Email;

  @doc("When drafts are composed for this profile.")
  compositionTrigger?: CompositionTrigger;

  @doc("The UTC time the scheduled composition window opens.")
  windowTime?: plainTime;

  @doc("The territories in which the rights holder is eligible to submit. Empty means every territory.")
  eligibleTerritories?: Territory[];

  @doc("The recipient's published per-notice URL cap.")
  @minValue(1)
  maxUrlsPerNotice?: int32;

  @doc("The recipient's published per-file URL cap.")
  @minValue(1)
  maxUrlsPerFile?: int32;

  @doc("The recipient's published per-day URL cap.")
  @minValue(1)
  maxUrlsPerDay?: int32;
}

@doc("An administrator's clearance of a pause that the rejection threshold set.")
model ClearProfilePauseRequest {
  @doc("Why the pause is being cleared. Recorded against the profile.")
  reason: string;
}

@doc("A page of allowlist entries.")
model AllowlistEntryPage {
  @doc("The entries on this page.")
  items: AllowlistEntry[];

  @doc("How many entries match the filter in total.")
  total: int32;

  @doc("The one-based page number.")
  page: int32;

  @doc("The page size.")
  pageSize: int32;
}

@doc("A new scoped allowlist entry, confirmed by the operator who adds it.")
model CreateAllowlistEntryRequest {
  @doc("Why the host or URL prefix is allowed.")
  kind: AllowlistKind;

  @doc("How the value matches a URL.")
  matchKind: AllowlistMatchKind;

  @doc("The host or URL prefix the entry matches.")
  value: string;

  @doc("What the entry covers.")
  scope: AllowlistScope;

  @doc("The title group the entry is scoped to, required when the scope is a title group and refused otherwise.")
  titleGroupId?: TitleGroupId;

  @doc("The tracked title the entry is scoped to, required when the scope is a tracked title and refused otherwise.")
  trackedTitleId?: TrackedTitleId;

  @doc("The territory the entry applies to. Required for a licensed destination and ignored otherwise.")
  territory?: Territory;
}

@doc("The entry was created and is in effect immediately.")
model AllowlistEntryCreated {
  @statusCode statusCode: 201;
  @body body: AllowlistEntry;
}

@doc("The settings reads any operator may perform.")
@tag("Settings")
@useAuth(SessionCookie)
@route("/settings")
interface Settings {
  @doc("The rights holder and its signatory.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/rights-holder")
  op readRightsHolder(): RightsHolder | ReadErrors;

  @doc("The acquisition budget, the current month's ledger, and the alerts it has fired.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/budget")
  op readBudget(): BudgetOverview | ReadErrors;

  @doc("How many titles the current cap supports at a given locale count and cadence, and the shortfall when the catalogue exceeds it.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/budget/capacity")
  op readCapacity(@query locales?: int32, @query cadence?: Cadence): CapacityProjection | ReadErrors | BadRequest;

  @doc("Every recipient profile, with its channel, trigger, limits, eligibility, and pause state.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/recipient-profiles")
  op listRecipientProfiles(...PageRequest): RecipientProfilePage | ReadErrors;
}

@doc("The settings writes only an administrator holds.")
@tag("Settings")
@useAuth(SessionCookie)
@route("/settings")
interface SettingsAdministration {
  @doc("Edit the rights holder or its signatory.")
  @extension("x-patrol-roles", #["administrator"])
  @patch
  @route("/rights-holder")
  op updateRightsHolder(...CsrfToken, @body body: UpdateRightsHolderRequest): RightsHolder | MutationErrors;

  @doc("Set the monthly cap per engine and the share reserved for re-checks. A lower cap never un-spends what the ledger already committed.")
  @extension("x-patrol-roles", #["administrator"])
  @put
  @route("/budget")
  op updateBudget(...CsrfToken, @body body: AcquisitionBudget): BudgetOverview | MutationErrors;

  @doc("Edit a recipient profile's channel, account, trigger, limits, or eligibility. The profile's version rises.")
  @extension("x-patrol-roles", #["administrator"])
  @patch
  @route("/recipient-profiles/{recipientProfileId}")
  op updateRecipientProfile(...CsrfToken, @path recipientProfileId: RecipientProfileId, @body body: UpdateRecipientProfileRequest): RecipientProfile | ResourceMutationErrors;

  @doc("Clear a pause that the rejection threshold set. A profile whose last twenty submissions still exceed the threshold cannot be cleared.")
  @extension("x-patrol-roles", #["administrator"])
  @post
  @route("/recipient-profiles/{recipientProfileId}/clearance")
  op clearProfilePause(...CsrfToken, @path recipientProfileId: RecipientProfileId, @body body: ClearProfilePauseRequest): RecipientProfile | ResourceMutationErrors;
}

@doc("The scoped allowlist that suppresses authorization rather than infringement. Any operator may add or remove an entry.")
@tag("Settings")
@useAuth(SessionCookie)
@route("/settings/allowlist")
interface AllowlistEntries {
  @doc("Every allowlist entry, filtered by kind, scope, or territory.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  op list(...PageRequest, @query kind?: AllowlistKind, @query scope?: AllowlistScope, @query territory?: Territory): AllowlistEntryPage | ReadErrors;

  @doc("Add a scoped allowlist entry. A licensed destination needs a territory, and the scope target must match the scope exactly.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  op create(...CsrfToken, @body body: CreateAllowlistEntryRequest): AllowlistEntryCreated | MutationErrors;

  @doc("Remove an allowlist entry. The removal is recorded against the operator who performed it.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @delete
  @route("/{allowlistEntryId}")
  op remove(...CsrfToken, @path allowlistEntryId: AllowlistEntryId): NoContent | ResourceMutationErrors;
}
