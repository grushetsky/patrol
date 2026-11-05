import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { t } from "@patrol/i18n";
import { api } from "../../lib/api/client";
import { fetchSessionCsrfToken } from "../../lib/api/auth";
import { useSession } from "../../lib/session";

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
    <main>
      <h1>{t(locale, "web.violations.title")}</h1>
      {error !== null && <p role="alert">{error}</p>}
      {rows === null ? (
        <p>{t(locale, "web.common.loading")}</p>
      ) : rows.length === 0 ? (
        <p>
          {t(locale, "web.violations.empty")}{" "}
          <Link to="/review">{t(locale, "web.violations.goToReview")}</Link>
        </p>
      ) : (
        <>
          <label>
            {t(locale, "web.violations.filter.title")}
            <select
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
          {groups.map((group) => (
            <section key={group.trackedTitleId}>
              <h2>
                {group.displayTitle}{" "}
                <small>
                  {t(locale, "web.violations.group.openOfTotal")
                    .replace("{open}", String(group.open))
                    .replace("{total}", String(group.total))}
                </small>
              </h2>
              <table>
                <thead>
                  <tr>
                    <th scope="col" aria-label="select" />
                    <th scope="col">{t(locale, "web.violations.column.host")}</th>
                    <th scope="col">{t(locale, "web.violations.column.url")}</th>
                    <th scope="col">{t(locale, "web.violations.column.evidence")}</th>
                    <th scope="col">{t(locale, "web.violations.column.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => {
                    const open = row.violation.lifecycle.state === "open";
                    return (
                      <tr key={row.violation.id}>
                        <td>
                          {open && (
                            <input
                              type="checkbox"
                              checked={selected.has(row.violation.id)}
                              onChange={() => toggle(row)}
                            />
                          )}
                        </td>
                        <td>{row.violation.host}</td>
                        <td>
                          <a
                            href={row.violation.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {row.violation.url}
                          </a>
                        </td>
                        <td>
                          {row.newestEvidence === undefined ? (
                            <small>{t(locale, "web.violations.evidence.none")}</small>
                          ) : (
                            <code>{row.newestEvidence.id.slice(0, 8)}</code>
                          )}
                        </td>
                        <td>{t(locale, STATUS_KEYS[row.violation.lifecycle.state])}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          ))}
        </>
      )}
      {selected.size > 0 && (
        <footer
          style={{
            position: "fixed",
            bottom: 0,
            left: 0,
            right: 0,
            padding: "0.5rem 1rem",
          }}
        >
          <strong>
            {t(locale, "web.violations.cart.count").replace(
              "{count}",
              String(selected.size),
            )}
          </strong>{" "}
          <select
            value={profileId}
            aria-label={t(locale, "web.violations.cart.recipient")}
            onChange={(event) => setProfileId(event.target.value)}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {t(locale, `web.notices.recipient.${profile.recipient}` as never)}
              </option>
            ))}
          </select>{" "}
          <button
            type="button"
            disabled={drafting || profileId === ""}
            onClick={() => void draftNotice()}
          >
            {t(locale, "web.violations.cart.draft")}
          </button>{" "}
          <button type="button" onClick={() => setSelected(new Set())}>
            {t(locale, "web.violations.cart.clear")}
          </button>
          {draftError !== null && (
            <p role="alert" style={{ margin: "0.25rem 0 0" }}>
              {draftError}
            </p>
          )}
        </footer>
      )}
    </main>
  );
}
