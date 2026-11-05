import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { t } from "@patrol/i18n";
import { api } from "../../lib/api/client";
import { fetchSessionCsrfToken } from "../../lib/api/auth";
import { useSession } from "../../lib/session";

/**
 * The notice detail (docs/design/dashboard-ui.md "Notices"; slice 6b): the
 * lifecycle stepper, the approval panel with its three attestations, the
 * composed document (statements verbatim, resolved fields, work
 * identification, cited captures), the frozen parties, the handoff pack
 * with its signed artifact downloads and capture flags, and the withdrawal
 * and supersession actions their states allow.
 */

interface Lifecycle {
  state: "draft" | "approved" | "withdrawn" | "superseded";
}

interface Submission {
  packLanguage: string;
  attemptCount: number;
  createdAt: string;
  cancelledAt?: string;
  lifecycle: { state: "pending" | "delivered" | "acknowledged" | "rejected" | "failed" };
}

interface Detail {
  notice: {
    id: string;
    content: {
      recipient: "google" | "bing" | "yandex";
      recipientProfileId: string;
      citedViolations: Array<{
        violationId: string;
        evidence: Array<{ evidenceId: string; capturedAt: string; reason: string }>;
      }>;
      workIdentifications: Array<{
        trackedTitleId: string;
        displayTitle: string;
        releaseYear: number;
        titleType: string;
      }>;
      statements: Array<{ key: string; text: string; templateVersion: string }>;
      resolvedFields: Array<{
        name: string;
        value: string;
        required: boolean;
        maxLength?: number;
      }>;
      templateVersion: string;
    };
    createdBy: string;
    createdAt: string;
    lifecycle: Lifecycle &
      Partial<{
        approvedBy: string;
        approvedAt: string;
        rightsHolder: { legalName: string; country: string; roleMailbox: string };
        signatory: { fullLegalName: string; authorityBasis: string };
        profile: { account: string; version: number };
        withdrawnBy: string;
        withdrawnAt: string;
        supersededBy: string;
        supersededAt: string;
        supersededByNoticeId: string;
      }>;
  };
  status: string;
  citedViolations: Array<{
    violation: { id: string; url: string };
    displayTitle: string;
    releaseYear: number;
    titleType: string;
    evidence: Array<{ id: string; outcome: string; observedAt: string }>;
  }>;
  submission?: Submission;
  packAvailable: boolean;
  template: { version: string; sourceUrls: string[]; stale: boolean };
}

interface Pack {
  submissionId: string;
  packRef: string;
  packSha256: string;
  generatedAt: string;
  packLanguage: string;
  formUrl?: string;
  artifacts: Array<{
    kind: string;
    fileName: string;
    contentType: string;
    byteSize: number;
    downloadUrl: string;
  }>;
  captureFlags: Array<{
    violationId: string;
    url: string;
    newestEvidenceId: string;
    newestOutcome: string;
    earlierLiveEvidenceId?: string;
  }>;
}

/** One open violation the supersession picker can add to the replacement set. */
interface OpenViolation {
  violation: { id: string; url: string };
  displayTitle: string;
}

export const Route = createFileRoute("/notices/$noticeId")({
  component: NoticeDetail,
});

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

/** The stepper's forward rail; a withdrawn or superseded notice leaves it. */
const STEPS = ["draft", "approved", "delivered", "acknowledged"] as const;
type Step = (typeof STEPS)[number] | "rejected" | "failed" | "withdrawn" | "superseded";

/** The steps the stepper renders for the notice's derived status. */
function renderSteps(current: Step): Step[] {
  const rail: Step[] = [...STEPS];
  if (current === "rejected" || current === "failed") {
    rail.push(current);
  }
  return rail;
}

function NoticeDetail() {
  const { locale } = useSession();
  const noticeId = Route.useParams({ select: (params) => params.noticeId });
  const [detail, setDetail] = useState<Detail | null>(null);
  const [pack, setPack] = useState<Pack | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The approval panel's three attestations; the contract takes literal
  // true, so the submit stays disabled until every box is ticked.
  const [attestations, setAttestations] = useState({ reviewed: false, current: false, authorized: false });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [withdrawalReason, setWithdrawalReason] = useState("");
  const [kept, setKept] = useState<Set<string> | null>(null);
  const [addable, setAddable] = useState<OpenViolation[] | null>(null);

  const load = useCallback(async () => {
    const { data, response } = await api.GET("/notices/{noticeId}", {
      params: { path: { noticeId } },
    });
    if (response.ok && data) {
      setDetail(data as Detail);
      setError(null);
      setKept(
        new Set(
          (data as Detail).notice.content.citedViolations.map((citation) => citation.violationId),
        ),
      );
      // The submission's arrival is the moment the pack can be read: the
      // API builds the pack's bytes lazily on the pack read itself (the
      // topology grants the object store to the API alone), so the fetch
      // asks for the pack once the submission stands rather than waiting
      // for a packAvailable flag that this same fetch is what raises.
      if ((data as Detail).submission !== undefined) {
        const packResponse = await api.GET("/notices/{noticeId}/pack", {
          params: { path: { noticeId } },
        });
        if (packResponse.response.ok && packResponse.data) {
          setPack(packResponse.data as Pack);
        } else {
          setPack(null);
        }
      } else {
        setPack(null);
      }
    } else {
      setError(t(locale, "web.common.error"));
    }
  }, [locale, noticeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const status = (key: string): string => {
    const message = STATUS_KEYS[key];
    return message === undefined ? key : t(locale, message as never);
  };

  const act = async (run: (csrfToken: string) => Promise<boolean>) => {
    setBusy(true);
    setActionError(null);
    try {
      const csrfToken = await fetchSessionCsrfToken();
      if (csrfToken === null) {
        setActionError(t(locale, "errors.unauthenticated"));
        return;
      }
      await run(csrfToken);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const approve = () =>
    act(async (csrfToken) => {
      const { data, response } = await api.POST("/notices/{noticeId}/approval", {
        params: { path: { noticeId }, header: { "X-Patrol-CSRF": csrfToken } },
        body: {
          statementVersion: detail!.template.version,
          attestation: {
            reviewedViolations: true,
            currentStatements: true,
            authorizedSignatory: true,
          },
        },
      });
      if (response.ok) {
        return true;
      }
      setActionError(actionMessage(locale, (data as { code?: string } | undefined)?.code));
      return false;
    });

  const withdraw = () =>
    act(async (csrfToken) => {
      const { data, response } = await api.POST("/notices/{noticeId}/withdrawal", {
        params: { path: { noticeId }, header: { "X-Patrol-CSRF": csrfToken } },
        body: withdrawalReason.trim() === "" ? {} : { reason: withdrawalReason.trim() },
      });
      if (response.ok) {
        return true;
      }
      setActionError(actionMessage(locale, (data as { code?: string } | undefined)?.code));
      return false;
    });

  // The open violations the picker can add to the replacement set — the
  // same listing the violations screen's cart selects from, minus the ones
  // this notice already cites (those are the checkboxes above). Loaded only
  // while the supersession panel is shown.
  const loadAddable = useCallback(async (cited: ReadonlySet<string>) => {
    const { data, response } = await api.GET("/violations", {
      params: { query: { state: "open" as const, pageSize: 200 } },
    });
    if (response.ok && data) {
      setAddable(
        (data.items as OpenViolation[]).filter(
          (row) => !cited.has(row.violation.id),
        ),
      );
    } else {
      setAddable([]);
    }
  }, []);

  useEffect(() => {
    if (detail !== null && detail.notice.lifecycle.state === "approved") {
      const cited = new Set(
        detail.notice.content.citedViolations.map((citation) => citation.violationId),
      );
      void loadAddable(cited);
    }
  }, [detail, loadAddable]);

  const supersede = () =>
    act(async (csrfToken) => {
      const { data, response } = await api.POST("/notices/{noticeId}/supersession", {
        params: { path: { noticeId }, header: { "X-Patrol-CSRF": csrfToken } },
        body: { citedViolationIds: [...(kept ?? new Set<string>())] },
      });
      if (response.ok) {
        return true;
      }
      const code = (data as { code?: string } | undefined)?.code;
      if (code === "violation_reserved") {
        // The cart's own fallback, reused: the conflict names the reserved
        // violations, the picker deselects them and says so, and the
        // operator re-submits the rest.
        const conflicting =
          (data as { conflictingViolationIds?: string[] }).conflictingViolationIds ?? [];
        setKept((current) => {
          const next = new Set(current ?? new Set<string>());
          for (const id of conflicting) {
            next.delete(id);
          }
          return next;
        });
        const urlOf = (id: string): string =>
          addable?.find((row) => row.violation.id === id)?.violation.url ??
          detail?.citedViolations.find((citation) => citation.violation.id === id)?.violation.url ??
          id.slice(0, 8);
        setActionError(
          t(locale, "web.violations.cart.reserved").replace(
            "{urls}",
            conflicting.map(urlOf).join(", "),
          ),
        );
        return false;
      }
      setActionError(actionMessage(locale, code));
      return false;
    });

  if (detail === null) {
    return (
      <main>
        <h1>{t(locale, "web.notices.detail.title")}</h1>
        {error !== null ? <p role="alert">{error}</p> : <p>{t(locale, "web.common.loading")}</p>}
      </main>
    );
  }

  const lifecycle = detail.notice.lifecycle;
  const submission = detail.submission;
  const terminal = lifecycle.state === "withdrawn" || lifecycle.state === "superseded";
  const canWithdraw =
    lifecycle.state === "draft" ||
    (lifecycle.state === "approved" &&
      (submission === undefined ||
        (submission.lifecycle.state === "pending" && submission.cancelledAt === undefined)));
  const canSupersede = lifecycle.state === "approved";
  const attestationsReady = attestations.reviewed && attestations.current && attestations.authorized;
  // The server's own derivation (NoticeStatus): an approved notice renders
  // its submission's state once one has moved it past pending. The client
  // never re-derives it — it reads the status the detail already carries.
  const currentStep = detail.status as Step;

  return (
    <main>
      <p>
        <Link to="/notices">{t(locale, "web.notices.detail.back")}</Link>
      </p>
      <h1>
        {t(locale, RECIPIENT_KEYS[detail.notice.content.recipient] as never)}{" "}
        <small>
          {t(locale, "web.notices.detail.approvedAt").replace(
            "{date}",
            lifecycle.approvedAt === undefined ? "—" : lifecycle.approvedAt.slice(0, 10),
          )}
        </small>
      </h1>

      {/* The stepper: Draft → Approved → Delivered → Acknowledged, with the
          notice's derived status marking the reached step. A withdrawn or
          superseded notice renders its terminal chip instead. */}
      <ol aria-label="lifecycle" style={{ display: "flex", gap: "0.5rem", listStyle: "none", padding: 0 }}>
        {terminal
          ? [lifecycle.state].map((step) => (
              <li key={step}>
                <strong>{status(step)}</strong>
              </li>
            ))
          : renderSteps(currentStep).map((step) => (
              <li
                key={step}
                style={{
                  fontWeight: step === currentStep ? "bold" : "normal",
                  opacity:
                    (STEPS as readonly string[]).includes(step) &&
                    step !== currentStep &&
                    (STEPS as readonly string[]).indexOf(currentStep) >
                      (STEPS as readonly string[]).indexOf(step)
                      ? 0.5
                      : 1,
                }}
              >
                {step === currentStep ? `▸ ${status(step)}` : status(step)}
              </li>
            ))}
      </ol>

      {lifecycle.state === "draft" && (
        <section>
          <h2>{t(locale, "web.notices.detail.approve.title")}</h2>
          <p>
            {t(locale, "web.notices.detail.approve.template")}: <code>{detail.template.version}</code>{" "}
            {detail.template.stale ? (
              <small>({t(locale, "web.notices.detail.approve.stale")})</small>
            ) : null}
          </p>
          {(
            [
              ["reviewed", "web.notices.detail.approve.attestation.reviewed"],
              ["current", "web.notices.detail.approve.attestation.currentStatements"],
              ["authorized", "web.notices.detail.approve.attestation.authorizedSignatory"],
            ] as const
          ).map(([key, message]) => (
            <label key={key} style={{ display: "block" }}>
              <input
                type="checkbox"
                checked={attestations[key]}
                onChange={(event) =>
                  setAttestations((current) => ({ ...current, [key]: event.target.checked }))
                }
              />{" "}
              {t(locale, message)}
            </label>
          ))}
          <button type="button" disabled={busy || !attestationsReady} onClick={() => void approve()}>
            {t(locale, "web.notices.approve")}
          </button>
        </section>
      )}

      {detail.notice.lifecycle.state === "approved" && submission !== undefined && (
        <section>
          <h2>{t(locale, "web.notices.detail.submission.title")}</h2>
          <p>
            {status(submission.lifecycle.state)} ·{" "}
            {t(locale, "web.notices.detail.submission.language").replace(
              "{language}",
              submission.packLanguage,
            )}
            {submission.cancelledAt !== undefined
              ? ` · ${t(locale, "web.notices.detail.submission.cancelled")}`
              : ""}
          </p>
        </section>
      )}

      <section>
        <h2>{t(locale, "web.notices.detail.document.title")}</h2>
        <h3>{t(locale, "web.notices.detail.document.statements")}</h3>
        <ol>
          {detail.notice.content.statements.map((statement) => (
            <li key={statement.key}>
              <p>{statement.text}</p>
            </li>
          ))}
        </ol>
        <h3>{t(locale, "web.notices.detail.document.fields")}</h3>
        <table>
          <thead>
            <tr>
              <th scope="col">{t(locale, "web.notices.detail.document.field")}</th>
              <th scope="col">{t(locale, "web.notices.detail.document.value")}</th>
              <th scope="col">{t(locale, "web.notices.detail.document.required")}</th>
            </tr>
          </thead>
          <tbody>
            {detail.notice.content.resolvedFields.map((field) => (
              <tr key={field.name}>
                <td>
                  <code>{field.name}</code>
                </td>
                <td>{field.value}</td>
                <td>{field.required ? t(locale, "web.notices.detail.document.yes") : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>{t(locale, "web.notices.detail.document.works")}</h3>
        <ul>
          {detail.notice.content.workIdentifications.map((work) => (
            <li key={work.trackedTitleId}>
              {work.displayTitle} ({work.releaseYear}, {work.titleType})
            </li>
          ))}
        </ul>
        <h3>{t(locale, "web.notices.detail.document.citations")}</h3>
        <table>
          <thead>
            <tr>
              <th scope="col">{t(locale, "web.notices.detail.document.citations.work")}</th>
              <th scope="col">{t(locale, "web.notices.detail.document.citations.url")}</th>
              <th scope="col">{t(locale, "web.notices.detail.document.citations.evidence")}</th>
            </tr>
          </thead>
          <tbody>
            {detail.citedViolations.map((citation) => (
              <tr key={citation.violation.id}>
                <td>{citation.displayTitle}</td>
                <td>
                  <a href={citation.violation.url} target="_blank" rel="noreferrer">
                    {citation.violation.url}
                  </a>
                </td>
                <td>
                  {citation.evidence.map((evidence) => (
                    <code key={evidence.id}>{evidence.id.slice(0, 8)}</code>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {lifecycle.approvedAt !== undefined && (
        <section>
          <h2>{t(locale, "web.notices.detail.snapshots.title")}</h2>
          <dl>
            <dt>{t(locale, "web.notices.detail.snapshots.rightsHolder")}</dt>
            <dd>
              {lifecycle.rightsHolder?.legalName} ({lifecycle.rightsHolder?.country}) ·{" "}
              {lifecycle.rightsHolder?.roleMailbox}
            </dd>
            <dt>{t(locale, "web.notices.detail.snapshots.signatory")}</dt>
            <dd>
              {lifecycle.signatory?.fullLegalName} — {lifecycle.signatory?.authorityBasis}
            </dd>
            <dt>{t(locale, "web.notices.detail.snapshots.profile")}</dt>
            <dd>
              {lifecycle.profile?.account} (v{lifecycle.profile?.version})
            </dd>
          </dl>
        </section>
      )}

      {pack !== null && (
        <section>
          <h2>{t(locale, "web.notices.detail.pack.title")}</h2>
          <p>
            {t(locale, "web.notices.detail.pack.language").replace("{language}", pack.packLanguage)} ·{" "}
            <code>{pack.packSha256.slice(0, 12)}</code>
          </p>
          {pack.formUrl !== undefined && (
            <p>
              <a href={pack.formUrl} target="_blank" rel="noreferrer">
                {t(locale, "web.notices.detail.pack.formUrl")}
              </a>
            </p>
          )}
          <ul>
            {pack.artifacts.map((artifact) => (
              <li key={artifact.fileName}>
                <a href={artifact.downloadUrl} target="_blank" rel="noreferrer">
                  {t(locale, "web.notices.detail.pack.download")} {artifact.fileName}
                </a>{" "}
                <small>{artifact.byteSize} B</small>
              </li>
            ))}
          </ul>
          {pack.captureFlags.some(
            (flag) => flag.newestOutcome === "dead" || flag.newestOutcome === "blocked",
          ) && (
            <>
              <h3>{t(locale, "web.notices.detail.pack.flags")}</h3>
              <ul>
                {pack.captureFlags
                  .filter((flag) => flag.newestOutcome === "dead" || flag.newestOutcome === "blocked")
                  .map((flag) => (
                    <li key={flag.violationId}>
                      {t(locale, `web.notices.detail.pack.flag.${flag.newestOutcome}` as never)}{" "}
                      <a href={flag.url} target="_blank" rel="noreferrer">
                        {flag.url}
                      </a>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </section>
      )}

      {(canWithdraw || canSupersede) && (
        <section>
          <h2>{t(locale, "web.notices.detail.actions.title")}</h2>
          {canWithdraw && (
            <>
              <label>
                {t(locale, "web.notices.detail.withdraw.reason")}
                <input
                  value={withdrawalReason}
                  onChange={(event) => setWithdrawalReason(event.target.value)}
                />
              </label>{" "}
              <button type="button" disabled={busy} onClick={() => void withdraw()}>
                {t(locale, "web.notices.detail.withdraw.submit")}
              </button>
            </>
          )}
          {canSupersede && (
            <div>
              <h3>{t(locale, "web.notices.detail.supersede.title")}</h3>
              <p>{t(locale, "web.notices.detail.supersede.hint")}</p>
              {detail.citedViolations.map((citation) => (
                <label key={citation.violation.id} style={{ display: "block" }}>
                  <input
                    type="checkbox"
                    checked={kept?.has(citation.violation.id) ?? false}
                    onChange={(event) =>
                      setKept((current) => {
                        const next = new Set(current ?? new Set<string>());
                        if (event.target.checked) {
                          next.add(citation.violation.id);
                        } else {
                          next.delete(citation.violation.id);
                        }
                        return next;
                      })
                    }
                  />{" "}
                  {citation.violation.url} <small>({citation.displayTitle})</small>
                </label>
              ))}
              {addable !== null && addable.length > 0 && (
                <>
                  <h4>{t(locale, "web.notices.detail.supersede.add.title")}</h4>
                  {addable.map((row) => (
                    <label key={row.violation.id} style={{ display: "block" }}>
                      <input
                        type="checkbox"
                        checked={kept?.has(row.violation.id) ?? false}
                        onChange={(event) =>
                          setKept((current) => {
                            const next = new Set(current ?? new Set<string>());
                            if (event.target.checked) {
                              next.add(row.violation.id);
                            } else {
                              next.delete(row.violation.id);
                            }
                            return next;
                          })
                        }
                      />{" "}
                      {row.violation.url} <small>({row.displayTitle})</small>
                    </label>
                  ))}
                </>
              )}
              <button type="button" disabled={busy || (kept?.size ?? 0) === 0} onClick={() => void supersede()}>
                {t(locale, "web.notices.detail.supersede.submit")}
              </button>
            </div>
          )}
          {actionError !== null && (
            <p role="alert" style={{ marginTop: "0.5rem" }}>
              {actionError}
            </p>
          )}
        </section>
      )}
    </main>
  );
}

/** Maps an action failure's code onto its catalogue line. */
function actionMessage(locale: "en" | "ru", code: string | undefined): string {
  switch (code) {
    case "state_conflict":
    case "notice_not_withdrawable":
    case "violation_reserved":
    case "duplicate_entity":
    case "validation_failed":
      return t(locale, `errors.${code}` as never);
    default:
      return t(locale, "web.common.error");
  }
}
