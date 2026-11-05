import type { Pool } from "pg";
import type { EvidenceStore } from "@patrol/evidence";
import { type BuiltPackFile, type HandoffPackInput, type PackCaptureFlag } from "./pack.js";
/**
 * The submission that approval settles into (docs/design/
 * notice-composition.md "Approval" step 4; ADR 0020): ONE pending row per
 * notice — the unique key makes a duplicate wake-up a no-op — created once
 * every pre-handoff capture the approval queued has reached a terminal
 * state.
 *
 * The work is split by deployment topology, and the split is a fact of the
 * design, not an implementation detail: the WORKER settles captures, so its
 * settle hook writes DATABASE rows only (the submission row, nothing else);
 * the API owns the object store, so the pack's BYTES are built and stored
 * from the API — idempotently, on the first pack read, an interrupted build
 * leaves orphaned content-addressed bytes rather than a dangling pack
 * reference. The pack renders in the language FROZEN at approval (the
 * notice's approval_language column), never in a preference read at settle
 * or build time.
 */
/** The half of the evidence store the pack write path needs. */
export type PackStore = Pick<EvidenceStore, "putArtifact" | "presignDownload">;
/** The settle path's dependencies: the database and the clock, nothing else. */
export interface SettleDeps {
    pool: Pool;
    now: () => Date;
}
/** The pack build path's dependencies (an API-side caller brings the store). */
export interface PackBuildDeps {
    pool: Pool;
    now: () => Date;
    store: PackStore;
}
/** The capture states nothing more will happen in. */
export declare const TERMINAL_CAPTURE_STATES: readonly string[];
/**
 * The pack-level capture flags for every cited URL, in one batched query —
 * the newest capture per URL and, when that newest is not itself a live
 * capture, the newest capture that is. This is the ONE loader the pack
 * builder and the pack read share, so the two can never drift.
 *
 * Null-handling, fixed and documented: a cited URL with no capture at all
 * produces NO flag — the contract's CaptureFlag requires the newest
 * capture's id and outcome, and a URL nothing ever observed cannot fill
 * them. (In practice every cited URL carries at least the composition-time
 * capture; the guard is for the vacuum case.)
 */
export declare function loadCaptureFlagsForCitations(pool: Pool, noticeId: string): Promise<PackCaptureFlag[]>;
/**
 * Assembles the pack input from the frozen notice's stored content. State
 * guard: only an APPROVED notice has a pack — a withdrawn or superseded
 * notice never gets bytes built (the read answers not found), and a draft
 * has nothing frozen to render.
 */
export declare function loadPackInput(pool: Pool, noticeId: string): Promise<HandoffPackInput | null>;
/**
 * Builds the pack's files and stores them content-addressed. Deterministic
 * by construction: identical frozen content produces identical bytes, and
 * the store's HEAD dedup makes the second write of the same bytes a no-op.
 */
export declare function storePackFiles(store: PackStore, input: HandoffPackInput): Promise<{
    files: BuiltPackFile[];
    hash: string;
    manifest: Array<{
        name: string;
        sha256: string;
        size: number;
    }>;
}>;
export interface SubmissionCreation {
    created: boolean;
    submissionId: string | null;
}
/**
 * Creates the notice's pending submission once the captures have settled —
 * DATABASE rows only: the pack's bytes are the API's to build (see the
 * module comment). Idempotent: a second call finds the submission row
 * standing and writes nothing.
 */
export declare function createPendingSubmissionIfSettled(deps: SettleDeps, noticeId: string): Promise<SubmissionCreation>;
export interface PackBuildOutcome {
    built: boolean;
}
/**
 * Builds and stores the notice's handoff pack when it does not stand — the
 * API-side half of the topology split (the worker settles rows, the API
 * owns the object store). Idempotent three ways at once: a pack that
 * already stands is left alone; a submission row that already stands is
 * never duplicated (only its pack reference is filled); and the bytes go
 * into the content-addressed store FIRST, so a failure between the bytes
 * and the rows leaves orphaned objects a retry re-covers, never a pack
 * reference pointing at nothing.
 *
 * Refused (built: false) for a notice that is not approved — a withdrawn or
 * superseded notice never gets a pack — and before the settle has created
 * the submission row; the read route answers not found for both.
 */
export declare function buildHandoffPackIfMissing(deps: PackBuildDeps, noticeId: string, builtBy: string): Promise<PackBuildOutcome>;
/**
 * The capture runner's post-terminal hook (slice 6b's worker half): a
 * pre-handoff capture that reached a terminal state wakes the notices that
 * waited on it, and each whose queue has fully settled gets its pending
 * submission — the DATABASE row alone; the pack's bytes are built by the
 * API (the topology grants the object store to it alone), idempotently on
 * the first pack read. Returns the submission ids it created; failures are
 * the caller's to log — the capture's own record already stands.
 */
export declare function settlePreHandoffCapture(deps: SettleDeps, captureId: string): Promise<string[]>;
