import type { Connectable } from "../db/migrations.js";
import { ApiError, unprocessable } from "../errors.js";
import { pageOf, type Page } from "../http.js";
import {
  noticeStatus,
  toNoticeRef,
  toSubmission,
} from "../notices/records.js";

const PAUSE_THRESHOLD = 0.1;
const PAUSE_WINDOW = 20;

export interface SubmissionFilters {
  state?: string;
  noticeId?: string;
  olderThanDays?: number;
}

export interface DeliveryInput {
  attestation: {
    filedAsPresented: boolean;
    statementVersion: string;
  };
}

export interface AcknowledgementInput {
  attestation: {
    filedAsPresented: boolean;
    statementVersion: string;
  };
  acknowledgement: Record<string, unknown>;
}

export interface FailureInput {
  reason: string;
  note: string;
}

/** Submission state, delivery attestation, acknowledgements, failures, and retries. */
export class SubmissionService {
  constructor(
    private readonly db: Connectable,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(filters: SubmissionFilters, page: Page) {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filters.state) {
      values.push(filters.state);
      conditions.push(`s.state = $${values.length}`);
    }
    if (filters.noticeId) {
      values.push(filters.noticeId);
      conditions.push(`s.notice_id = $${values.length}`);
    }
    if (filters.olderThanDays !== undefined) {
      values.push(
        new Date(
          this.clock().getTime() - filters.olderThanDays * 24 * 60 * 60 * 1000,
        ),
      );
      conditions.push(`s.created_at <= $${values.length}`);
      conditions.push("s.state = 'pending'");
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = (
      await this.db.query(
        `SELECT s.*, n.recipient AS notice_recipient, n.created_at AS notice_created_at,
                n.state AS notice_state
           FROM submission s
           JOIN notice n ON n.id = s.notice_id
           ${where}
          ORDER BY s.created_at DESC`,
        values,
      )
    ).rows;
    return pageOf(
      rows.map((row) => ({
        submission: toSubmission(row),
        notice: toNoticeRef(
          {
            id: row.notice_id,
            recipient: row.notice_recipient,
            created_at: row.notice_created_at,
          },
          noticeStatus({ state: row.notice_state }, { state: row.state }),
        ),
        packAvailable: Boolean(row.pack_ref),
      })),
      page,
    );
  }

  async read(id: string) {
    const row = await this.load(id);
    return {
      submission: toSubmission(row),
      notice: toNoticeRef(
        {
          id: row.notice_id,
          recipient: row.notice_recipient,
          created_at: row.notice_created_at,
        },
        noticeStatus({ state: row.notice_state }, { state: row.state }),
      ),
      packAvailable: Boolean(row.pack_ref),
    };
  }

  async deliver(id: string, input: DeliveryInput, operatorId: string) {
    const row = await this.load(id);
    this.assertPending(row);
    if (!input.attestation.filedAsPresented) {
      throw unprocessable([
        {
          path: "/attestation/filedAsPresented",
          message: "The operator must attest that the notice was filed.",
        },
      ]);
    }
    const now = this.clock();
    await this.db.query(
      `UPDATE submission
          SET state = 'delivered', delivered_by = $2, delivered_at = $3,
              attestation = $4, updated_at = $3
        WHERE id = $1`,
      [
        id,
        operatorId,
        now,
        JSON.stringify({
          filedAsPresented: true,
          statementVersion: input.attestation.statementVersion,
          attestedAt: now.toISOString(),
        }),
      ],
    );
    return toSubmission(await this.load(id));
  }

  async acknowledge(id: string, input: AcknowledgementInput, _operatorId: string) {
    const row = await this.load(id);
    if (String(row.state) !== "delivered") {
      throw new ApiError(
        409,
        "state_conflict",
        "Only a delivered submission can be acknowledged.",
        undefined,
        { currentState: String(row.state) },
      );
    }
    const recipient = String(input.acknowledgement.recipient);
    if (recipient !== String(row.notice_recipient)) {
      throw unprocessable([
        {
          path: "/acknowledgement/recipient",
          message: "The acknowledgement does not match the notice's recipient.",
        },
      ]);
    }
    const now = this.clock();
    await this.db.query(
      `UPDATE submission
          SET state = 'acknowledged', acknowledgement = $2, updated_at = $3
        WHERE id = $1`,
      [id, JSON.stringify(input.acknowledgement), now],
    );
    return toSubmission(await this.load(id));
  }

  async fail(id: string, input: FailureInput, operatorId: string) {
    const row = await this.load(id);
    if (!["pending", "delivered"].includes(String(row.state))) {
      throw new ApiError(
        409,
        "state_conflict",
        "The submission is already terminal.",
        undefined,
        { currentState: String(row.state) },
      );
    }
    if (!input.note || input.note.trim() === "") {
      throw new ApiError(422, "note_required", "A failure note is required.");
    }
    const state =
      input.reason === "recipient_rejection" ? "rejected" : "failed";
    const now = this.clock();
    await this.db.query(
      `UPDATE submission
          SET state = $2, failure = $3, updated_at = $4,
              delivered_by = COALESCE(delivered_by, $5)
        WHERE id = $1`,
      [
        id,
        state,
        JSON.stringify({
          reason: input.reason,
          note: input.note.trim(),
          recordedAt: now.toISOString(),
        }),
        now,
        operatorId,
      ],
    );
    await this.updateProfilePause(String(row.recipient_profile_id));
    return toSubmission(await this.load(id));
  }

  async retry(id: string, _operatorId: string) {
    const row = await this.load(id);
    if (!["failed", "rejected"].includes(String(row.state))) {
      throw new ApiError(
        409,
        "state_conflict",
        "Only a failed or rejected submission can be retried.",
        undefined,
        { currentState: String(row.state) },
      );
    }
    if (String(row.notice_state) !== "approved" || row.cancelled_at) {
      throw new ApiError(
        409,
        "submission_not_pending",
        "The notice is no longer awaiting delivery.",
      );
    }
    await this.db.query(
      `UPDATE submission
          SET state = 'pending', failure = NULL, acknowledgement = NULL,
              attempt_count = attempt_count + 1, updated_at = $2
        WHERE id = $1`,
      [id, this.clock()],
    );
    return toSubmission(await this.load(id));
  }

  private async updateProfilePause(profileId: string) {
    const rows = (
      await this.db.query(
        "SELECT state FROM submission WHERE recipient_profile_id = $1 ORDER BY created_at DESC LIMIT $2",
        [profileId, PAUSE_WINDOW],
      )
    ).rows;
    const rejected = rows.filter((row) => String(row.state) === "rejected").length;
    const failed = rows.filter((row) => String(row.state) === "failed").length;
    if (rows.length > 0 && (rejected + failed) / rows.length > PAUSE_THRESHOLD) {
      await this.db.query(
        `UPDATE recipient_profile
            SET paused = true,
                pause_reason = 'The rejection and failure share over the last twenty submissions exceeds ten percent.'
          WHERE id = $1 AND paused = false`,
        [profileId],
      );
    }
  }

  private assertPending(row: Record<string, unknown>) {
    if (String(row.state) !== "pending") {
      throw new ApiError(
        409,
        "state_conflict",
        "Only a pending submission can be delivered.",
        undefined,
        { currentState: String(row.state) },
      );
    }
    if (row.cancelled_at) {
      throw new ApiError(
        409,
        "submission_not_pending",
        "The submission was cancelled.",
      );
    }
  }

  private async load(id: string) {
    const row = (
      await this.db.query(
        `SELECT s.*, n.recipient AS notice_recipient,
                n.created_at AS notice_created_at, n.state AS notice_state,
                n.pack_language AS notice_pack_language
           FROM submission s
           JOIN notice n ON n.id = s.notice_id
          WHERE s.id = $1`,
        [id],
      )
    ).rows[0];
    if (!row) {
      throw new ApiError(404, "not_found", "The submission does not exist.");
    }
    return row;
  }
}
