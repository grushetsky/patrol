import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { t, type MessageKey } from "@patrol/i18n";
import { api } from "../../lib/api/client";
import { fetchSessionCsrfToken } from "../../lib/api/auth";
import { useSession } from "../../lib/session";
import { Chip, EmptyState, PageHead, Panel, Skeleton } from "../../components/ui";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/toast";

/**
 * The review queue (docs/design/dashboard-ui.md "Review queue"): dense rows
 * in the server's fixed order — score descending, SERP rank ascending,
 * observation time descending — each carrying everything an operator needs
 * to judge a candidate without opening it: the score with its components,
 * the tracked title and matched variant, the requested and final URL, the
 * source engine and query, the newest capture with a capture-on-demand
 * button, the flags (allowlist, reputation, prior decision, lifecycle
 * state), and the five dispositions. An allowlist hit shows the matching
 * entry and disables Confirm; a row whose newest capture is dead stays with
 * that outcome visible.
 *
 * Every dismissal collects its note inline — the API refuses a noteless
 * dismissal (`note_required`), so the form will not send one. The queue
 * asks for pending pairs; a row that is not pending (defensively, if the
 * list ever answers one) shows its state chip and disables the actions.
 */

type ReviewAction = "not_a_violation" | "wrong_work" | "authorized_here" | "page_dead";

/** The inline dismissal form a row has open, each with its own note. */
type DismissalForm = "dismiss" | "wrong_work" | "authorized_here" | "page_dead";

/** The decision action each dismissal form sends. */
const ACTION_OF_FORM: Record<DismissalForm, ReviewAction> = {
  dismiss: "not_a_violation",
  wrong_work: "wrong_work",
  authorized_here: "authorized_here",
  page_dead: "page_dead",
};

/** The submit label each dismissal form carries. */
const SUBMIT_KEY_OF_FORM: Record<DismissalForm, MessageKey> = {
  dismiss: "web.review.actions.dismiss",
  wrong_work: "web.review.actions.wrongWork",
  authorized_here: "web.review.actions.authorizedHere",
  page_dead: "web.review.actions.pageDead",
};

interface QueueRow {
  id: string;
  trackedTitleId: string;
  displayTitle: string;
  releaseYear: number;
  titleType: "film" | "series" | "miniseries" | "other";
  matchedVariant: { text: string; kind: string; language: string; script: string; territory?: string };
  url: string;
  finalUrl?: string;
  host: string;
  registrableDomain: string;
  source: "serp" | "manual";
  engine?: string;
  rank?: number;
  queryText?: string;
  locale?: string;
  territory?: string;
  score: number;
  scoreComponents: { titleMatch: number; signals: Array<{ kind: string; value: number }>; reputation: number };
  reputation: { confirmedViolations: number; bonus: number };
  allowlistEntry?: { id: string; kind: string; value: string; scope: string };
  priorDecision?: { id: string; action: string; decidedAt: string };
  newestEvidence?: { id: string; outcome: string; observedAt: string };
  lifecycle: { state: string };
}

interface TitleOption {
  id: string;
  displayTitle: string;
  releaseYear: number;
}

const SCORE_BAR_MAX = 1;

export const Route = createFileRoute("/review/")({
  component: ReviewIndex,
});

function ReviewIndex() {
  const { locale } = useSession();
  const toast = useToast();
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [titles, setTitles] = useState<TitleOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    // The queue is the pending set: decided rows leave it, and their
    // lifecycle actions live on the detail and violations surfaces.
    const { data, response } = await api.GET("/candidates", {
      params: { query: { pageSize: 50, state: "pending" } },
    });
    if (response.ok && data) {
      setRows(data.items as QueueRow[]);
      setError(null);
    } else {
      setError(t(locale, "web.common.error"));
    }
  }, [locale]);

  const loadTitles = useCallback(async () => {
    const { data, response } = await api.GET("/titles", {
      params: { query: { pageSize: 200 } },
    });
    if (response.ok && data) {
      setTitles(
        data.items.map((item) => ({
          id: item.id,
          displayTitle: item.displayTitle,
          releaseYear: item.releaseYear,
        })),
      );
    }
  }, []);

  useEffect(() => {
    void load();
    void loadTitles();
  }, [load, loadTitles]);

  const decide = useCallback(
    async (
      row: QueueRow,
      body: {
        action: "violation" | "not_a_violation" | "wrong_work" | "authorized_here" | "page_dead";
        note?: string;
        rematchedTrackedTitleId?: string;
        allowlistEntry?: {
          kind: "official_domain" | "licensed_destination" | "neutral_source";
          matchKind: "host" | "url_prefix";
          value: string;
          scope: "rights_holder" | "title_group" | "tracked_title";
          trackedTitleId?: string;
          territory?: string;
        };
      },
    ): Promise<boolean> => {
      setBusyId(row.id);
      setError(null);
      try {
        const csrfToken = await fetchSessionCsrfToken();
        if (csrfToken === null) {
          setError(t(locale, "errors.unauthenticated"));
          return false;
        }
        const evidenceIds =
          row.newestEvidence !== undefined ? [row.newestEvidence.id] : [];
        const { response, data } = await api.POST(
          "/candidates/{candidateId}/review-decisions",
          {
            params: {
              path: { candidateId: row.id },
              header: { "X-Patrol-CSRF": csrfToken },
            },
            body: { ...body, evidenceIds },
          },
        );
        if (!response.ok) {
          const errorBody = data as { code?: string } | undefined;
          setError(
            errorBody?.code === "evidence_required"
              ? t(locale, "errors.evidence_required")
              : errorBody?.code === "note_required"
                ? t(locale, "errors.note_required")
                : t(locale, "web.common.error"),
          );
          return false;
        }
        // The design's States section: a state-changing action raises a
        // toast confirming the new state.
        toast(t(locale, "web.review.decision.recorded"), "green");
        await load();
        return true;
      } finally {
        setBusyId(null);
      }
    },
    [load, locale, toast],
  );

  const captureNow = useCallback(
    async (row: QueueRow): Promise<void> => {
      setBusyId(row.id);
      setError(null);
      try {
        const csrfToken = await fetchSessionCsrfToken();
        if (csrfToken === null) {
          setError(t(locale, "errors.unauthenticated"));
          return;
        }
        const { response, data } = await api.POST(
          "/candidates/{candidateId}/captures",
          {
            params: {
              path: { candidateId: row.id },
              header: { "X-Patrol-CSRF": csrfToken },
            },
            body: { reason: "review" },
          },
        );
        if (!response.ok) {
          const errorBody = data as { code?: string } | undefined;
          setError(
            errorBody?.code === "allowlist_hit"
              ? t(locale, "errors.allowlist_hit")
              : t(locale, "web.common.error"),
          );
          return;
        }
        toast(t(locale, "web.review.capture.queued"), "blue");
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [load, locale, toast],
  );

  return (
    <main className="page">
      <PageHead
        eyebrow={t(locale, "web.review.eyebrow")}
        title={t(locale, "web.review.title")}
        note={t(locale, "web.review.note")}
      />
      {error !== null && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}
      {rows === null ? (
        <Panel title={t(locale, "web.review.title")}>
          <div aria-busy="true">
            {[0, 1, 2].map((index) => (
              <div key={index} style={{ display: "flex", gap: 12, alignItems: "center", padding: "12px 0" }}>
                <Skeleton variant="score" />
                <Skeleton variant="wide" />
                <Skeleton variant="short" />
              </div>
            ))}
          </div>
        </Panel>
      ) : rows.length === 0 ? (
        <EmptyState
          title={t(locale, "web.review.empty.title")}
          action={
            <Link className="btn btn-primary" to="/catalogue">
              <Icon name="radar" size="sm" />
              <span>{t(locale, "web.review.runScans")}</span>
            </Link>
          }
        >
          {t(locale, "web.review.empty")}
        </EmptyState>
      ) : (
        <Panel title={t(locale, "web.review.title")} actions={<span>{t(locale, "web.review.queue.order")}</span>}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t(locale, "web.review.column.score")}</th>
                  <th scope="col">{t(locale, "web.review.column.title")}</th>
                  <th scope="col">{t(locale, "web.review.column.url")}</th>
                  <th scope="col">{t(locale, "web.review.column.source")}</th>
                  <th scope="col">{t(locale, "web.review.column.evidence")}</th>
                  <th scope="col">{t(locale, "web.review.column.flags")}</th>
                  <th scope="col">{t(locale, "web.review.column.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <QueueRowView
                    key={row.id}
                    row={row}
                    titles={titles}
                    busy={busyId === row.id}
                    onDecide={decide}
                    onCapture={captureNow}
                    locale={locale}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </main>
  );
}

function stateChipKey(state: string): "web.review.state.pending" | "web.review.state.confirmed" | "web.review.state.dismissed" {
  if (state === "confirmed") {
    return "web.review.state.confirmed";
  }
  if (state === "dismissed") {
    return "web.review.state.dismissed";
  }
  return "web.review.state.pending";
}

/** The prototype's score tint: high reads red, mid amber, low muted. */
function scoreLevel(score: number): "high" | "mid" | "low" {
  if (score >= 0.75) {
    return "high";
  }
  if (score >= 0.5) {
    return "mid";
  }
  return "low";
}

function QueueRowView(props: {
  row: QueueRow;
  titles: TitleOption[];
  busy: boolean;
  locale: "en" | "ru";
  onDecide: (
    row: QueueRow,
    body: {
      action: "violation" | "not_a_violation" | "wrong_work" | "authorized_here" | "page_dead";
      note?: string;
      rematchedTrackedTitleId?: string;
      allowlistEntry?: {
        kind: "official_domain" | "licensed_destination" | "neutral_source";
        matchKind: "host" | "url_prefix";
        value: string;
        scope: "rights_holder" | "title_group" | "tracked_title";
        trackedTitleId?: string;
        territory?: string;
      };
    },
  ) => Promise<boolean>;
  onCapture: (row: QueueRow) => Promise<void>;
}) {
  const { row, locale } = props;
  const allowlisted = row.allowlistEntry !== undefined;
  // The queue asks for pending pairs; if a decided row ever answers the
  // list anyway, its actions stay disabled rather than firing a conflict.
  const pending = row.lifecycle.state === "pending";
  const actionable = pending && !props.busy;
  const [form, setForm] = useState<DismissalForm | null>(null);
  const [note, setNote] = useState("");
  const [territory, setTerritory] = useState(row.territory ?? "");
  const [wrongWorkTitle, setWrongWorkTitle] = useState("");

  const sendDismissal = async (): Promise<void> => {
    const trimmed = note.trim();
    if (trimmed === "") {
      return;
    }
    const sent = await props.onDecide(row, {
      action: ACTION_OF_FORM[form!],
      note: trimmed,
      ...(form === "wrong_work"
        ? { rematchedTrackedTitleId: wrongWorkTitle }
        : {}),
      ...(form === "authorized_here"
        ? {
            allowlistEntry: {
              kind: "licensed_destination",
              matchKind: "host",
              value: row.host,
              scope: "tracked_title",
              trackedTitleId: row.trackedTitleId,
              territory: territory.trim().toUpperCase(),
            },
          }
        : {}),
    });
    if (sent) {
      setForm(null);
      setNote("");
    }
  };

  return (
    <tr>
      <td>
        <div className="score">
          <span className="score-num" data-level={scoreLevel(row.score)}>
            {row.score.toFixed(2)}
          </span>
          <div
            className="score-track"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={SCORE_BAR_MAX}
            aria-valuenow={row.score}
          >
            <div className="score-fill" style={{ width: `${row.score * 100}%` }} />
          </div>
          <small className="score-formula">
            {t(locale, "web.review.score.titleMatch")} {row.scoreComponents.titleMatch.toFixed(2)}
            {row.scoreComponents.signals.length > 0 && (
              <>
                {" · "}
                {t(locale, "web.review.score.signals")}:{" "}
                {row.scoreComponents.signals
                  .map((signal) => `${signal.kind} +${signal.value.toFixed(2)}`)
                  .join(", ")}
              </>
            )}
            {row.scoreComponents.reputation > 0 && (
              <>
                {" · "}
                {t(locale, "web.review.score.reputation")}{" "}
                {row.scoreComponents.reputation.toFixed(2)}
              </>
            )}
          </small>
        </div>
      </td>
      <td>
        <h3 className="rv-title">
          {row.displayTitle} <span className="muted">({row.releaseYear})</span>
        </h3>
        <span className="sub">
          {t(locale, "web.review.title.variant")}: {row.matchedVariant.text} ·{" "}
          {row.matchedVariant.kind} · {row.matchedVariant.language} ·{" "}
          {row.matchedVariant.script}
          {row.matchedVariant.territory !== undefined && ` · ${row.matchedVariant.territory}`}
        </span>
      </td>
      <td>
        <a className="url" href={row.url} target="_blank" rel="noreferrer">
          {row.url}
        </a>
        {row.finalUrl !== undefined && row.finalUrl !== row.url && (
          <span className="sub">
            {t(locale, "web.review.url.final")}: {row.finalUrl}
          </span>
        )}
        <span className="sub">
          {row.host} · {t(locale, "web.review.url.registrableDomain")} {row.registrableDomain}
        </span>
      </td>
      <td>
        {row.source === "manual" ? (
          t(locale, "web.review.source.manual")
        ) : (
          <>
            {row.engine}
            {row.rank !== undefined && ` · ${t(locale, "web.review.source.rank")} ${row.rank}`}
            {row.queryText !== undefined && (
              <span className="sub">“{row.queryText}”</span>
            )}
            {row.locale !== undefined && (
              <>
                {" · "}
                {row.locale}
                {row.territory !== undefined && `/${row.territory}`}
              </>
            )}
          </>
        )}
      </td>
      <td>
        {row.newestEvidence === undefined ? (
          <span className="sub">{t(locale, "web.review.evidence.none")}</span>
        ) : (
          <>
            <code>{row.newestEvidence.id.slice(0, 8)}</code>
            <span className="sub">
              {row.newestEvidence.outcome} ·{" "}
              {new Date(row.newestEvidence.observedAt).toISOString().slice(0, 16)}Z
            </span>
          </>
        )}
        {/* An allowlisted URL is never captured; every other row can ask
            for a fresh review capture on demand. */}
        {pending && !allowlisted && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={props.busy}
            onClick={() => void props.onCapture(row)}
          >
            {t(locale, "web.review.capture")}
          </button>
        )}
      </td>
      <td>
        <div className="rv-flags" style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
          {allowlisted ? (
            <Chip tone="locked">
              {t(locale, "web.review.flags.allowlistHit")}: {row.allowlistEntry!.kind} ·{" "}
              {row.allowlistEntry!.value}
            </Chip>
          ) : (
            <Chip>
              {t(locale, "web.review.flags.reputation")}: {row.reputation.confirmedViolations}
            </Chip>
          )}
          {row.priorDecision !== undefined && (
            <Chip tone="muted">
              {t(locale, "web.review.flags.priorDecision")}: {row.priorDecision.action}
            </Chip>
          )}
          <Chip tone={pending ? "blue" : "muted"} dot={pending}>
            {t(locale, stateChipKey(row.lifecycle.state))}
          </Chip>
        </div>
      </td>
      <td>
        {allowlisted ? (
          <small className="muted">{t(locale, "web.review.flags.allowlistPreventsConfirm")}</small>
        ) : (
          <>
            <div className="row-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!actionable}
                onClick={() => void props.onDecide(row, { action: "violation" })}
              >
                <Icon name="check" size="sm" />
                <span>{t(locale, "web.review.actions.confirm")}</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={!actionable}
                onClick={() => {
                  setForm(form === "dismiss" ? null : "dismiss");
                  setNote("");
                }}
              >
                {t(locale, "web.review.actions.dismiss")}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={!actionable}
                onClick={() => {
                  setForm(form === "wrong_work" ? null : "wrong_work");
                  setNote("");
                  setWrongWorkTitle("");
                }}
              >
                {t(locale, "web.review.actions.wrongWork")}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={!actionable}
                onClick={() => {
                  setForm(form === "authorized_here" ? null : "authorized_here");
                  setNote("");
                  setTerritory(row.territory ?? "");
                }}
              >
                {t(locale, "web.review.actions.authorizedHere")}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={!actionable}
                onClick={() => {
                  setForm(
                    form === "page_dead" ? null : "page_dead",
                  );
                  setNote("");
                }}
              >
                {t(locale, "web.review.actions.pageDead")}
              </button>
            </div>
            {form !== null && (
              <div className="inline-form" style={{ marginTop: 8 }}>
                <label className="field" style={{ gap: 4 }}>
                  <span className="field-label">{t(locale, "web.review.actions.note")}</span>
                  <input
                    className="input"
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder={t(locale, "web.review.actions.notePlaceholder")}
                  />
                </label>
                {form === "wrong_work" && (
                  <label className="field" style={{ gap: 4 }}>
                    <span className="field-label">{t(locale, "web.review.actions.wrongWork.titlePicker")}</span>
                    <select
                      className="select"
                      value={wrongWorkTitle}
                      onChange={(event) => setWrongWorkTitle(event.target.value)}
                    >
                      <option value="">
                        {t(locale, "web.review.actions.wrongWork.pickTitle")}
                      </option>
                      {props.titles
                        .filter((title) => title.id !== row.trackedTitleId)
                        .map((title) => (
                          <option key={title.id} value={title.id}>
                            {title.displayTitle} ({title.releaseYear})
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                {form === "authorized_here" && (
                  // The entry's territory is a two-letter country code the
                  // operator must name — the schema's CHECK is [A-Z]{2}
                  // with no worldwide representation, so there is no
                  // fallback to invent when the observation carried none.
                  <label className="field" style={{ gap: 4 }}>
                    <span className="field-label">{t(locale, "web.settings.allowlist.territory")}</span>
                    <input
                      className="input"
                      value={territory}
                      maxLength={2}
                      onChange={(event) => setTerritory(event.target.value.toUpperCase())}
                      placeholder="US"
                    />
                  </label>
                )}
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={
                    props.busy ||
                    note.trim() === "" ||
                    (form === "wrong_work" && wrongWorkTitle === "") ||
                    (form === "authorized_here" && territory.trim().length !== 2)
                  }
                  onClick={() => void sendDismissal()}
                >
                  {t(locale, SUBMIT_KEY_OF_FORM[form!])}
                </button>
              </div>
            )}
          </>
        )}
      </td>
    </tr>
  );
}
