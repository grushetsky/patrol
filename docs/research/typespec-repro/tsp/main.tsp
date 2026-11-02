import "@typespec/http";
import "@typespec/openapi";
import "@typespec/openapi3";
import "@typespec/json-schema";

using TypeSpec.Http;
using TypeSpec.JsonSchema;
using TypeSpec.OpenAPI;

@service(#{ title: "Patrol API" })
@info(#{ version: "0.1.0" })
@jsonSchema("https://patrol.example/schemas/")
namespace Patrol;

// ---------------------------------------------------------------------------
// Branded identifiers: a scalar extending string, branded only by name+format.
// ---------------------------------------------------------------------------
@format("uuid")
@doc("Opaque identifier of a recorded violation.")
scalar ViolationId extends string;

@format("uuid")
scalar NoticeId extends string;

@format("uri")
scalar SourceUrl extends string;

// ---------------------------------------------------------------------------
// String enum: the only enum shape that survives JSON Schema / OpenAPI.
// ---------------------------------------------------------------------------
enum CaseStatus {
  Open: "open",
  Triage: "triage",
  NoticeSent: "notice_sent",
  Closed: "closed",
}

// The status a title is in with respect to the rights holder.
enum DetectionConfidence {
  Low: "low",
  Medium: "medium",
  High: "high",
}

// ---------------------------------------------------------------------------
// Recursive model: evidence can be derived from other evidence.
// ---------------------------------------------------------------------------
model Evidence {
  id: string;
  kind: "screenshot" | "html" | "video";
  capturedAt: utcDateTime;
  sha256: string;

  /** Recursion: an artefact may be derived from a previous capture. */
  derivedFrom?: Evidence;
}

model Violation {
  id: ViolationId;
  titleId: string;
  status: CaseStatus = CaseStatus.Open;
  confidence: DetectionConfidence = DetectionConfidence.Low;
  detectedAt: utcDateTime;
  sourceUrl: SourceUrl;
  evidence: Evidence[];
  note?: string | null;
}

model Page<T> {
  items: T[];
  total: int32;
  nextCursor?: string;
}

model NotFound {
  @statusCode _: 404;
  message: string;
}

// ---------------------------------------------------------------------------
// Discriminated union: notice channel selects the payload shape.
// ---------------------------------------------------------------------------
// Plain union of models that each carry their own literal discriminator.
// `@discriminated` + envelope "none" does not inject the property into the
// emitted schemas (verified in tsp-gaps/), so the literal lives on the model.
union Notice {
  google: DmcaNotice,
  yandex: InfringementNotice,
}

model DmcaNotice {
  channel: "google";
  id: NoticeId;
  violationId: ViolationId;
  submittedAt?: utcDateTime;
  /** Workflow state, defaults are part of the contract. */
  retryCount: int32 = 0;
}

model InfringementNotice {
  channel: "yandex";
  id: NoticeId;
  violationId: ViolationId;
  submittedAt?: utcDateTime;
  retryCount: int32 = 0;
}

model CreateNoticeRequest {
  violationId: ViolationId;
  channel: "google" | "yandex";
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------
@route("/violations")
interface Violations {
  @get
  list(
    @query page: int32 = 1,
    @query pageSize: int32 = 20,
    @query status?: CaseStatus,
  ): Page<Violation> | NotFound;

  @get
  @route("/{id}")
  read(@path id: ViolationId): Violation | NotFound;

  @post
  @route("/{id}/notices")
  createNotice(
    @path id: ViolationId,
    @body body: CreateNoticeRequest,
  ): Notice | NotFound;
}
