import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  candidatesQuery,
  decideCandidate,
  type CandidateReviewRow,
  type ReviewDecisionAction,
} from "../api/screens";
import { errorMessage, setCsrf } from "../api/client";
import { translate, useLanguage, type MessageKey } from "../i18n";
import { useSession } from "../components/session";
import { EvidenceDialog } from "../components/evidence-dialog";
import { Badge, Button, Card, EmptyState, Spinner, cn } from "../components/ui";

export const Route = createFileRoute("/review")({
  component: ReviewPage,
});

const REVIEW_ACTIONS: Array<{ action: ReviewDecisionAction; key: MessageKey }> = [
  { action: "violation", key: "reviewConfirm" },
  { action: "not_a_violation", key: "reviewDismiss" },
  { action: "page_dead", key: "reviewPageDead" },
];

function ReviewPage() {
  const language = useLanguage();
  const router = useRouter();
  const queryClient = useQueryClient();
  const candidates = useQuery(candidatesQuery);
  const session = useSession();
  const [density, setDensity] = useState<"rows" | "cards">("rows");
  const [selected, setSelected] = useState<CandidateReviewRow | null>(null);
  const [action, setAction] = useState<ReviewDecisionAction>("violation");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const t = (key: MessageKey) => translate(language, key);

  async function recordDecision() {
    if (!selected) return;
    const evidenceIds = selected.newestEvidence ? [selected.newestEvidence.id] : [];
    if (evidenceIds.length === 0) return;
    if (action === "violation" && selected.allowlistEntry) {
      setError(t("reviewAllowlisted"));
      return;
    }
    if (action === "not_a_violation" && note.trim().length === 0) {
      setError(t("reviewNoteRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const csrf = session?.csrfToken;
      if (!csrf) throw new Error("missing csrf");
      setCsrf(csrf);
      await decideCandidate(selected.id, csrf, {
        action,
        evidenceIds,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setSelected(null);
      setNote("");
      setNotice(t("reviewRecorded"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["candidates"] }),
        router.invalidate(),
      ]);
    } catch (cause) {
      setError(errorMessage(cause, t("authErrorGeneric")));
    } finally {
      setBusy(false);
    }
  }

  const rows = candidates.data?.items ?? [];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
            {t("appTitle")} · {t("review")}
          </p>
          <h1 className="page-title mt-1 text-4xl md:text-5xl">{t("reviewTitle")}</h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">{t("reviewLead")}</p>
        </div>
        <div className="flex rounded-[14px] border border-[var(--glass-border)] bg-[var(--glass-bg)] p-1 text-xs backdrop-blur-xl">
          {(["rows", "cards"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setDensity(mode)}
              className={cn(
                "rounded-[10px] px-3 py-1.5 transition",
                density === mode
                  ? "bg-[var(--surface-raised)] font-medium text-[var(--fg)]"
                  : "text-[var(--muted)] hover:text-[var(--fg)]",
              )}
            >
              {t(mode === "rows" ? "reviewRows" : "reviewCards")}
            </button>
          ))}
        </div>
      </header>

      {candidates.isLoading ? (
        <Card className="p-6">
          <Spinner label={t("loading")} />
        </Card>
      ) : null}
      {candidates.error ? (
        <Card className="p-6 text-sm text-[var(--error)]">
          {errorMessage(candidates.error, t("authErrorGeneric"))}
        </Card>
      ) : null}
      {!candidates.isLoading && rows.length === 0 ? (
        <Card>
          <EmptyState title={t("reviewNoCandidates")}>{t("reviewNoCandidatesLead")}</EmptyState>
        </Card>
      ) : null}

      {rows.length > 0 ? (
        <Card className={cn("overflow-hidden", density === "cards" && "bg-transparent shadow-none") }>
          {density === "rows" ? (
            <div className="divide-y divide-[var(--border)]">
              {rows.map((row) => (
                <CandidateRow
                  key={row.id}
                  row={row}
                  language={language}
                  onDecide={(nextAction) => {
                    setSelected(row);
                    setAction(nextAction);
                    setNote("");
                    setError(null);
                  }}
                  onEvidence={setEvidenceId}
                />
              ))}
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {rows.map((row) => (
                <CandidateCard
                  key={row.id}
                  row={row}
                  language={language}
                  onDecide={(nextAction) => {
                    setSelected(row);
                    setAction(nextAction);
                    setNote("");
                    setError(null);
                  }}
                  onEvidence={setEvidenceId}
                />
              ))}
            </div>
          )}
        </Card>
      ) : null}

      {selected ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={t("reviewDecisionTitle")}
        >
          <Card className="w-full max-w-lg p-6">
            <h2 className="auth-title text-2xl">{t("reviewDecisionTitle")}</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">{selected.displayTitle}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {REVIEW_ACTIONS.map((item) => (
                <Button
                  key={item.action}
                  variant={action === item.action ? "primary" : "secondary"}
                  disabled={item.action === "violation" && Boolean(selected.allowlistEntry)}
                  onClick={() => setAction(item.action)}
                >
                  {t(item.key)}
                </Button>
              ))}
            </div>
            <label className="mt-4 block space-y-1 text-sm">
              <span className="font-medium">{t("reviewNote")}</span>
              <textarea
                className="min-h-24 w-full rounded-[14px] border border-[var(--glass-border)] bg-[rgba(255,255,255,0.05)] px-3 py-2 text-sm outline-none backdrop-blur-xl focus:border-[var(--accent)]"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            {error ? <p className="mt-3 text-sm text-[var(--error)]">{error}</p> : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setSelected(null)} disabled={busy}>
                {t("reviewCancel")}
              </Button>
              <Button
                onClick={() => void recordDecision()}
                disabled={busy || !selected.newestEvidence}
              >
                {busy ? t("loading") : t("reviewSave")}
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {notice ? (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg)] px-4 py-2 text-sm shadow-[var(--glass-shadow)] backdrop-blur-xl">
          {notice}
        </div>
      ) : null}

      {evidenceId ? (
        <EvidenceDialog evidenceId={evidenceId} onClose={() => setEvidenceId(null)} />
      ) : null}
    </div>
  );
}

function CandidateRow({
  row,
  language,
  onDecide,
  onEvidence,
}: {
  row: CandidateReviewRow;
  language: "en" | "ru";
  onDecide: (action: ReviewDecisionAction) => void;
  onEvidence: (id: string | null) => void;
}) {
  const t = (key: MessageKey) => translate(language, key);
  const blocked = Boolean(row.allowlistEntry);
  return (
    <div className="grid gap-4 px-5 py-4 md:grid-cols-[80px_1fr_auto] md:items-start">
      <Score score={row.score} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="font-display text-2xl">{row.displayTitle}</h2>
          <span className="text-sm text-[var(--muted)]">{row.releaseYear}</span>
          <Badge tone="neutral">{row.titleType}</Badge>
          {row.allowlistEntry ? <Badge tone="warning">{t("reviewAllowlisted")}</Badge> : null}
        </div>
        <p className="mt-1 break-all text-sm text-[var(--accent)]">{row.url}</p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted)]">
          <span>{row.host}</span>
          <span>{row.registrableDomain}</span>
          <span>{row.engine ?? row.source}{row.rank ? ` · #${row.rank}` : ""}</span>
          <span>{row.locale ?? "—"}{row.territory ? ` / ${row.territory}` : ""}</span>
          <span>
            {row.matchedVariant.kind} · {row.matchedVariant.language}/{row.matchedVariant.script}
            {row.matchedVariant.territory ? ` · ${row.matchedVariant.territory}` : ""}
          </span>
          {row.finalUrl && row.finalUrl !== row.url ? (
            <span className="break-all">→ {row.finalUrl}</span>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--muted)]">
          <span>
            {t("reviewScore")}: {(row.scoreComponents.titleMatch ?? 0).toFixed(2)} +{" "}
            {row.scoreComponents.signals?.length ?? 0} signals +{" "}
            {(row.scoreComponents.reputation ?? 0).toFixed(2)}
          </span>
          <span>
            {t("reviewHostReputation")}: {row.reputation.confirmedViolations ?? 0} · +
            {(row.reputation.bonus ?? 0).toFixed(2)}
          </span>
          {row.allowlistEntry ? (
            <span>
              {t("reviewAllowlisted")}: {row.allowlistEntry.value} ({row.allowlistEntry.kind})
            </span>
          ) : null}
          {row.priorDecision ? (
            <span>
              {t("reviewPriorDecision")}: {row.priorDecision.action}
            </span>
          ) : null}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            className="px-3 py-1.5 text-xs"
            disabled={blocked || !row.newestEvidence}
            onClick={() => onDecide("violation")}
          >
            {t("reviewConfirm")}
          </Button>
          <Button
            variant="ghost"
            className="px-3 py-1.5 text-xs"
            disabled={!row.newestEvidence}
            onClick={() => onDecide("not_a_violation")}
          >
            {t("reviewDismiss")}
          </Button>
          <Button
            variant="ghost"
            className="px-3 py-1.5 text-xs"
            disabled={!row.newestEvidence}
            onClick={() => onDecide("page_dead")}
          >
            {t("reviewPageDead")}
          </Button>
          {row.newestEvidence ? (
            <Button
              variant="ghost"
              className="px-3 py-1.5 text-xs"
              onClick={() => onEvidence(row.newestEvidence?.id ?? null)}
            >
              {t("reviewEvidence")}
            </Button>
          ) : (
            <Badge tone="neutral">{t("reviewNoEvidence")}</Badge>
          )}
        </div>
      </div>
      <div className="text-right text-xs text-[var(--muted)]">
        {row.newestEvidence ? (
          <div>
            <div className="font-mono text-[10px]">{row.newestEvidence.id.slice(0, 8)}</div>
            <div>
              {new Date(row.newestEvidence.observedAt).toLocaleDateString(
                language === "ru" ? "ru-RU" : "en-US",
              )}
            </div>
            <div>{row.newestEvidence.outcome}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CandidateCard({
  row,
  language,
  onDecide,
  onEvidence,
}: {
  row: CandidateReviewRow;
  language: "en" | "ru";
  onDecide: (action: ReviewDecisionAction) => void;
  onEvidence: (id: string | null) => void;
}) {
  const t = (key: MessageKey) => translate(language, key);
  return (
    <Card className="glass-red p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-2xl">{row.displayTitle}</h2>
          <p className="text-sm text-[var(--muted)]">{row.releaseYear} · {row.titleType}</p>
        </div>
        <Score score={row.score} />
      </div>
      <p className="mt-3 break-all text-sm text-[var(--accent)]">{row.url}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {row.allowlistEntry ? <Badge tone="warning">{t("reviewAllowlisted")}</Badge> : null}
        {row.newestEvidence ? (
          <>
            <Badge tone={row.newestEvidence.outcome === "captured" ? "neutral" : "warning"}>
              {row.newestEvidence.outcome}
            </Badge>
            <span className="text-xs text-[var(--muted)]">
              {new Date(row.newestEvidence.observedAt).toLocaleDateString(
                language === "ru" ? "ru-RU" : "en-US",
              )}
            </span>
            <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => onEvidence(row.newestEvidence?.id ?? null)}>
              {t("reviewEvidence")}
            </Button>
          </>
        ) : (
          <Badge tone="neutral">{t("reviewNoEvidence")}</Badge>
        )}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          className="px-3 py-1.5 text-xs"
          disabled={Boolean(row.allowlistEntry) || !row.newestEvidence}
          onClick={() => onDecide("violation")}
        >
          {t("reviewConfirm")}
        </Button>
        <Button variant="ghost" className="px-3 py-1.5 text-xs" disabled={!row.newestEvidence} onClick={() => onDecide("not_a_violation")}>
          {t("reviewDismiss")}
        </Button>
        <Button variant="ghost" className="px-3 py-1.5 text-xs" disabled={!row.newestEvidence} onClick={() => onDecide("page_dead")}>
          {t("reviewPageDead")}
        </Button>
      </div>
    </Card>
  );
}

function Score({ score }: { score: number }) {
  return (
    <div className="w-20">
      <p className="font-display text-3xl tabular-nums">{score.toFixed(2)}</p>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.min(100, Math.max(0, score * 100))}%`,
            background: score >= 0.95 ? "var(--success)" : score >= 0.7 ? "var(--warning)" : "var(--error)",
          }}
        />
      </div>
    </div>
  );
}
