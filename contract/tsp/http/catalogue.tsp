namespace Patrol.Http;

using TypeSpec.Http;
using TypeSpec.OpenAPI;
using Patrol.Domain;

// Catalogue and scope: title groups, tracked titles, their variants and
// external identifiers, and the two search indexes the add-title field reads.

@doc("A page of title groups.")
model TitleGroupPage {
  @doc("The groups on this page, by name.")
  items: TitleGroup[];

  @doc("How many groups exist in total.")
  total: int32;

  @doc("The one-based page number.")
  page: int32;

  @doc("The page size.")
  pageSize: int32;
}

@doc("A title group's scan settings and allowlist scope.")
model CreateTitleGroupRequest {
  @doc("The group's display name.")
  name: string;

  @doc("The locales the group's scans generate queries for. At least one is required.")
  locales: Locale[];

  @doc("The local time inside the scheduling window at which the group becomes due.")
  scanTime: plainTime;

  @doc("The group's scheduling priority.")
  priority: GroupPriority;
}

@doc("A change to a title group. Omitted fields keep their value.")
model UpdateTitleGroupRequest {
  @doc("The group's display name.")
  name?: string;

  @doc("The locales the group's scans generate queries for. At least one is required.")
  locales?: Locale[];

  @doc("The local time inside the scheduling window at which the group becomes due.")
  scanTime?: plainTime;

  @doc("The group's scheduling priority.")
  priority?: GroupPriority;
}

@doc("The group was created.")
model TitleGroupCreated {
  @statusCode statusCode: 201;
  @body body: TitleGroup;
}

@doc("One tracked title as the catalogue screen shows it.")
model TrackedTitleCard {
  @doc("Patrol's own identifier.")
  id: TrackedTitleId;

  @doc("The display title, which is the original-title variant's text.")
  displayTitle: string;

  @doc("The four-digit year of first release.")
  releaseYear: int32;

  @doc("The kind of work.")
  titleType: TitleType;

  @doc("The group the title belongs to.")
  titleGroupId: TitleGroupId;

  @doc("The group's display name.")
  titleGroupName: string;

  @doc("How many variants the title records.")
  variantCount: int32;

  @doc("The title's external identifiers, as recorded facts.")
  externalIdentifiers: ExternalIdentifier[];

  @doc("How many allowlist entries apply to the title or its scopes.")
  allowlistEntryCount: int32;

  @doc("Whether scanning is paused for this title.")
  paused: boolean;

  @doc("The surviving title, when this one was merged away.")
  mergedIntoTitleId?: TrackedTitleId;

  @doc("How many violations of this title are open.")
  openViolationCount: int32;
}

@doc("A page of tracked titles.")
model TrackedTitlePage {
  @doc("The titles on this page, by display title.")
  items: TrackedTitleCard[];

  @doc("How many titles match the filter in total.")
  total: int32;

  @doc("The one-based page number.")
  page: int32;

  @doc("The page size.")
  pageSize: int32;
}

@doc("The related records a title detail counts.")
model TrackedTitleCounts {
  @doc("How many variants the title records.")
  variants: int32;

  @doc("How many external identifiers the title records.")
  externalIdentifiers: int32;

  @doc("How many allowlist entries apply to the title or its scopes.")
  allowlistEntries: int32;

  @doc("How many candidates reference the title, whatever their state.")
  candidates: int32;

  @doc("How many violations of the title are open.")
  openViolations: int32;

  @doc("How many notices cite the title.")
  notices: int32;
}

@doc("A tracked title with its variants, identifiers, allowlist entries, and counts.")
model TrackedTitleDetail {
  @doc("The tracked title record.")
  title: TrackedTitle;

  @doc("The display title, which is the original-title variant's text.")
  displayTitle: string;

  @doc("Every recorded variant, oldest first.")
  variants: TitleVariant[];

  @doc("Every recorded external identifier.")
  externalIdentifiers: ExternalIdentifier[];

  @doc("The allowlist entries that apply to this title.")
  allowlistEntries: AllowlistEntry[];

  @doc("The related-record counts the detail renders.")
  counts: TrackedTitleCounts;
}

@doc("One external identifier a title is known by.")
model NewExternalIdentifier {
  @doc("The scheme the value belongs to.")
  scheme: ExternalIdentifierScheme;

  @doc("The identifier value in that scheme, in the scheme's accepted shape.")
  value: string;
}

@doc("One additional recorded name for a tracked title.")
model NewTitleVariant {
  @doc("The variant text as entered. The native string is never overwritten.")
  text: string;

  @doc("How the variant relates to the work. The original variant is created with the title, not here.")
  kind: TitleVariantKind;

  @doc("The language tag of the text.")
  language: Locale;

  @doc("The script the text is written in.")
  script: ScriptCode;

  @doc("The territory the variant applies to, when it is territory-specific.")
  territory?: Territory;

  @doc("Where the variant text came from.")
  source: CatalogueSource;
}

@doc("The title's original-language name, which becomes its display title.")
model NewOriginalVariant {
  @doc("The original title's text as entered. The native string is never overwritten.")
  text: string;

  @doc("The language tag of the text.")
  language: Locale;

  @doc("The script the text is written in.")
  script: ScriptCode;
}

@doc("A new tracked title, entered by an operator. The record is keyed by Patrol's own identifier, never by an external one.")
model CreateTrackedTitleRequest {
  @doc("The one group the title belongs to.")
  titleGroupId: TitleGroupId;

  @doc("The original-title variant, which becomes the display title.")
  originalVariant: NewOriginalVariant;

  @doc("The four-digit year of first release.")
  @minValue(1878)
  releaseYear: int32;

  @doc("The kind of work.")
  titleType: TitleType;

  @doc("The runtime in minutes, or the typical episode runtime for a series. Absent when unknown.")
  @minValue(1)
  runtimeMinutes?: int32;

  @doc("Additional localized, transliterated, or alternate names. May be empty.")
  additionalVariants: NewTitleVariant[];

  @doc("External identifier facts. May be empty.")
  externalIdentifiers: NewExternalIdentifier[];

  @doc("Where the original title, year, and type came from.")
  source: CatalogueSource;
}

@doc("A correction to a tracked title. Omitted fields keep their value.")
model UpdateTrackedTitleRequest {
  @doc("The group the title belongs to.")
  titleGroupId?: TitleGroupId;

  @doc("The four-digit year of first release.")
  @minValue(1878)
  releaseYear?: int32;

  @doc("The kind of work.")
  titleType?: TitleType;

  @doc("The runtime in minutes. Absent when unknown.")
  @minValue(1)
  runtimeMinutes?: int32;

  @doc("Whether scanning is paused for this title.")
  paused?: boolean;
}

@doc("The new title, or the existing one that the duplicate check matched.")
model TrackedTitleCreated {
  @statusCode statusCode: 201;
  @body body: TrackedTitleDetail;
}

@doc("The variant was recorded, with a warning when its text resembles another title's.")
model TitleVariantCreated {
  @doc("The recorded variant.")
  variant: TitleVariant;

  @doc("The title whose normalized text and year and type match, present as a warning the operator may overrule.")
  similarTitleId?: TrackedTitleId;
}

@doc("The recorded variant.")
model TitleVariantRecorded {
  @statusCode statusCode: 201;
  @body body: TitleVariantCreated;
}

@doc("An external identifier recorded as a fact, or a duplicate refusal naming the title that already holds it.")
model ExternalIdentifierRecorded {
  @statusCode statusCode: 201;
  @body body: ExternalIdentifier;
}

@doc("A merge moves a duplicate's variants and identifiers to the surviving title and archives the duplicate.")
model MergeTitlesRequest {
  @doc("The title that survives the merge.")
  survivingTitleId: TrackedTitleId;
}

@doc("The result of a merge.")
model TitleMergeResult {
  @doc("The surviving title, with the moved records.")
  survivingTitle: TrackedTitleDetail;

  @doc("The archived duplicate, pointing at the survivor.")
  archivedTitle: TrackedTitle;

  @doc("How many variants moved.")
  movedVariantCount: int32;

  @doc("How many external identifiers moved.")
  movedIdentifierCount: int32;
}

@doc("One local catalogue suggestion for the add-title field.")
model CatalogueSuggestion {
  @doc("The tracked title the suggestion opens.")
  trackedTitleId: TrackedTitleId;

  @doc("The display title.")
  displayTitle: string;

  @doc("The four-digit year of first release.")
  releaseYear: int32;

  @doc("The kind of work.")
  titleType: TitleType;

  @doc("The group the title belongs to.")
  titleGroupId: TitleGroupId;

  @doc("The group's display name.")
  titleGroupName: string;

  @doc("The variant the query matched.")
  matchedVariant: VariantSnapshot;
}

@doc("The local index's answer to the add-title field, which always offers free-text creation as well.")
model CatalogueSearchResult {
  @doc("The query as issued.")
  query: string;

  @doc("The tracked titles whose variants match, best first.")
  suggestions: CatalogueSuggestion[];

  @doc("The free-text title the operator may create instead of accepting any suggestion.")
  createProposal: string;
}

@doc("One Wikidata entity suggestion for the add-title field.")
model WikidataSuggestion {
  @doc("The entity's QID.")
  qid: string;

  @doc("The entity's label in the search language.")
  label: string;

  @doc("The entity's description, when one is published.")
  description?: string;

  @doc("The alias the query matched, when the match was an alias rather than the label.")
  matchedAlias?: string;

  @doc("The language of the matched alias.")
  matchedAliasLanguage?: Locale;
}

@doc("Wikidata's answer to the add-title field. A failure here never blocks local suggestions or free-text creation.")
model WikidataSearchResult {
  @doc("The query as issued.")
  query: string;

  @doc("At most ten entity suggestions.")
  suggestions: WikidataSuggestion[];
}

@doc("An external identifier read from a Wikidata claim.")
model WikidataIdentifierSuggestion {
  @doc("The scheme the value belongs to.")
  scheme: ExternalIdentifierScheme;

  @doc("The identifier value.")
  value: string;

  @doc("The Wikidata property the value was read from.")
  property: string;
}

@doc("The facts a second read of a selected Wikidata entity offers.")
model WikidataEntityFacts {
  @doc("The entity's QID.")
  qid: string;

  @doc("The entity's label.")
  label: string;

  @doc("The entity's description, when one is published.")
  description?: string;

  @doc("IMDb and KinoPoisk identifier suggestions. Nothing is stored until the operator saves.")
  identifiers: WikidataIdentifierSuggestion[];
}

@doc("Title groups and the tracked titles inside them.")
@tag("Catalogue")
@useAuth(SessionCookie)
@route("/title-groups")
interface TitleGroups {
  @doc("Every title group with its scan settings.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  op list(...PageRequest): TitleGroupPage | ReadErrors;

  @doc("Create a title group. It needs at least one locale.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  op create(...CsrfToken, @body body: CreateTitleGroupRequest): TitleGroupCreated | MutationErrors;

  @doc("Read one title group.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/{titleGroupId}")
  op read(@path titleGroupId: TitleGroupId): TitleGroup | ResourceErrors;

  @doc("Edit a title group's name, locales, scan time, or priority.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @patch
  @route("/{titleGroupId}")
  op update(...CsrfToken, @path titleGroupId: TitleGroupId, @body body: UpdateTitleGroupRequest): TitleGroup | ResourceMutationErrors;
}

@doc("Tracked titles, entered by hand and corrected in place.")
@tag("Catalogue")
@useAuth(SessionCookie)
@route("/titles")
interface Titles {
  @doc("Every tracked title, filtered by group, pause state, or a query over its variants.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  op list(...PageRequest, @query titleGroupId?: TitleGroupId, @query query?: string, @query paused?: boolean): TrackedTitlePage | ReadErrors;

  @doc("Create one tracked title. A supplied external identifier that already exists, or an identical normalized original title, year, and type, blocks creation.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  op create(...CsrfToken, @body body: CreateTrackedTitleRequest): TrackedTitleCreated | MutationErrors;

  @doc("Read one title with its variants, identifiers, allowlist entries, and counts.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/{trackedTitleId}")
  op read(@path trackedTitleId: TrackedTitleId): TrackedTitleDetail | ResourceErrors;

  @doc("Correct a title's year, type, runtime, group, or pause state. The edit records the editor and the time.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @patch
  @route("/{trackedTitleId}")
  op update(...CsrfToken, @path trackedTitleId: TrackedTitleId, @body body: UpdateTrackedTitleRequest): TrackedTitleDetail | ResourceMutationErrors;

  @doc("Add one more name to an existing title. Its text must be unique within the title after normalization.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  @route("/{trackedTitleId}/variants")
  op addVariant(...CsrfToken, @path trackedTitleId: TrackedTitleId, @body body: NewTitleVariant): TitleVariantRecorded | ResourceMutationErrors;

  @doc("Record one more external identifier on a title. A scheme-and-value pair that already exists is refused with the title that holds it.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  @route("/{trackedTitleId}/external-identifiers")
  op addExternalIdentifier(...CsrfToken, @path trackedTitleId: TrackedTitleId, @body body: NewExternalIdentifier): ExternalIdentifierRecorded | ResourceMutationErrors;

  @doc("Remove a wrong external identifier. The correction records nothing else; the identifier was a fact, not a key.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @delete
  @route("/{trackedTitleId}/external-identifiers/{externalIdentifierId}")
  op removeExternalIdentifier(...CsrfToken, @path trackedTitleId: TrackedTitleId, @path externalIdentifierId: ExternalIdentifierId): NoContent | ResourceMutationErrors;

  @doc("Merge a duplicate into a surviving title. Allowed only while the duplicate has no candidate and no violation.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  @route("/{trackedTitleId}/merge")
  op merge(...CsrfToken, @path trackedTitleId: TrackedTitleId, @body body: MergeTitlesRequest): TitleMergeResult | ResourceMutationErrors;
}

@doc("The two indexes behind the add-title field: the local catalogue and Wikidata.")
@tag("Catalogue")
@useAuth(SessionCookie)
@route("/catalogue")
interface CatalogueSearch {
  @doc("Search the local catalogue across every variant and group. The answer always offers free-text creation too.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/suggestions")
  op search(@query query: string, @query titleGroupId?: TitleGroupId): CatalogueSearchResult | ReadErrors;

  @doc("Search Wikidata by label and alias in one language. A failure here never blocks local suggestions or creation.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/wikidata-suggestions")
  op searchWikidata(@query query: string, @query locale: Locale): WikidataSearchResult | ReadErrors | ServiceUnavailable;

  @doc("Read a selected Wikidata entity's IMDb and KinoPoisk identifier claims. Nothing is stored until the operator saves.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/wikidata-entities/{qid}")
  op readWikidataEntity(@path qid: string): WikidataEntityFacts | ReadErrors | NotFound | ServiceUnavailable;
}
