import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  allowlistQuery,
  budgetQuery,
  createAllowlistEntry,
  removeAllowlistEntry,
} from "../api/admin";
import { api, errorMessage, setCsrf } from "../api/client";
import { translate, useLanguage, type MessageKey } from "../i18n";
import { useSession } from "../components/session";
import { Badge, Button, Card, CardHeader, EmptyState, Input, Spinner } from "../components/ui";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

const ALLOWLIST_KINDS = ["official_domain", "licensed_destination", "neutral_source"] as const;
const ALLOWLIST_SCOPES = ["rights_holder", "title_group", "tracked_title"] as const;

function SettingsPage() {
  const language = useLanguage();
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useSession();
  const [tab, setTab] = useState<"allowlist" | "budget">("allowlist");
  const t = (key: MessageKey) => translate(language, key);

  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
          {t("appTitle")} · {t("settings")}
        </p>
        <h1 className="page-title mt-1 text-4xl md:text-5xl">{t("settingsTitle")}</h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">{t("settingsLead")}</p>
      </header>

      <div className="flex rounded-[14px] border border-[var(--glass-border)] bg-[var(--glass-bg)] p-1 text-sm backdrop-blur-xl">
        {(["allowlist", "budget"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={
              tab === value
                ? "rounded-[10px] bg-[var(--surface-raised)] px-4 py-2 font-medium"
                : "rounded-[10px] px-4 py-2 text-[var(--muted)] hover:text-[var(--fg)]"
            }
          >
            {t(value === "allowlist" ? "settingsAllowlist" : "settingsBudget")}
          </button>
        ))}
      </div>

      {tab === "allowlist" ? (
        <AllowlistPanel
          csrfToken={session?.csrfToken ?? ""}
          onChanged={() => void Promise.all([
            queryClient.invalidateQueries({ queryKey: ["allowlist"] }),
            router.invalidate(),
          ])}
          t={t}
        />
      ) : (
        <BudgetPanel
          csrfToken={session?.csrfToken ?? ""}
          onChanged={() => void router.invalidate()}
          t={t}
        />
      )}
    </div>
  );
}

function AllowlistPanel({
  csrfToken,
  onChanged,
  t,
}: {
  csrfToken: string;
  onChanged: () => void;
  t: (key: MessageKey) => string;
}) {
  const query = useQuery(allowlistQuery);
  const [kind, setKind] = useState<(typeof ALLOWLIST_KINDS)[number]>("official_domain");
  const [scope, setScope] = useState<(typeof ALLOWLIST_SCOPES)[number]>("rights_holder");
  const [value, setValue] = useState("");
  const [territory, setTerritory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setCsrf(csrfToken);
      await createAllowlistEntry(csrfToken, {
        kind,
        matchKind: kind === "licensed_destination" ? "url_prefix" : "host",
        value: value.trim(),
        scope,
        ...(kind === "licensed_destination" ? { territory: territory as never } : {}),
      } as never);
      setValue("");
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause, t("authErrorGeneric")));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      setCsrf(csrfToken);
      await removeAllowlistEntry(id, csrfToken);
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause, t("authErrorGeneric")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title={t("settingsAllowlist")} />
      <div className="space-y-4 p-5">
        <div className="grid gap-2 md:grid-cols-[160px_160px_1fr_120px_auto]">
          <select className="glass-select px-3 py-2 text-sm" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            {ALLOWLIST_KINDS.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </select>
          <select className="glass-select px-3 py-2 text-sm" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
            {ALLOWLIST_SCOPES.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </select>
          <Input placeholder={t("settingsValue")} value={value} onChange={(event) => setValue(event.target.value)} />
          <Input placeholder={t("settingsTerritory")} value={territory} onChange={(event) => setTerritory(event.target.value)} />
          <Button onClick={() => void add()} disabled={busy || !value.trim()}>{t("settingsAdd")}</Button>
        </div>
        {error ? <p className="text-sm text-[var(--error)]">{error}</p> : null}
        {query.isLoading ? <Spinner label={t("loading")} /> : null}
        {query.data?.items.length === 0 ? <EmptyState title={t("settingsNoAllowlist")} /> : null}
        {query.data && query.data.items.length > 0 ? (
          <div className="divide-y divide-[var(--border)]">
            {query.data.items.map((entry) => (
              <div key={entry.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <Badge tone="neutral">{entry.kind}</Badge>
                <span className="font-mono text-xs">{entry.value}</span>
                <span className="text-xs text-[var(--muted)]">{entry.scope}</span>
                {entry.territory ? <span className="text-xs text-[var(--muted)]">{entry.territory}</span> : null}
                <Button
                  variant="ghost"
                  className="ml-auto px-2 py-1 text-xs"
                  disabled={busy}
                  onClick={() => void remove(entry.id)}
                >
                  {t("settingsRemove")}
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function BudgetPanel({
  csrfToken,
  onChanged,
  t,
}: {
  csrfToken: string;
  onChanged: () => void;
  t: (key: MessageKey) => string;
}) {
  const query = useQuery(budgetQuery);
  const [values, setValues] = useState<Record<string, string>>({});
  const [share, setShare] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const budget = query.data;

  async function save() {
    if (!budget) return;
    setBusy(true);
    setError(null);
    try {
      setCsrf(csrfToken);
      const engineCaps = budget.budget.engineCaps.map((cap) => ({
        engine: cap.engine,
        currency: cap.currency,
        monthlyCapMinor: Number(values[cap.engine] ?? cap.monthlyCapMinor),
      }));
      const result = await api.PUT("/settings/budget", {
        params: { header: { "X-Patrol-CSRF": csrfToken } },
        body: {
          engineCaps,
          recheckSharePercent: Number(share || budget.budget.recheckSharePercent),
        },
      });
      if (result.error) throw new Error(errorMessage(result.error, t("authErrorGeneric")));
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause, t("authErrorGeneric")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title={t("settingsBudget")} />
      <div className="space-y-4 p-5">
        {query.isLoading ? <Spinner label={t("loading")} /> : null}
        {budget ? (
          <>
            {budget.budget.engineCaps.map((cap) => (
              <label key={cap.engine} className="flex items-center gap-3 text-sm">
                <span className="w-24 capitalize">{cap.engine}</span>
                <Input
                  type="number"
                  value={values[cap.engine] ?? String(cap.monthlyCapMinor)}
                  onChange={(event) => setValues((current) => ({ ...current, [cap.engine]: event.target.value }))}
                />
                <span className="text-xs text-[var(--muted)]">{cap.currency} minor</span>
              </label>
            ))}
            <label className="flex items-center gap-3 text-sm">
              <span className="w-24">{t("settingsRecheckShare")}</span>
              <Input
                type="number"
                value={share || String(budget.budget.recheckSharePercent)}
                onChange={(event) => setShare(event.target.value)}
              />
              <span className="text-xs text-[var(--muted)]">%</span>
            </label>
            <Button onClick={() => void save()} disabled={busy}>
              {busy ? t("loading") : t("settingsSaveBudget")}
            </Button>
            {error ? <p className="text-sm text-[var(--error)]">{error}</p> : null}
            <div className="grid gap-2 text-xs text-[var(--muted)] sm:grid-cols-3">
              {budget.ledger.map((row) => (
                <div key={row.engine} className="glass-inset p-3">
                  <p className="font-medium capitalize text-[var(--fg)]">{row.engine}</p>
                  <p>{row.allowanceUnits} units</p>
                  <p>{row.scanCommitted + row.recheckCommitted} committed</p>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </Card>
  );
}
