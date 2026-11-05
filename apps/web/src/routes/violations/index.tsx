import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { t } from "@patrol/i18n";
import { api } from "../../lib/api/client";
import { fetchSessionCsrfToken } from "../../lib/api/auth";
import { useSession } from "../../lib/session";
import { Chip, EmptyState, PageHead, Skeleton } from "../../components/ui";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/toast";

/**
 * The violations screen (docs/design/dashboard-ui.md "Violations"): rows
 * grouped by tracked title, each group heading showing the open count
 * against the total, a title filter, and per-row host, URL, cited capture,
 * and status. Selecting open violations opens the cart fixed at the bottom:
 * the recipient selector addresses one recipient profile, and Draft notice
 * composes the on-demand draft through POST /notices. A refusal — a
 * reserved violation, an over-cap batch, an ineligible recipient — renders
 * the error code's catalogue line beside the cart.
 */

interface ViolationRow {
  violation: {
    id: string;
    trackedTitleId: string;
    url: string;
    host: string;
    lifecycle:
      | { state: "open"; openedAt: string }
      | { state: "removed"; closedAt: string; reason: string }
      | { state: "closed"; closedAt: string; reason: string; note?: string };
  };
  displayTitle: string;
  releaseYear: number;
  newestEvidence?: { id: string; outcome: string };
}

type ViolationGroup = {
  trackedTitleId: string;
  displayTitle: string;
  open: number;
  total: number;
  rows: ViolationRow[];
};

export const Route = createFileRoute("/violations/")({
  component: ViolationsIndex,
});

/** The status chip a row's state renders, keyed by the lifecycle state. */
const STATUS_KEYS = {
  open: "web.violations.state.open",
  removed: "web.violations.state.removed",
  closed: "web.violations.state.closed",
} as const;

function ViolationsIndex() {
  const { locale } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const [rows, setRows] = useState<ViolationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [titleFilter, setTitleFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [profiles, setProfiles] = useState<Array<{ id: string; recipient: string }>>([]);
  const [profileId, setProfileId] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, response } = await api.GET("/violations", {
      params: { query: { pageSize: 200 } },
    });
    if (response.ok && data) {
      setRows(data.items as ViolationRow[]);
      setError(null);
    } else {
      setError(t(locale, "web.common.error"));
    }
  }, [locale]);

  const loadProfiles = useCallback(async () => {
    const { data, response } = await api.GET("/settings/recipient-profiles");
    if (response.ok && data) {
      const loaded = (data.items as Array<{ id: string; recipient: string }>).map((item) => ({
        id: item.id,
        recipient: item.recipient,
      }));
      setProfiles(loaded);
      setProfileId((current) => (current === "" && loaded.length > 0 ? loaded[0].id : current));
    }
  }, []);

  useEffect(() => {
    void load();
    void loadProfiles();
  }, [load, loadProfiles]);

  /** Composes the on-demand draft for the selection, then shows it. */
  const draftNotice = async () => {
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (profile === undefined) {
      setDraftError(t(locale, "web.violations.cart.noProfile"));
      return;
    }
    setDrafting(true);
    setDraftError(null);
    try {
      const csrfToken = await fetchSessionCsrfToken();
      if (csrfToken === null) {
        setDraftError(t(locale, "errors.unauthenticated"));
        return;
      }
      const { data, response } = await api.POST("/notices", {
        params: { header: { "X-Patrol-CSRF": csrfToken } },
        body: {
          recipient: profile.recipient as "google" | "bing" | "yandex",
          recipientProfileId: profile.id,
          violationIds: [...selected],
        },
      });
      if (response.ok && data) {
        setSelected(new Set());
        toast(t(locale, "web.violations.cart.drafted"), "green");
        await navigate({ to: "/notices" });
        return;
      }
      const code = (data as { code?: string } | undefined)?.code;
      if (code === "violation_reserved") {
        // The contract's Violation read model carries no citation info, so
        // the cart cannot know at render time which open violations a
        // notice already reserves — a contract gap to amend when the
        // notices slice lands its detail surface. Until then the honest
        // fallback is the 409's own evidence: the conflict names the
        // reserved violations, the cart deselects them and says so, and
        // the operator re-drafts the rest.
        const conflicting = (data as { conflictingViolationIds?: string[] }).conflictingViolationIds ?? [];
        setSelected((current) => {
          const next = new Set(current);
          for (const id of conflicting) {
            next.delete(id);
          }
          return next;
        });
        const urlOf = (id: string): string =>
          rows?.find((row) => row.violation.id === id)?.violation.url ?? id.slice(0, 8);
        setDraftError(
          t(locale, "web.violations.cart.reserved").replace(
            "{urls}",
            conflicting.map(urlOf).join(", "),
          ),
        );
        return;
      }
      setDraftError(
        code !== undefined && code === "recipient_ineligible"
          ? t(locale, "errors.recipient_ineligible")
          : code !== undefined && code === "grouping_limit_exceeded"
            ? t(locale, "errors.grouping_limit_exceeded")
            : code === "violation_needs_review"
              ? // The remedy is a review decision, not a re-draft: the
                // catalogue line names it.
                t(locale, "errors.violation_needs_review")
              : t(locale, "web.violations.cart.draftFailed"),
      );
    } finally {
      setDrafting(false);
    }
  };

  const groups = useMemo<ViolationGroup[]>(() => {
    const filtered = rows ?? [];
    const byTitle = new Map<string, ViolationGroup>();
    for (const row of filtered) {
      if (titleFilter !== "" && row.violation.trackedTitleId !== titleFilter) {
        continue;
      }
      const group = byTitle.get(row.violation.trackedTitleId) ?? {
        trackedTitleId: row.violation.trackedTitleId,
        displayTitle: row.displayTitle,
        open: 0,
        total: 0,
        rows: [],
      };
      group.total += 1;
      if (row.violation.lifecycle.state === "open") {
        group.open += 1;
      }
      group.rows.push(row);
      byTitle.set(row.violation.trackedTitleId, group);
    }
    return [...byTitle.values()];
  }, [rows, titleFilter]);

  const titleOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const row of rows ?? []) {
      byId.set(row.violation.trackedTitleId, row.displayTitle);
    }
    return [...byId.entries()];
  }, [rows]);

  const toggle = (row: ViolationRow) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(row.violation.id)) {
        next.delete(row.violation.id);
      } else {
        next.add(row.violation.id);
      }
      return next;
    });
  };

  return (
    <main className="page">
      <PageHead
        eyebrow={t(locale, "web.violations.eyebrow")}
        title={t(locale, "web.violations.title")}
        note={t(locale, "web.violations.note")}
      />
      {error !== null && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}
      {rows === null ? (
        <div aria-busy="true" className="stack">
          {[0, 1, 2].map((index) => (
            <div key={index} className="violation" aria-hidden="true">
              <Skeleton variant="score" />
              <Skeleton variant="wide" />
              <Skeleton variant="short" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={t(locale, "web.violations.empty.title")}
          action={
            <Link className="btn btn-primary" to="/review">
              <Icon name="radar" size="sm" />
              <span>{t(locale, "web.violations.goToReview")}</span>
            </Link>
          }
        >
          {t(locale, "web.violations.empty")}
        </EmptyState>
      ) : (
        <>
          <div className="filter-bar" style={{ marginBottom: 18 }}>
            <label className="field" style={{ gap: 4 }}>
              <span className="field-label">{t(locale, "web.violations.filter.title")}</span>
              <select
                className="select"
                value={titleFilter}
                onChange={(event) => setTitleFilter(event.target.value)}
              >
                <option value="">{t(locale, "web.violations.filter.all")}</option>
                {titleOptions.map(([id, displayTitle]) => (
                  <option key={id} value={id}>
                    {displayTitle}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {groups.map((group) => (
            <section key={group.trackedTitleId} className="v-group" aria-label={group.displayTitle}>
              <div className="v-group-head">
                <h2 className="v-group-title">{group.displayTitle}</h2>
                <span className="v-group-meta">
                  {t(locale, "web.violations.group.openOfTotal")
                    .replace("{open}", String(group.open))
                    .replace("{total}", String(group.total))}
                </span>
              </div>
              {group.rows.map((row) => {
                const open = row.violation.lifecycle.state === "open";
                const picked = selected.has(row.violation.id);
                return (
                  <div
                    key={row.violation.id}
                    className={[
                      "violation",
                      picked ? "is-picked" : "",
                      open ? "" : "is-removed",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {open && (
                      <input
                        type="checkbox"
                        className="check"
                        checked={picked}
                        onChange={() => toggle(row)}
                        aria-label={row.violation.url}
                      />
                    )}
                    <div className="violation-main">
                      <a className="url v-title" href={row.violation.url} target="_blank" rel="noreferrer">
                        {row.violation.url}
                      </a>
                      <span className="v-host">
                        <Icon name="link" size="sm" />
                        {row.violation.host}
                      </span>
                    </div>
                    <span className="v-evidence">
                      {row.newestEvidence === undefined ? (
                        t(locale, "web.violations.evidence.none")
                      ) : (
                        <code>{row.newestEvidence.id.slice(0, 8)}</code>
                      )}
                    </span>
                    <span className="v-status">
                      <Chip tone={open ? "danger" : row.violation.lifecycle.state === "removed" ? "green" : "muted"} dot={open}>
                        {t(locale, STATUS_KEYS[row.violation.lifecycle.state])}
                      </Chip>
                    </span>
                  </div>
                );
              })}
            </section>
          ))}
        </>
      )}
      {selected.size > 0 && (
        <footer className="cart">
          <span className="cart-count">
            <b aria-hidden="true">{selected.size}</b>
            {t(locale, "web.violations.cart.count").replace(
              "{count}",
              String(selected.size),
            )}
          </span>
          <select
            className="select"
            value={profileId}
            aria-label={t(locale, "web.violations.cart.recipient")}
            onChange={(event) => setProfileId(event.target.value)}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {t(locale, `web.notices.recipient.${profile.recipient}` as never)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={drafting || profileId === ""}
            onClick={() => void draftNotice()}
          >
            {drafting ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" size="sm" />}
            <span>{t(locale, "web.violations.cart.draft")}</span>
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
            {t(locale, "web.violations.cart.clear")}
          </button>
          {draftError !== null && (
            <p className="cart-error" role="alert">
              {draftError}
            </p>
          )}
        </footer>
      )}
    </main>
  );
}
