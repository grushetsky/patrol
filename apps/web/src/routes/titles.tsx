import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { setTitlePaused, titlesQuery, type TrackedTitleCard } from "../api/admin";
import { errorMessage, setCsrf } from "../api/client";
import { translate, useLanguage, type MessageKey } from "../i18n";
import { useSession } from "../components/session";
import { Badge, Button, Card, EmptyState, Spinner } from "../components/ui";

export const Route = createFileRoute("/titles")({
  component: TitlesPage,
});

function TitlesPage() {
  const language = useLanguage();
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useSession();
  const titles = useQuery(titlesQuery);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = (key: MessageKey) => translate(language, key);

  async function togglePaused(title: TrackedTitleCard) {
    if (!session) return;
    setBusy(title.id);
    setError(null);
    try {
      setCsrf(session.csrfToken);
      await setTitlePaused(title.id, session.csrfToken, !title.paused);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["titles"] }),
        router.invalidate(),
      ]);
    } catch (cause) {
      setError(errorMessage(cause, t("authErrorGeneric")));
    } finally {
      setBusy(null);
    }
  }

  const needle = filter.trim().toLowerCase();
  const rows = (titles.data?.items ?? []).filter(
    (title) =>
      !needle ||
      title.displayTitle.toLowerCase().includes(needle) ||
      title.titleGroupName.toLowerCase().includes(needle),
  );

  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
          {t("appTitle")} · {t("titles")}
        </p>
        <h1 className="page-title mt-1 text-4xl md:text-5xl">{t("titlesTitle")}</h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">{t("titlesLead")}</p>
        <input
          className="glass-select mt-4 w-full max-w-md px-3 py-2 text-sm"
          placeholder={t("violationsFilter")}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </header>

      {titles.isLoading ? <Card className="p-6"><Spinner label={t("loading")} /></Card> : null}
      {titles.error ? <Card className="p-6 text-sm text-[var(--error)]">{errorMessage(titles.error, t("authErrorGeneric"))}</Card> : null}
      {!titles.isLoading && rows.length === 0 ? (
        <Card><EmptyState title={t("titlesEmpty")}>{t("titlesEmptyLead")}</EmptyState></Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((title) => (
          <Card key={title.id} className={title.paused ? "glass-amber p-5" : "glass-blue p-5"}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-display text-2xl">{title.displayTitle}</h2>
                <p className="text-sm text-[var(--muted)]">
                  {title.releaseYear} · {title.titleType} · {title.titleGroupName}
                </p>
              </div>
              <Badge tone={title.paused ? "warning" : "success"}>
                {title.paused ? t("titlesPaused") : t("titlesActive")}
              </Badge>
            </div>
            <dl className="mt-4 grid grid-cols-3 gap-2 text-xs text-[var(--muted)]">
              <div>
                <dt>{t("reviewVariant")}</dt>
                <dd className="text-[var(--fg)]">{title.variantCount}</dd>
              </div>
              <div>
                <dt>{t("settingsAllowlist")}</dt>
                <dd className="text-[var(--fg)]">{title.allowlistEntryCount}</dd>
              </div>
              <div>
                <dt>{t("violationsTitle")}</dt>
                <dd className="text-[var(--fg)]">{title.openViolationCount}</dd>
              </div>
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                className="px-3 py-1.5 text-xs"
                disabled={busy === title.id}
                onClick={() => void togglePaused(title)}
              >
                {title.paused ? t("titlesResume") : t("titlesPause")}
              </Button>
              {title.externalIdentifiers.map((identifier) => (
                <span key={`${identifier.scheme}-${identifier.value}`} className="rounded-full border border-[var(--glass-border)] px-2 py-1 text-[11px] text-[var(--muted)]">
                  {identifier.scheme} {identifier.value}
                </span>
              ))}
            </div>
          </Card>
        ))}
      </div>

      {error ? <p className="text-sm text-[var(--error)]">{error}</p> : null}
    </div>
  );
}
