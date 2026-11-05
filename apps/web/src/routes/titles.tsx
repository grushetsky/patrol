import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createTitle,
  setTitlePaused,
  titleGroupsQuery,
  titlesQuery,
  type TrackedTitleCard,
} from "../api/admin";
import { errorMessage, setCsrf } from "../api/client";
import { translate, useLanguage, type MessageKey } from "../i18n";
import { useSession } from "../components/session";
import { Badge, Button, Card, EmptyState, Input, Spinner } from "../components/ui";

export const Route = createFileRoute("/titles")({
  component: TitlesPage,
});

function TitlesPage() {
  const language = useLanguage();
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useSession();
  const titles = useQuery(titlesQuery);
  const groups = useQuery(titleGroupsQuery);
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    titleGroupId: "",
    text: "",
    releaseYear: String(new Date().getUTCFullYear()),
    titleType: "film",
    language: "en",
    script: "Latn",
    kinopoisk: "",
    imdb: "",
    wikidata: "",
  });
  const [saved, setSaved] = useState<string | null>(null);
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

  async function addTitle() {
    if (!session || !form.titleGroupId || !form.text.trim()) return;
    setBusy("create");
    setError(null);
    try {
      setCsrf(session.csrfToken);
      await createTitle(session.csrfToken, {
        titleGroupId: form.titleGroupId,
        originalVariant: {
          text: form.text.trim(),
          language: form.language as never,
          script: form.script as never,
        },
        releaseYear: Number(form.releaseYear),
        titleType: form.titleType as never,
        additionalVariants: [],
        externalIdentifiers: [
          ...(form.kinopoisk.trim()
            ? [{ scheme: "kinopoisk" as const, value: form.kinopoisk.trim() }]
            : []),
          ...(form.imdb.trim()
            ? [{ scheme: "imdb" as const, value: form.imdb.trim() }]
            : []),
          ...(form.wikidata.trim()
            ? [{ scheme: "wikidata" as const, value: form.wikidata.trim() }]
            : []),
        ],
        source: "operator_knowledge",
      });
      setAdding(false);
      setSaved(t("titlesCreated"));
      setForm((current) => ({ ...current, text: "", kinopoisk: "", imdb: "", wikidata: "" }));
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
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            className="glass-select w-full max-w-md px-3 py-2 text-sm"
            placeholder={t("violationsFilter")}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <Button onClick={() => setAdding(true)}>{t("titlesAdd")}</Button>
        </div>
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
      {saved ? (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg)] px-4 py-2 text-sm shadow-[var(--glass-shadow)] backdrop-blur-xl">
          {saved}
        </div>
      ) : null}

      {adding ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={t("titlesAdd")}>
          <Card className="max-h-[90vh] w-full max-w-2xl overflow-auto p-6">
            <h2 className="auth-title text-2xl">{t("titlesAdd")}</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">{t("titlesAddLead")}</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs sm:col-span-2">
                <span>{t("titlesGroup")}</span>
                <select
                  className="glass-select w-full px-3 py-2 text-sm"
                  value={form.titleGroupId}
                  onChange={(event) => setForm({ ...form, titleGroupId: event.target.value })}
                >
                  <option value="">—</option>
                  {groups.data?.items.map((group) => (
                    <option key={group.id} value={group.id}>{group.name}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-xs sm:col-span-2">
                <span>{t("titlesOriginal")}</span>
                <Input value={form.text} onChange={(event) => setForm({ ...form, text: event.target.value })} />
              </label>
              <label className="space-y-1 text-xs">
                <span>{t("titlesYear")}</span>
                <Input type="number" value={form.releaseYear} onChange={(event) => setForm({ ...form, releaseYear: event.target.value })} />
              </label>
              <label className="space-y-1 text-xs">
                <span>{t("titlesType")}</span>
                <select className="glass-select w-full px-3 py-2 text-sm" value={form.titleType} onChange={(event) => setForm({ ...form, titleType: event.target.value })}>
                  <option value="film">film</option>
                  <option value="series">series</option>
                </select>
              </label>
              <label className="space-y-1 text-xs">
                <span>{t("titlesLanguage")}</span>
                <select className="glass-select w-full px-3 py-2 text-sm" value={form.language} onChange={(event) => setForm({ ...form, language: event.target.value })}>
                  <option value="en">en</option>
                  <option value="ru">ru</option>
                </select>
              </label>
              <label className="space-y-1 text-xs">
                <span>{t("titlesScript")}</span>
                <select className="glass-select w-full px-3 py-2 text-sm" value={form.script} onChange={(event) => setForm({ ...form, script: event.target.value })}>
                  <option value="Latn">Latn</option>
                  <option value="Cyrl">Cyrl</option>
                </select>
              </label>
              <label className="space-y-1 text-xs">
                <span>{t("titlesKinopoisk")}</span>
                <Input value={form.kinopoisk} onChange={(event) => setForm({ ...form, kinopoisk: event.target.value })} />
              </label>
              <label className="space-y-1 text-xs">
                <span>{t("titlesImdb")}</span>
                <Input value={form.imdb} onChange={(event) => setForm({ ...form, imdb: event.target.value })} />
              </label>
              <label className="space-y-1 text-xs">
                <span>{t("titlesWikidata")}</span>
                <Input value={form.wikidata} onChange={(event) => setForm({ ...form, wikidata: event.target.value })} />
              </label>
            </div>
            {error ? <p className="mt-3 text-sm text-[var(--error)]">{error}</p> : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAdding(false)}>{t("titlesCancel")}</Button>
              <Button onClick={() => void addTitle()} disabled={busy === "create" || !form.titleGroupId || !form.text.trim()}>
                {busy === "create" ? t("loading") : t("titlesCreate")}
              </Button>
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
