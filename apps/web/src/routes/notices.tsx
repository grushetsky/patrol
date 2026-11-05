import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  approveNotice,
  noticeDetailQuery,
  noticePack,
  noticesQuery,
  withdrawNotice,
  type NoticeCard,
} from "../api/admin";
import { errorMessage, setCsrf } from "../api/client";
import { translate, useLanguage, type MessageKey } from "../i18n";
import { useSession } from "../components/session";
import { Badge, Button, Card, EmptyState, Spinner } from "../components/ui";

export const Route = createFileRoute("/notices")({
  component: NoticesPage,
});

const STATUS_TONE = {
  draft: "warning",
  approved: "accent",
  delivered: "success",
  acknowledged: "success",
  rejected: "error",
  failed: "error",
  withdrawn: "neutral",
  superseded: "neutral",
} as const;

function NoticesPage() {
  const language = useLanguage();
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useSession();
  const notices = useQuery(noticesQuery);
  const [selected, setSelected] = useState<NoticeCard | null>(null);
  const [approving, setApproving] = useState(false);
  const [attestation, setAttestation] = useState({
    reviewed: false,
    statements: false,
    authorized: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const t = (key: MessageKey) => translate(language, key);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["notices"] }),
      router.invalidate(),
    ]);
  }

  async function approve() {
    if (!selected || !session) return;
    setBusy(true);
    setError(null);
    try {
      setCsrf(session.csrfToken);
      const detail = await queryClient.fetchQuery(noticeDetailQuery(selected.id));
      await approveNotice(
        selected.id,
        session.csrfToken,
        detail.notice.content.templateVersion,
      );
      setApproving(false);
      setAttestation({ reviewed: false, statements: false, authorized: false });
      setNotice(t("noticesApproved"));
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause, t("authErrorGeneric")));
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(target: NoticeCard) {
    if (!session) return;
    const reason = window.prompt(t("noticesWithdrawReason"));
    if (reason === null) return;
    setBusy(true);
    setError(null);
    try {
      setCsrf(session.csrfToken);
      await withdrawNotice(target.id, session.csrfToken, reason);
      setSelected(null);
      setNotice(t("noticesWithdrawn"));
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause, t("authErrorGeneric")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
          {t("appTitle")} · {t("notices")}
        </p>
        <h1 className="page-title mt-1 text-4xl md:text-5xl">{t("noticesTitle")}</h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">{t("noticesLead")}</p>
      </header>

      {notices.isLoading ? <Card className="p-6"><Spinner label={t("loading")} /></Card> : null}
      {notices.error ? (
        <Card className="p-6 text-sm text-[var(--error)]">
          {errorMessage(notices.error, t("authErrorGeneric"))}
        </Card>
      ) : null}
      {!notices.isLoading && (notices.data?.items.length ?? 0) === 0 ? (
        <Card><EmptyState title={t("noticesEmpty")}>{t("noticesEmptyLead")}</EmptyState></Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {notices.data?.items.map((card) => (
          <Card key={card.id} className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-2xl capitalize">{card.recipient}</h2>
                <p className="mt-1 font-mono text-[11px] text-[var(--muted)]">{card.id}</p>
              </div>
              <Badge tone={STATUS_TONE[card.status as keyof typeof STATUS_TONE] ?? "neutral"}>
                {card.status}
              </Badge>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-2 text-xs text-[var(--muted)]">
              <div>
                <dt>{t("noticesViolations")}</dt>
                <dd className="text-[var(--fg)]">{card.violationCount}</dd>
              </div>
              <div>
                <dt>{t("noticesSignatory")}</dt>
                <dd className="text-[var(--fg)]">{card.signatoryName ?? "—"}</dd>
              </div>
              <div>
                <dt>{t("noticesCreated")}</dt>
                <dd className="text-[var(--fg)]">{new Date(card.createdAt).toLocaleDateString(
                  language === "ru" ? "ru-RU" : "en-US",
                )}</dd>
              </div>
              <div>
                <dt>{t("noticesPack")}</dt>
                <dd className="text-[var(--fg)]">{card.packAvailable ? "✓" : "—"}</dd>
              </div>
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                className="px-3 py-1.5 text-xs"
                onClick={() => {
                  setSelected(card);
                  setApproving(false);
                  setAttestation({ reviewed: false, statements: false, authorized: false });
                  setError(null);
                }}
              >
                {t("noticesPack")}
              </Button>
              {card.status === "draft" ? (
                <Button
                  className="px-3 py-1.5 text-xs"
                  onClick={() => {
                    setSelected(card);
                    setApproving(true);
                    setError(null);
                  }}
                >
                  {t("noticesApprove")}
                </Button>
              ) : null}
              {card.status === "draft" || card.status === "approved" ? (
                <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => void withdraw(card)}>
                  {t("noticesWithdraw")}
                </Button>
              ) : null}
            </div>
          </Card>
        ))}
      </div>

      {selected ? (
        <NoticeDialog
          notice={selected}
          approving={approving}
          attestation={attestation}
          onAttestation={setAttestation}
          busy={busy}
          error={error}
          onClose={() => {
            setSelected(null);
            setApproving(false);
            setAttestation({ reviewed: false, statements: false, authorized: false });
          }}
          onApprove={() => void approve()}
          t={t}
          language={language}
        />
      ) : null}

      {notice ? (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg)] px-4 py-2 text-sm shadow-[var(--glass-shadow)] backdrop-blur-xl">
          {notice}
        </div>
      ) : null}
    </div>
  );
}

function NoticeDialog({
  notice,
  approving,
  attestation,
  onAttestation,
  busy,
  error,
  onClose,
  onApprove,
  t,
  language,
}: {
  notice: NoticeCard;
  approving: boolean;
  attestation: { reviewed: boolean; statements: boolean; authorized: boolean };
  onAttestation: (value: { reviewed: boolean; statements: boolean; authorized: boolean }) => void;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onApprove: () => void;
  t: (key: MessageKey) => string;
  language: "en" | "ru";
}) {
  const detail = useQuery(noticeDetailQuery(notice.id));
  const [pack, setPack] = useState<Awaited<ReturnType<typeof noticePack>> | null>(null);
  const [packError, setPackError] = useState<string | null>(null);

  async function loadPack() {
    try {
      setPack(await noticePack(notice.id));
    } catch (cause) {
      setPackError(errorMessage(cause, t("authErrorGeneric")));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={t("noticesAttestTitle")}>
      <Card className="max-h-[88vh] w-full max-w-3xl overflow-auto p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="auth-title text-2xl capitalize">{notice.recipient} · {notice.status}</h2>
            <p className="mt-1 font-mono text-[11px] text-[var(--muted)]">{notice.id}</p>
          </div>
          <Button variant="ghost" onClick={onClose}>{t("reviewClose")}</Button>
        </div>

        {detail.isLoading ? <Spinner label={t("loading")} /> : null}
        {detail.error ? <p className="mt-3 text-sm text-[var(--error)]">{errorMessage(detail.error, t("authErrorGeneric"))}</p> : null}
        {detail.data ? (
          <div className="mt-4 space-y-3 text-sm">
            <p>{t("noticesTemplate")}: <span className="font-mono text-xs">{detail.data.notice.content.templateVersion}</span></p>
            {detail.data.template.stale ? <Badge tone="warning">{t("noticesStale")}</Badge> : null}
            <div>
              <h3 className="font-semibold">{t("noticesViolations")}</h3>
              <ul className="mt-1 space-y-1 text-xs text-[var(--muted)]">
                {detail.data.citedViolations.map((citation) => (
                  <li key={citation.violation.id} className="break-all">
                    {citation.violation.host} · {citation.violation.url}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => void loadPack()} disabled={!detail.data.packAvailable}>
                {t("noticesPack")}
              </Button>
              {approving ? (
                <Button
                onClick={onApprove}
                disabled={
                  busy ||
                  !attestation.reviewed ||
                  !attestation.statements ||
                  !attestation.authorized
                }
              >
                {t("noticesApproveConfirm")}
              </Button>
              ) : null}
            </div>
            {pack ? (
              <div className="glass-inset p-3">
                <h3 className="text-sm font-semibold">{t("noticesPackFiles")}</h3>
                <ul className="mt-2 space-y-1 text-xs">
                  {pack.artifacts.map((artifact) => (
                    <li key={artifact.kind}>
                      <a href={artifact.downloadUrl} className="text-[var(--accent)] hover:underline" target="_blank" rel="noreferrer">
                        {artifact.fileName}
                      </a>{" "}
                      <span className="text-[var(--muted)]">{artifact.byteSize} B</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {packError ? <p className="text-sm text-[var(--error)]">{packError}</p> : null}
            {approving ? (
              <div className="space-y-2 text-xs">
                <p>{t("noticesAttestLead")}</p>
                {[
                  ["reviewed", "noticesReviewed"],
                  ["statements", "noticesStatements"],
                  ["authorized", "noticesAuthorized"],
                ].map(([key, label]) => (
                  <label key={key} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={attestation[key as keyof typeof attestation]}
                      onChange={(event) =>
                        onAttestation({ ...attestation, [key]: event.target.checked })
                      }
                    />
                    <span>{t(label as MessageKey)}</span>
                  </label>
                ))}
              </div>
            ) : null}
            {error ? <p className="text-sm text-[var(--error)]">{error}</p> : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
