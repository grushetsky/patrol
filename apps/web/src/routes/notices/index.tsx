import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { t } from "@patrol/i18n";
import { api } from "../../lib/api/client";
import { useSession } from "../../lib/session";
import { Chip, EmptyState, PageHead, Skeleton } from "../../components/ui";
import { Icon } from "../../components/icons";

/**
 * The notices screen (docs/design/dashboard-ui.md "Notices"): one card per
 * notice with its identifier, recipient, cited-violation count, signatory,
 * drafting time, and the derived status chip. The card links to the detail
 * that carries the lifecycle stepper, the approval panel, the document, and
 * the handoff pack.
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

/** The chip tone each status reads as (prototype: amber draft, blue sent,
 *  green acknowledged, muted terminal). */
const STATUS_TONES: Record<string, "amber" | "blue" | "green" | "muted" | "danger"> = {
  draft: "amber",
  approved: "blue",
  delivered: "blue",
  acknowledged: "green",
  rejected: "danger",
  failed: "danger",
  withdrawn: "muted",
  superseded: "muted",
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
    <main className="page">
      <PageHead
        eyebrow={t(locale, "web.notices.eyebrow")}
        title={t(locale, "web.notices.title")}
        actions={
          <Link className="btn btn-ghost btn-sm" to="/submissions">
            {t(locale, "web.submissions.title")}
          </Link>
        }
      />
      {error !== null && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}
      {cards === null ? (
        <div className="notices" aria-busy="true">
          {[0, 1, 2].map((index) => (
            <div key={index} className="notice" aria-hidden="true">
              <div className="notice-head">
                <Skeleton variant="score" />
                <Skeleton variant="wide" />
              </div>
            </div>
          ))}
        </div>
      ) : cards.length === 0 ? (
        <EmptyState
          title={t(locale, "web.notices.empty.title")}
          action={
            <Link className="btn btn-primary" to="/violations">
              <Icon name="shield" size="sm" />
              <span>{t(locale, "web.notices.goToViolations")}</span>
            </Link>
          }
        >
          {t(locale, "web.notices.empty")}
        </EmptyState>
      ) : (
        <div className="notices">
          {cards.map((card) => (
            <article key={card.id} className="notice">
              <div className="notice-head">
                <span className="notice-glyph">
                  <Icon name="file" />
                </span>
                <div className="notice-main">
                  {/* The detail route carries the stepper, the approval
                      panel, the document, and the pack. */}
                  <Link
                    params={{ noticeId: card.id }}
                    to="/notices/$noticeId"
                    className="notice-id"
                    style={{ textDecoration: "none", color: "inherit" }}
                  >
                    <code>{card.id.slice(0, 8)}</code>
                  </Link>
                  <div className="notice-sub">
                    {t(locale, RECIPIENT_KEYS[card.recipient] as never)} ·{" "}
                    {t(locale, "web.notices.column.violations")} {card.violationCount} ·{" "}
                    {card.signatoryName ?? "—"} ·{" "}
                    <time dateTime={card.createdAt}>{card.createdAt.slice(0, 10)}</time>
                  </div>
                </div>
                <Chip tone={STATUS_TONES[card.status] ?? "muted"} dot={card.status === "draft"}>
                  {status(card.status)}
                </Chip>
                <div className="notice-actions">
                  <Link
                    className="btn btn-ghost btn-sm"
                    params={{ noticeId: card.id }}
                    to="/notices/$noticeId"
                  >
                    {card.status === "draft"
                      ? t(locale, "web.notices.approve")
                      : t(locale, "web.notices.detail.pack.title")}
                  </Link>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
