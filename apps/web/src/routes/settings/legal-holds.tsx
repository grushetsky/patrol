import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { t } from "@patrol/i18n";
import { api } from "../../lib/api/client";
import { fetchSessionCsrfToken } from "../../lib/api/auth";
import { useSession } from "../../lib/session";
import { Chip, PageHead, Panel, Skeleton } from "../../components/ui";

/**
 * The legal holds screen (docs/design/evidence-capture.md "Retention"; ADR
 * 0017): the holds that outrank every purge rule, placed over captures,
 * violations, or notices, and the administrator's release that lets the
 * next retention run purge what the hold suspended. Operators place and
 * read; only administrators release — the contract's role, enforced
 * server-side and mirrored by the disabled button here.
 */
export const Route = createFileRoute("/settings/legal-holds")({
  component: LegalHoldsScreen,
});

interface HoldRow {
  id: string;
  reason: string;
  evidenceIds: string[];
  violationIds: string[];
  noticeIds: string[];
  createdBy: string;
  createdAt: string;
  releasedAt?: string;
  releasedBy?: string;
}

function parseIds(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function LegalHoldsScreen() {
  const { locale, role } = useSession();
  const isAdmin = role === "administrator";
  const [holds, setHolds] = useState<HoldRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [evidenceIds, setEvidenceIds] = useState("");
  const [violationIds, setViolationIds] = useState("");
  const [noticeIds, setNoticeIds] = useState("");
  const [releaseReason, setReleaseReason] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const { data, response } = await api.GET("/legal-holds");
    if (response.ok && data) {
      setHolds(data.items as HoldRow[]);
    } else {
      setError(t(locale, "web.common.error"));
    }
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  async function withCsrf(run: (token: string) => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const csrfToken = await fetchSessionCsrfToken();
      if (csrfToken === null) {
        setError(t(locale, "errors.unauthenticated"));
        return;
      }
      await run(csrfToken);
    } finally {
      setBusy(false);
    }
  }

  function placeHold(event: React.FormEvent) {
    event.preventDefault();
    void withCsrf(async (csrfToken) => {
      const { response } = await api.POST("/legal-holds", {
        params: { header: { "X-Patrol-CSRF": csrfToken } },
        body: {
          // The server trims and rejects blank reasons; trimming here keeps
          // a padded input from costing the operator a 422 round trip.
          reason: reason.trim(),
          evidenceIds: parseIds(evidenceIds),
          violationIds: parseIds(violationIds),
          noticeIds: parseIds(noticeIds),
        },
      });
      if (response.ok) {
        setReason("");
        setEvidenceIds("");
        setViolationIds("");
        setNoticeIds("");
        await load();
        return;
      }
      setError(t(locale, "web.common.error"));
    });
  }

  function releaseHold(holdId: string) {
    void withCsrf(async (csrfToken) => {
      const { response } = await api.POST("/legal-holds/{legalHoldId}/release", {
        params: {
          path: { legalHoldId: holdId },
          header: { "X-Patrol-CSRF": csrfToken },
        },
        body: { reason: (releaseReason[holdId] ?? "").trim() },
      });
      if (response.ok) {
        await load();
        return;
      }
      setError(t(locale, "web.common.error"));
    });
  }

  return (
    <main className="page stack">
      <PageHead
        eyebrow={t(locale, "web.nav.settings")}
        title={t(locale, "web.holds.title")}
        note={t(locale, "web.holds.lede")}
        actions={
          <Link className="btn btn-ghost btn-sm" to="/settings">
            {t(locale, "web.settings.title")}
          </Link>
        }
      />
      {error !== null && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}

      <Panel title={t(locale, "web.holds.create")}>
        <form className="form-grid" onSubmit={placeHold}>
          <div className="form-row">
            <label className="field" style={{ flex: "1 1 320px" }}>
              <span>{t(locale, "web.holds.reason")}</span>
              <input
                className="input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
              />
            </label>
          </div>
          <div className="form-row">
            <label className="field">
              <span>{t(locale, "web.holds.evidenceIds")}</span>
              <input
                className="input mono"
                value={evidenceIds}
                onChange={(e) => setEvidenceIds(e.target.value)}
                placeholder="00000000-0000-7000-8000-000000000000"
              />
            </label>
            <label className="field">
              <span>{t(locale, "web.holds.violationIds")}</span>
              <input
                className="input mono"
                value={violationIds}
                onChange={(e) => setViolationIds(e.target.value)}
                placeholder="00000000-0000-7000-8000-000000000000"
              />
            </label>
            <label className="field">
              <span>{t(locale, "web.holds.noticeIds")}</span>
              <input
                className="input mono"
                value={noticeIds}
                onChange={(e) => setNoticeIds(e.target.value)}
                placeholder="00000000-0000-7000-8000-000000000000"
              />
            </label>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              {t(locale, "web.holds.create")}
            </button>
          </div>
        </form>
      </Panel>

      {holds === null ? (
        <div aria-busy="true">
          {[0, 1].map((index) => (
            <div key={index} style={{ padding: "10px 0" }}>
              <Skeleton variant="wide" />
            </div>
          ))}
        </div>
      ) : holds.length === 0 ? (
        <p className="page-note">{t(locale, "web.holds.empty")}</p>
      ) : (
        holds.map((hold) => (
          <Panel
            key={hold.id}
            title={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <Chip tone={hold.releasedAt === undefined ? "danger" : "muted"} dot>
                  {t(
                    locale,
                    hold.releasedAt === undefined ? "web.holds.active" : "web.holds.released",
                  )}
                </Chip>
                <span className="mono" style={{ fontSize: 12 }}>
                  {hold.id.slice(0, 8)}
                </span>
              </span>
            }
          >
            <dl className="kv" style={{ marginBottom: isAdmin && hold.releasedAt === undefined ? 16 : 0 }}>
              <dt>{t(locale, "web.holds.reason")}</dt>
              <dd>{hold.reason}</dd>
              <dt>{t(locale, "web.holds.createdBy")}</dt>
              <dd className="mono" style={{ fontSize: 12 }}>
                {hold.createdBy.slice(0, 8)}
              </dd>
              <dt>{t(locale, "web.holds.scopes")}</dt>
              <dd className="mono" style={{ fontSize: 12 }}>
                {hold.evidenceIds.length > 0 && `evidence: ${hold.evidenceIds.length} · `}
                {hold.violationIds.length > 0 && `violations: ${hold.violationIds.length} · `}
                {hold.noticeIds.length > 0 && `notices: ${hold.noticeIds.length}`}
              </dd>
              <dt>{t(locale, "web.holds.createdAt")}</dt>
              <dd>{hold.createdAt}</dd>
              {hold.releasedAt !== undefined && (
                <>
                  <dt>{t(locale, "web.holds.released")}</dt>
                  <dd>{hold.releasedAt}</dd>
                </>
              )}
            </dl>
            {isAdmin && hold.releasedAt === undefined && (
              <form
                className="form-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  releaseHold(hold.id);
                }}
              >
                <label className="field" style={{ flex: "1 1 260px" }}>
                  <span>{t(locale, "web.holds.releaseReason")}</span>
                  <input
                    className="input"
                    value={releaseReason[hold.id] ?? ""}
                    onChange={(e) =>
                      setReleaseReason((current) => ({ ...current, [hold.id]: e.target.value }))
                    }
                    required
                  />
                </label>
                <button type="submit" className="btn btn-sm" disabled={busy}>
                  {t(locale, "web.holds.release")}
                </button>
              </form>
            )}
          </Panel>
        ))
      )}
    </main>
  );
}
