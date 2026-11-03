namespace Patrol.Domain;

// Catalogue and scope. A title enters Patrol only when an operator types it, so
// provenance is recorded per row and a correction is a direct edit, not a
// reviewed draft.

@doc("The legal person on whose behalf Patrol identifies violations and signs notices. Exactly one exists per deployment.")
model RightsHolder {
  @doc("Patrol's own identifier.")
  id: RightsHolderId;

  @doc("The rights holder's legal name, as it appears on a notice.")
  legalName: string;

  @doc("The country of the rights holder's address.")
  country: CountryCode;

  @doc("The rights holder's postal address.")
  address: PostalAddress;

  @doc("The role mailbox a recipient may contact about a notice.")
  roleMailbox: Email;

  @doc("A phone number, where a recipient's form asks for one.")
  phone?: string;

  @doc("The natural person authorised to sign notices.")
  signatory: Signatory;

  @doc("The acquisition cap and its per-engine split.")
  acquisitionBudget: AcquisitionBudget;

  @doc("When the rights holder row was created.")
  createdAt: utcDateTime;

  @doc("When the rights holder row was last edited.")
  updatedAt: utcDateTime;
}

@doc("The natural person authorised to sign notices. It holds no credentials and cannot sign in.")
model Signatory {
  @doc("The signatory's full legal name, rendered in every signature field.")
  fullLegalName: string;

  @doc("The basis on which the signatory is authorised to act for the rights holder.")
  authorityBasis: string;

  @doc("The signatory's contact email, snapshotted into a notice at approval.")
  contactEmail: Email;

  @doc("The signatory's contact phone, where a form asks for one.")
  contactPhone?: string;
}

@doc("The monthly acquisition cap and the share reserved for re-checks.")
model AcquisitionBudget {
  @doc("The cap for each engine. Bing is deferred and carries a zero cap until it is added.")
  engineCaps: EngineBudgetCap[];

  @doc("The percentage of each engine allowance reserved for re-checks, defaulting to 30.")
  @minValue(0)
  @maxValue(100)
  recheckSharePercent: int32;
}

@doc("One engine's monthly cap and the billable units it buys.")
model EngineBudgetCap {
  @doc("The engine the cap applies to.")
  engine: Engine;

  @doc("The currency of the cap.")
  currency: Currency;

  @doc("The monthly cap in the currency's minor unit, such as cents.")
  @minValue(0)
  monthlyCapMinor: int32;
}

@doc("An operator-defined set of tracked titles that share scan settings and allowlist scope.")
model TitleGroup {
  @doc("Patrol's own identifier.")
  id: TitleGroupId;

  @doc("The group's display name.")
  name: string;

  @doc("The locales the group's scans generate queries for. At least one locale is required.")
  locales: Locale[];

  @doc("The local time inside the scheduling window at which the group becomes due. The window is 02:00 to 05:59 UTC by default.")
  scanTime: plainTime;

  @doc("The group's scheduling priority.")
  priority: GroupPriority;

  @doc("When the group was created.")
  createdAt: utcDateTime;

  @doc("When the group was last edited.")
  updatedAt: utcDateTime;
}

@doc("A work the rights holder monitors, carrying its original title, release year, title type, runtime, external identifiers, and title variants.")
model TrackedTitle {
  @doc("Patrol's own identifier. Never an external identifier.")
  id: TrackedTitleId;

  @doc("The one title group the title belongs to.")
  titleGroupId: TitleGroupId;

  @doc("The four-digit year of first release; for a series, the year of the first season's first episode.")
  @minValue(1878)
  releaseYear: int32;

  @doc("The kind of work.")
  titleType: TitleType;

  @doc("The runtime in minutes; for a series, the typical episode runtime. Absent when unknown.")
  @minValue(1)
  runtimeMinutes?: int32;

  @doc("The variant whose text is the canonical label and display title. Exactly one variant of the title is original.")
  originalVariantId: TitleVariantId;

  @doc("Whether scanning is paused for this title. A paused title is excluded from the chart's tracked count.")
  paused: boolean;

  @doc("When the title was merged into another, the surviving title. A merged title is archived, never deleted.")
  mergedIntoTitleId?: TrackedTitleId;

  @doc("Where the original title, year, and type came from, and who entered them.")
  provenance: TitleProvenance;

  @doc("When the title was created.")
  createdAt: utcDateTime;

  @doc("When the title was last edited.")
  updatedAt: utcDateTime;
}

@doc("Provenance of a tracked title's core facts.")
model TitleProvenance {
  @doc("Where the original title, year, and type came from.")
  source: CatalogueSource;

  @doc("The operator who entered the title.")
  enteredBy: OperatorId;

  @doc("When the operator entered the title.")
  enteredAt: utcDateTime;

  @doc("The operator who last edited the title.")
  updatedBy: OperatorId;
}

@doc("A recorded string by which a tracked title is known, typed by kind, language, script, and territory.")
model TitleVariant {
  @doc("Patrol's own identifier.")
  id: TitleVariantId;

  @doc("The tracked title the variant belongs to.")
  trackedTitleId: TrackedTitleId;

  @doc("The variant text as the operator entered it. The native string is never overwritten.")
  text: string;

  @doc("The matching key derived from the text by the normalization rules. Never typed, never displayed.")
  normalizedText: string;

  @doc("How the variant relates to the work.")
  kind: TitleVariantKind;

  @doc("The language tag of the text.")
  language: Locale;

  @doc("The script the text is written in.")
  script: ScriptCode;

  @doc("The territory the variant applies to, when it is territory-specific.")
  territory?: Territory;

  @doc("Where the variant text came from.")
  source: CatalogueSource;

  @doc("The operator who added the variant.")
  addedBy: OperatorId;

  @doc("When the variant was added.")
  addedAt: utcDateTime;
}

@doc("An external identifier for a tracked title. A fact, not a lookup key.")
model ExternalIdentifier {
  @doc("Patrol's own identifier for the row.")
  id: ExternalIdentifierId;

  @doc("The tracked title the identifier belongs to.")
  trackedTitleId: TrackedTitleId;

  @doc("The scheme the value belongs to.")
  scheme: ExternalIdentifierScheme;

  @doc("The identifier value in that scheme.")
  value: string;

  @doc("Where the identifier was read from.")
  source: CatalogueSource;

  @doc("When the identifier was recorded.")
  retrievedAt: utcDateTime;
}

@doc("A scoped rule that marks a host or URL prefix as authorized or non-infringing.")
model AllowlistEntry {
  @doc("Patrol's own identifier.")
  id: AllowlistEntryId;

  @doc("Why the host or URL prefix is allowed.")
  kind: AllowlistKind;

  @doc("How the value matches a URL.")
  matchKind: AllowlistMatchKind;

  @doc("The host or URL prefix the entry matches.")
  value: string;

  @doc("What the entry covers.")
  scope: AllowlistScope;

  @doc("The title group the entry is scoped to, required when the scope is a title group.")
  titleGroupId?: TitleGroupId;

  @doc("The tracked title the entry is scoped to, required when the scope is a tracked title.")
  trackedTitleId?: TrackedTitleId;

  @doc("The territory the entry applies to. Required for a licensed destination, where it is a territory or intended as worldwide; ignored for an official domain or a neutral source.")
  territory?: Territory;

  @doc("How the entry came to exist. No entry is created silently.")
  origin: AllowlistOrigin;

  @doc("The review decision that proposed the entry, present when the origin is a review decision.")
  proposedByDecisionId?: ReviewDecisionId;

  @doc("The operator who confirmed the entry.")
  confirmedBy: OperatorId;

  @doc("When the operator confirmed the entry.")
  confirmedAt: utcDateTime;
}
