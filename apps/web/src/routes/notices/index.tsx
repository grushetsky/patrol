import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { t } from "@patrol/i18n";
import { api } from "../../lib/api/client";
import { useSession } from "../../lib/session";

/**
 * The notices screen (docs/design/dashboard-ui.md "Notices"): one card per
 * notice with its recipient, cited-violation count, the signatory once
 * approval snapshots one, and the derived status chip. A draft's actions
 * are the approvals and withdrawals of slice 6b: the approve control is
 * present but disabled, so the screen's shape is the one 6b brings to life.
 */

interface NoticeCard {
  id: string;
  recipient: "google" | "bing" | "yandex";
  violationCount: number;
  signatoryName?: string;
  createdAt: string;
  status: string;
  packAvailable: boolean;
}

export const Route = createFileRoute("/notices/")({
  component: NoticesIndex,
});

/** The status chip a card renders, keyed by the derived status. */
const STATUS_KEYS: Record<string, string> = {
  draft: "web.notices.status.draft",
  approved: "web.notices.status.approved",
  delivered: "web.notices.status.delivered",
  acknowledged: "web.notices.status.acknowledged",
  rejected: "web.notices.status.rejected",
  failed: "web.notices.status.failed",
  withdrawn: "web.notices.status.withdrawn",
  superseded: "web.notices.status.superseded",
};

const RECIPIENT_KEYS: Record<string, string> = {
  google: "web.notices.recipient.google",
  bing: "web.notices.recipient.bing",
  yandex: "web.notices.recipient.yandex",
};

function NoticesIndex() {
  const { locale } = useSession();
  const [cards, setCards] = useState<NoticeCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, response } = await api.GET("/notices", {
      params: { query: { pageSize: 200 } },
    });
    if (response.ok && data) {
      setCards(data.items as NoticeCard[]);
      setError(null);
    } else {
      setError(t(locale, "web.common.error"));
    }
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const status = (key: string): string => {
    const message = STATUS_KEYS[key];
    return message === undefined ? key : t(locale, message as never);
  };

  return (
    <main>
      <h1>{t(locale, "web.notices.title")}</h1>
      {error !== null && <p role="alert">{error}</p>}
      {cards === null ? (
        <p>{t(locale, "web.common.loading")}</p>
      ) : cards.length === 0 ? (
        <p>
          {t(locale, "web.notices.empty")}{" "}
          <Link to="/violations">{t(locale, "web.notices.goToViolations")}</Link>
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">{t(locale, "web.notices.column.id")}</th>
              <th scope="col">{t(locale, "web.notices.column.recipient")}</th>
              <th scope="col">{t(locale, "web.notices.column.violations")}</th>
              <th scope="col">{t(locale, "web.notices.column.signatory")}</th>
              <th scope="col">{t(locale, "web.notices.column.createdAt")}</th>
              <th scope="col">{t(locale, "web.notices.column.status")}</th>
              <th scope="col">{t(locale, "web.notices.column.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {cards.map((card) => (
              <tr key={card.id}>
                <td>
                  {/* TODO(slice-6b): the id becomes a link to the notice's
                      detail route once the card/stepper form exists — a
                      self-link to the list is no link at all. */}
                  <code>{card.id.slice(0, 8)}</code>
                </td>
                <td>
                  {t(
                    locale,
                    (RECIPIENT_KEYS[card.recipient] ?? "web.notices.recipient.google") as never,
                  )}
                </td>
                <td>{card.violationCount}</td>
                <td>
                  {card.signatoryName === undefined ? (
                    <small>—</small>
                  ) : (
                    card.signatoryName
                  )}
                </td>
                <td>
                  <time dateTime={card.createdAt}>{card.createdAt.slice(0, 10)}</time>
                </td>
                <td>{status(card.status)}</td>
                <td>
                  {/* Approval, withdrawal, and the pack arrive with slice
                      6b; the control stands disabled so its place is the
                      one 6b brings to life. */}
                  <button
                    type="button"
                    disabled
                    title={t(locale, "web.notices.approveDisabled")}
                  >
                    {t(locale, "web.notices.approve")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
