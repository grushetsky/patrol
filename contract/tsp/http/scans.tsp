namespace Patrol.Http;

using TypeSpec.Http;
using TypeSpec.OpenAPI;
using Patrol.Domain;

// Scans and re-checks: the operator's manual requests, the scan history, the
// query plan and results a scan produced, and the re-check ladders.

@doc("The two triggers an operator can request. A scheduled scan is not requestable.")
enum ScanRequestTrigger {
  Manual: "manual",
  ManualRecheck: "manual_recheck",
}

@doc("A manual scan or re-check request. It targets one group, or one group and one of its titles, on one engine or on every enabled engine.")
model ManualScanRequest {
  @doc("The group to scan.")
  titleGroupId: TitleGroupId;

  @doc("The title to scan, when the request is narrower than the whole group. It must belong to the group.")
  trackedTitleId?: TrackedTitleId;

  @doc("The engine to scan. Omit to scan every enabled engine.")
  engine?: Engine;

  @doc("Whether the request is an ordinary manual scan or a manual re-check that resets the ladder.")
  trigger: ScanRequestTrigger;
}

@doc("The scans a manual request queued or found. A scan is idempotent on group, engine, and due date, so an earlier same-day scan is returned unchanged.")
model ManualScanResult {
  @doc("One scan per engine the request targeted.")
  scans: Scan[];
}

@doc("The manual work was accepted and queued ahead of scheduled scans.")
model ManualScanAccepted {
  @statusCode statusCode: 202;
  @body body: ManualScanResult;
}

@doc("A page of scans, newest first.")
model ScanPage {
  @doc("The scans on this page.")
  items: Scan[];

  @doc("How many scans match the filter in total.")
  total: int32;

  @doc("The one-based page number.")
  page: int32;

  @doc("The page size.")
  pageSize: int32;
}

@doc("A page of search results a scan recorded, as provenance.")
model SearchResultPage {
  @doc("The search results on this page.")
  items: SearchResult[];

  @doc("How many results the scan recorded in total.")
  total: int32;

  @doc("The one-based page number.")
  page: int32;

  @doc("The page size.")
  pageSize: int32;
}

@doc("A page of re-check ladders.")
model RecheckSchedulePage {
  @doc("The ladders on this page, by next due time.")
  items: RecheckSchedule[];

  @doc("How many ladders match the filter in total.")
  total: int32;

  @doc("The one-based page number.")
  page: int32;

  @doc("The page size.")
  pageSize: int32;
}

@doc("Scan history, manual scan requests, and the results a scan recorded.")
@tag("Scans")
@useAuth(SessionCookie)
@route("/scans")
interface Scans {
  @doc("Scan history, filtered by group, engine, state, trigger, or due date.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  op list(...PageRequest, @query titleGroupId?: TitleGroupId, @query engine?: Engine, @query state?: ScanState, @query trigger?: ScanTrigger, @query dueDate?: plainDate): ScanPage | ReadErrors;

  @doc("Request a manual scan or a manual re-check. It queues ahead of scheduled work, preflights the same budget pool, and resets a re-check ladder when the trigger is manual_recheck.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  op request(...CsrfToken, @body body: ManualScanRequest): ManualScanAccepted | MutationErrors;

  @doc("One scan with its query plan and lifecycle.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/{scanId}")
  op read(@path scanId: ScanId): Scan | ResourceErrors;

  @doc("The search results a scan recorded, as provenance. Results are never edited.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/{scanId}/results")
  op results(...PageRequest, @path scanId: ScanId): SearchResultPage | ResourceErrors;
}

@doc("The re-check ladders, one per title group and engine.")
@tag("Scans")
@useAuth(SessionCookie)
@route("/rechecks")
interface Rechecks {
  @doc("Every ladder, filtered by group or engine.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  op list(...PageRequest, @query titleGroupId?: TitleGroupId, @query engine?: Engine): RecheckSchedulePage | ReadErrors;
}
