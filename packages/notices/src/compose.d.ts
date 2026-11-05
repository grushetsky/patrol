import type { Pool, PoolClient } from "pg";
import type { Recipient } from "./statements.js";
/**
 * The draft composer (docs/design/notice-composition.md "What a notice
 * carries", "Grouping per recipient", "Composition triggers and windows"):
 * one transaction turns a selection of OPEN violations into draft notices —
 * grouped per the recipient's cardinality, stamped with the active
 * statement template, carrying work identification per cited title and the
 * form-ordered resolved field map — and the citations RESERVE the
 * violations the moment the draft cites them.
 *
 * Two invariants the database holds and this module translates:
 *
 * - RESERVATION: a violation is cited by at most one notice that is not
 *   withdrawn, superseded, rejected, or failed. On demand this is a
 *   refusal (`violation_reserved`); the scheduled path DROPS a violation
 *   another draft reserved and composes the rest, because a window that
 *   lost a race to a manual draft must still cover everything else.
 * - DEDUPLICATION: (recipient profile, normalized URL, tracked title) is
 *   unique among the same active states, so a recipient never receives the
 *   same URL twice.
 *
 * The race is covered by the partial unique indexes; the pre-checks give
 * the refusal its evidence (which violations, which notice).
 */
/** The composer's database and clock. */
export interface ComposeDeps {
    pool: Pool;
    now: () => Date;
}
/** What a composer call composes from. */
export interface ComposeSelection {
    recipient: Recipient;
    recipientProfileId: string;
    violationIds: string[];
    trigger: "on_demand" | "scheduled";
    /** The operator the notice records as its creator. */
    composedBy: string;
}
/** Every refusal the composer can answer, in the API's error vocabulary. */
export type ComposeRefusal = {
    status: "profile_absent";
} | {
    status: "recipient_mismatch";
    profileRecipient: Recipient;
} | {
    status: "rights_holder_absent";
} | {
    status: "recipient_ineligible";
    reason: "territory" | "account" | "contact";
} | {
    status: "template_absent";
} | {
    status: "empty_selection";
} | {
    status: "violation_absent";
    violationIds: string[];
} | {
    status: "violation_not_open";
    violationId: string;
    state: string;
} | {
    status: "grouping_limit_exceeded";
    batches: number;
} | {
    status: "violation_reserved";
    conflictingViolationIds: string[];
    existingNoticeId: string;
} | {
    status: "violation_needs_review";
    conflictingViolationIds: string[];
    existingNoticeId: string;
} | {
    status: "duplicate_entity";
    violationId: string;
    existingNoticeId: string;
};
export type ComposeOutcome = {
    status: "composed";
    notices: ComposedNotice[];
} | {
    status: "refused";
    refusal: ComposeRefusal;
};
/** One composed draft. */
export interface ComposedNotice {
    noticeId: string;
    citationCount: number;
}
/** The rights-holder facts the resolved field map renders from. */
export interface RightsHolderFacts {
    legalName: string;
    country: string;
    address: string | null;
    roleMailbox: string | null;
    phone: string | null;
    signatoryFullLegalName: string | null;
}
/** The profile slice the composer reads. */
export interface ProfileFacts {
    id: string;
    recipient: Recipient;
    channel: "web_form" | "trusted_program";
    account: string;
    contactEmail: string | null;
    eligibleTerritories: string[];
    maxUrlsPerNotice: number | null;
    maxUrlsPerFile: number | null;
    lastObservedMaxUrlsPerFile: number | null;
}
/** One resolved field of the recipient's form, form-ordered. */
export interface ResolvedFieldSeed {
    name: string;
    value: string;
    required: boolean;
    maxLength?: number;
}
/** The recipient's form language Patrol composes in. */
export declare const NOTICE_LANGUAGE = "en";
/**
 * The citation states that keep a reservation and the recipient-level
 * dedup alive — a notice that is neither withdrawn, superseded, rejected,
 * nor failed. The same set is spelled as SQL literals in
 * packages/db/drizzle/0008_notices.sql (the notice_citations state CHECK's
 * active prefix and the two partial unique indexes); SQL cannot import
 * this constant, so the homes move together by hand.
 */
export declare const ACTIVE_CITATION_STATES: readonly ["draft", "approved"];
/**
 * The active-citation states as a SQL `in (...)` literal — the one place
 * the constant is spelled for queries (compose.ts and schedule.ts share
 * it; the migration's literals are cross-referenced above).
 */
export declare const ACTIVE_CITATION_STATES_SQL: string;
/**
 * The territories Yandex's copyright process accepts rights holders from:
 * the United States, Switzerland, and the EU member states (the research's
 * territory note — docs/research/recipient-statements.md §3). This is the
 * CHANNEL floor; the profile's `eligibleTerritories` can only narrow it,
 * never widen it. The EU-27 membership list is fixed here, single-homed —
 * do not duplicate it elsewhere.
 */
export declare const YANDEX_ELIGIBLE_TERRITORIES: readonly string[];
/**
 * The eligibility gate (design "Grouping per recipient / Eligibility"):
 * Google needs the profile's account, Bing the contact mailbox, Yandex a
 * rights holder inside the profile's eligible territories — where "inside"
 * means the Yandex CHANNEL FLOOR (US, Switzerland, EU member states) first
 * and the profile's list second: an empty territory list means the floor,
 * not every territory in the world.
 */
export declare function checkEligibility(recipient: Recipient, profile: ProfileFacts, rightsHolder: RightsHolderFacts): {
    ok: true;
} | {
    ok: false;
    reason: "territory" | "account" | "contact";
};
/** Joins the rights holder's postal address into one form value. */
export declare function addressValue(rightsHolder: {
    address_line1: string | null;
    address_line2: string | null;
    address_city: string | null;
    address_region: string | null;
    address_postal_code: string | null;
}): string | null;
/**
 * The form-ordered resolved field map per recipient, from the research's
 * field map (docs/research/notice-submission.md §1). The signature renders
 * the signatory's full legal name in every recipient's form; the DATE is
 * rendered into the pack at handoff, never into a notice, so it is not a
 * resolved field. The authorized example URL is the operator's to complete
 * where the form requires one Patrol cannot resolve.
 */
export declare function resolvedFieldsFor(recipient: Recipient, rightsHolder: RightsHolderFacts): ResolvedFieldSeed[];
/** The template facts content resolution reads: the set a notice stamps. */
export interface TemplateFacts {
    identifier: string;
    statements: ReadonlyArray<{
        key: string;
        text: string;
    }>;
}
/** The citation facts a work identification renders from. */
export interface CitationFacts {
    violationId: string;
    trackedTitleId: string;
    displayTitle: string;
    releaseYear: number;
    titleType: "film" | "series" | "miniseries" | "other";
}
/** Everything the notice's content resolves from — all live reads. */
export interface NoticeContentInputs {
    recipient: Recipient;
    template: TemplateFacts;
    rightsHolder: RightsHolderFacts;
    citations: readonly CitationFacts[];
}
/** One work identification seed, in first-appearance order. */
export interface WorkIdentificationSeed {
    trackedTitleId: string;
    displayTitle: string;
    releaseYear: number;
    titleType: CitationFacts["titleType"];
}
/** The notice's resolved content: what the child tables store. */
export interface ResolvedNoticeContent {
    templateVersion: string;
    statements: ReadonlyArray<{
        key: string;
        text: string;
    }>;
    workIdentifications: ReadonlyArray<WorkIdentificationSeed>;
    resolvedFields: ResolvedFieldSeed[];
}
/**
 * Resolves the notice's content from the inputs it is handed — a PURE
 * function, no database. The composer calls it with the reads it just took,
 * so a draft carries a preview of the resolved field map (the signature
 * included) and the work identifications; the design freezes them at
 * APPROVAL, not composition, so the approval (approval.ts) recomputes
 * through this same function from FRESH rights-holder/signatory/profile
 * reads before it freezes — a draft's stored values are never trusted as
 * the frozen content.
 */
export declare function resolveNoticeContent(inputs: NoticeContentInputs): ResolvedNoticeContent;
/**
 * Composes draft notices from a selection of open violations, grouped per
 * the recipient. On demand the selection must fit ONE notice (POST /notices
 * composes one draft and answers once — an over-cap batch is the operator's
 * to split); the scheduled path splits into one notice per batch and drops
 * violations a concurrent draft reserved.
 */
export declare function composeNotices(deps: ComposeDeps, selection: ComposeSelection): Promise<ComposeOutcome>;
/**
 * The composer's core, inside a caller's transaction. The scheduled runner
 * shares ITS transaction (claiming the window row takes a KEY SHARE lock
 * on the profile through the foreign key, which a second connection's
 * `for update` would wait on forever — a classic self-deadlock), so this
 * export exists for it; every other caller goes through `composeNotices`.
 */
export declare function composeInTransaction(client: PoolClient, now: () => Date, selection: ComposeSelection): Promise<ComposeOutcome>;
