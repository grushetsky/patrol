import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { t } from "@patrol/i18n";
import { ATTEMPT_COUNT_BEFORE_FLAG } from "@patrol/notices";
import { api } from "../../lib/api/client";
import { useSession } from "../../lib/session";

/**
 * The submissions screen (slice 7): the single delivery attempt of every
 * approved notice, with the state, notice, and backlog filters the contract
 * declares — `olderThanDays=7` is the seven-day reminder's surface, the
 * same backlog the daily `submission.remind` job logs and the dashboard
 * badge will count. Each row links to the notice whose detail carries the
 * submission panel the operator acts in.
 */

interface SubmissionDetail {
  submission: {
    id: string;
    noticeId: string;
    attemptCount: number;
    createdAt: string;
    cancelledAt?: string;
    lifecycle: {
      state: "pending" | "delivered" | "acknowledged" | "rejected" | "failed";
      operatorId?: string;
      failure?: { reason: string; note: string };
      acknowledgement?: { recipient: string; referenceNumber?: string; ticketId?: string; messageId?: string };
    };
  };
  notice: { id: string; recipient: "google" | "bing" | "yandex"; status: string; createdAt: string };
  packAvailable: boolean;
}

const STATE_KEYS: Record<string, string> = {
  pending: "web.notices.status.approved",
  delivered: "web.notices.status.delivered",
  acknowledged: "web.notices.status.acknowledged",
  rejected: "web.notices.status.rejected",
  failed: "web.notices.status.failed",
};

const RECIPIENT_KEYS: Record<string, string> = {
  google: "web.notices.recipient.google",
  bing: "web.notices.recipient.bing",
  yandex: "web.notices.recipient.yandex",
};

export const Route = createFileRoute("/submissions/")({
  component: SubmissionsIndex,
});

function SubmissionsIndex() {
  const { locale } = useSession();
  const [state, setState] = useState<string>("");
  const [noticeId, setNoticeId] = useState<string>("");
  const [backlogOnly, setBacklogOnly] = useState(false);
  const [items, setItems] = useState<SubmissionDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const query: Record<string, string | number> = { pageSize: 200 };
    if (state !== "") {
      query.state = state;
    }
    if (noticeId.trim() !== "") {
      query.noticeId = noticeId.trim();
    }
    if (backlogOnly) {
      query.olderThanDays = 7;
    }
    const { data, response } = await api.GET("/submissions", {
      params: { query: query as never },
    });
    if (response.ok && data) {
      setItems(data.items as SubmissionDetail[]);
      setError(null);
    } else {
      setError(t(locale, "web.common.error"));
    }
  }, [locale, state, noticeId, backlogOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const label = (key: string): string => {
    const message = STATE_KEYS[key];
    return message === undefined ? key : t(locale, message as never);
  };

  return (
    <main>
      <h1>{t(locale, "web.submissions.title")}</h1>
      {error !== null && <p role="alert">{error}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
        style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}
      >
        <label>
          {t(locale, "web.submissions.filter.state")}
          <select value={state} onChange={(event) => setState(event.target.value)}>
            <option value="">{t(locale, "web.submissions.filter.all")}</option>
            {Object.keys(STATE_KEYS).map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t(locale, "web.submissions.filter.noticeId")}
          <input value={noticeId} onChange={(event) => setNoticeId(event.target.value)} />
        </label>
        <label>
          <input
            type="checkbox"
            checked={backlogOnly}
            onChange={(event) => setBacklogOnly(event.target.checked)}
          />{" "}
          {t(locale, "web.submissions.filter.backlog")}
        </label>
        <button type="submit">{t(locale, "web.submissions.filter.apply")}</button>
      </form>
      {items === null ? (
        <p>{t(locale, "web.common.loading")}</p>
      ) : items.length === 0 ? (
        <p>
          {t(locale, "web.submissions.empty")}{" "}
          <Link to="/notices">{t(locale, "web.notices.title")}</Link>
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">{t(locale, "web.submissions.column.notice")}</th>
              <th scope="col">{t(locale, "web.submissions.column.recipient")}</th>
              <th scope="col">{t(locale, "web.submissions.column.state")}</th>
              <th scope="col">{t(locale, "web.submissions.column.attempts")}</th>
              <th scope="col">{t(locale, "web.submissions.column.createdAt")}</th>
              <th scope="col">{t(locale, "web.submissions.column.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.submission.id}>
                <td>
                  <code>{item.submission.noticeId.slice(0, 8)}</code>
                </td>
                <td>
                  {t(locale, (RECIPIENT_KEYS[item.notice.recipient] ?? "web.notices.recipient.google") as never)}
                </td>
                <td>
                  {label(item.submission.lifecycle.state)}
                  {item.submission.cancelledAt !== undefined
                    ? ` · ${t(locale, "web.notices.detail.submission.cancelled")}`
                    : ""}
                  {/* The three-attempt flag, derived where the UI stands:
                      the contract's Submission carries no flaggedAt (its
                      shape is closed), so the badge mirrors the server's
                      flagged read model — a failure that landed with the
                      row already carrying ATTEMPT_COUNT_BEFORE_FLAG
                      re-files raised the durable flag. Slice 8's dashboard
                      badge surfaces the read model itself. */}
                  {item.submission.lifecycle.state === "failed" &&
                  item.submission.attemptCount >= ATTEMPT_COUNT_BEFORE_FLAG
                    ? ` · ${t(locale, "web.submissions.flagged")}`
                    : ""}
                </td>
                <td>{item.submission.attemptCount}</td>
                <td>
                  <time dateTime={item.submission.createdAt}>
                    {item.submission.createdAt.slice(0, 10)}
                  </time>
                </td>
                <td>
                  <Link params={{ noticeId: item.submission.noticeId }} to="/notices/$noticeId">
                    {t(locale, "web.submissions.open")}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
