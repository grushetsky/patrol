import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createNotice,
  recipientProfilesQuery,
  violationsQuery,
  type ViolationRow,
} from "../api/screens";
import { errorMessage, setCsrf } from "../api/client";
import { translate, useLanguage, type MessageKey } from "../i18n";
import { useSession } from "../components/session";
import { EvidenceDialog } from "../components/evidence-dialog";
import { Badge, Button, Card, EmptyState, Spinner } from "../components/ui";

export const Route = createFileRoute("/violations")({
  component: ViolationsPage,
});

function ViolationsPage() {
  const language = useLanguage();
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useSession();
  const violations = useQuery(violationsQuery);
  const profiles = useQuery(recipientProfilesQuery);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [profileId, setProfileId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const t = (key: MessageKey, values?: Record<string, string | number>) =>
    translate(language, key, values);

  useEffect(() => {
    if (!profileId && profiles.data?.items[0]) {
      setProfileId(profiles.data.items[0].id);
    }
  }, [profileId, profiles.data]);

  const rows = violations.data?.items ?? [];
  const groups = useMemo(() => {
    const map = new Map<string, ViolationRow[]>();
    for (const row of rows) {
      const list = map.get(row.displayTitle) ?? [];
      list.push(row);
      map.set(row.displayTitle, list);
    }
    return [...map.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [rows]);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function draftNotice() {
    const profile = profiles.data?.items.find((item) => item.id === profileId);
    if (!profile || selected.size === 0 || !session) return;
    setBusy(true);
    setError(null);
    try {
      setCsrf(session.csrfToken);
      await createNotice(session.csrfToken, {
        recipient: profile.recipient,
        recipientProfileId: profile.id,
        violationIds: [...selected],
      });
      setSelected(new Set());
      setNotice(t("violationsQueued"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["violations"] }),
        router.invalidate(),
      ]);
    } catch (cause) {
      setError(errorMessage(cause, t("authErrorGeneric")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5 pb-28">
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
          {t("appTitle")} · {t("violations")}
        </p>
        <h1 className="page-title mt-1 text-4xl md:text-5xl">{t("violationsTitle")}</h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">{t("violationsLead")}</p>
      </header>

      {violations.isLoading ? (
        <Card className="p-6"><Spinner label={t("loading")} /></Card>
      ) : null}
      {violations.error ? (
        <Card className="p-6 text-sm text-[var(--error)]">
          {errorMessage(violations.error, t("authErrorGeneric"))}
        </Card>
      ) : null}
      {!violations.isLoading && rows.length === 0 ? (
        <Card><EmptyState title={t("violationsEmpty")}>{t("violationsEmptyLead")}</EmptyState></Card>
      ) : null}

      <div className="space-y-4">
        {groups.map(([title, groupRows]) => (
          <Card key={title} className="overflow-hidden">
            <header className="flex items-center justify-between gap-3 border-b border-[var(--glass-border)] px-5 py-3">
              <div>
                <h2 className="font-display text-2xl">{title}</h2>
                <p className="text-xs text-[var(--muted)]">
                  {groupRows[0]?.releaseYear} · {groupRows[0]?.titleType}
                </p>
              </div>
              <Badge tone="accent">{groupRows.length}</Badge>
            </header>
            <div className="divide-y divide-[var(--border)]">
              {groupRows.map((row) => {
                const reserved = Boolean(row.notice);
                const checked = selected.has(row.violation.id);
                return (
                  <label
                    key={row.violation.id}
                    className="flex cursor-pointer items-start gap-3 px-5 py-4 hover:bg-[rgba(255,255,255,0.03)]"
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 accent-[var(--accent)]"
                      checked={checked}
                      disabled={reserved}
                      onChange={() => toggle(row.violation.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{row.violation.host}</span>
                        {reserved ? <Badge tone="success">{t("violationsInNotice")}</Badge> : null}
                        {row.newestEvidence ? (
                          <Badge tone={row.newestEvidence.outcome === "captured" ? "neutral" : "warning"}>
                            {row.newestEvidence.outcome}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-1 break-all text-sm text-[var(--accent)]">{row.violation.url}</p>
                      <p className="mt-1 text-xs text-[var(--muted)]">
                        {new Date(row.violation.detectedAt).toLocaleDateString()}
                      </p>
                    </div>
                    {row.newestEvidence ? (
                      <Button
                        variant="ghost"
                        className="px-2 py-1 text-xs"
                        onClick={(event) => {
                          event.preventDefault();
                          setEvidenceId(row.newestEvidence?.id ?? null);
                        }}
                      >
                        {t("reviewEvidence")}
                      </Button>
                    ) : null}
                  </label>
                );
              })}
            </div>
          </Card>
        ))}
      </div>

      {selected.size > 0 ? (
        <div className="fixed inset-x-0 bottom-4 z-40 mx-auto w-[min(900px,calc(100%-32px))]">
          <div className="glass flex flex-wrap items-center gap-3 px-4 py-3">
            <Badge tone="accent">{t("violationsCart", { n: selected.size })}</Badge>
            <select
              className="glass-select min-w-48 flex-1 px-3 py-2 text-sm"
              value={profileId}
              onChange={(event) => setProfileId(event.target.value)}
            >
              <option value="">{t("violationsSelectProfile")}</option>
              {profiles.data?.items.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.recipient} · {profile.account || profile.contactEmail || profile.id.slice(0, 8)}
                </option>
              ))}
            </select>
            <Button variant="ghost" onClick={() => setSelected(new Set())}>
              {t("violationsClear")}
            </Button>
            <Button
              onClick={() => void draftNotice()}
              disabled={busy || !profileId}
            >
              {busy ? t("loading") : t("violationsDraft")}
            </Button>
          </div>
          {error ? <p className="mt-2 text-sm text-[var(--error)]">{error}</p> : null}
        </div>
      ) : null}

      {notice ? (
        <div className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg)] px-4 py-2 text-sm shadow-[var(--glass-shadow)] backdrop-blur-xl">
          {notice}
        </div>
      ) : null}

      {evidenceId ? (
        <EvidenceDialog evidenceId={evidenceId} onClose={() => setEvidenceId(null)} />
      ) : null}
    </div>
  );
}
